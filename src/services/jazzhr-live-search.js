import crypto from 'node:crypto'

const BASE = 'https://api.resumatorapi.com/v1'
const DEFAULT_PAGE_SIZE = 20
const DEFAULT_CONCURRENCY = 2
const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_PAGES = 10

export function createJazzhrLiveSearchManager({
  apiKey,
  logger = console,
  pageSize = DEFAULT_PAGE_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  maxPages = DEFAULT_MAX_PAGES,
  ttlMs = DEFAULT_TTL_MS,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  sleepFn = sleep,
} = {}) {
  const sessions = new Map()
  const limiter = createLimiter(positiveInteger(concurrency, DEFAULT_CONCURRENCY))
  const resolvedPageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE)
  const resolvedMaxPages = positiveInteger(maxPages, DEFAULT_MAX_PAGES)
  const resolvedTtlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS)

  function start({ query, userId = '' } = {}) {
    expire()
    const id = crypto.randomUUID()
    const normalizedQuery = normalizeSearchText(query)
    const session = {
      id,
      query: String(query || '').trim(),
      normalizedQuery,
      userId,
      version: 1,
      pageSize: resolvedPageSize,
      currentPage: 0,
      jazzhrPageScanned: 0,
      results: [],
      resultIds: new Set(),
      complete: false,
      error: '',
      searching: false,
      createdAt: now(),
      updatedAt: now(),
      inFlight: null,
    }
    if (!apiKey) {
      session.complete = true
      session.error = 'JazzHR API key is not configured.'
    }
    if (!normalizedQuery) {
      session.complete = true
      session.error = 'Enter a candidate name to search.'
    }
    sessions.set(id, session)
    return snapshot(session)
  }

  function get(sessionId) {
    expire()
    const session = sessions.get(sessionId)
    return session ? snapshot(session) : null
  }

  function isCurrent(sessionId, version) {
    const session = sessions.get(sessionId)
    return Boolean(session && session.version === version)
  }

  function getCandidate(sessionId, selectedId) {
    const session = sessions.get(sessionId)
    if (!session) return null
    const id = normalizeCandidateId(selectedId)
    return session.results.find((candidate) => normalizeCandidateId(candidate.id) === id) || null
  }

  function getPageCandidates(sessionId, pageIndex = 0, filter = '') {
    const session = sessions.get(sessionId)
    if (!session) return []
    const page = clampPage(pageIndex)
    const start = page * session.pageSize
    const candidates = session.results.slice(start, start + session.pageSize)
    const normalizedFilter = normalizeSearchText(filter)
    if (!normalizedFilter) return candidates
    return candidates.filter((candidate) => candidateSearchText(candidate).includes(normalizedFilter))
  }

  async function ensurePage(sessionId, pageIndex = 0) {
    expire()
    const session = sessions.get(sessionId)
    if (!session) return null
    const requestedPage = clampPage(pageIndex)
    session.currentPage = requestedPage
    session.version++
    session.updatedAt = now()

    if (session.inFlight) await session.inFlight
    if (session.complete || session.error || hasResultPage(session, requestedPage)) return snapshot(session)

    session.searching = true
    const targetCount = (requestedPage + 1) * session.pageSize
    session.inFlight = scanUntil(session, targetCount)
      .catch((error) => {
        session.error = error.message
        logger.warn?.('jazzhr_live_search_failed', {
          sessionId: session.id,
          query: session.query,
          error: error.message,
        })
      })
      .finally(() => {
        session.searching = false
        session.inFlight = null
        session.updatedAt = now()
      })

    await session.inFlight
    return snapshot(session)
  }

  async function scanUntil(session, targetCount) {
    if (session.complete || session.error || session.results.length >= targetCount) return

    while (
      !session.complete &&
      !session.error &&
      session.results.length < targetCount &&
      session.jazzhrPageScanned < resolvedMaxPages
    ) {
      session.jazzhrPageScanned++
      const result = await limiter.run(() => fetchApplicantListPage({
        apiKey,
        page: session.jazzhrPageScanned,
        query: session.query,
        fetchFn,
        logger,
        sleepFn,
      }))
      addMatches(session, result)
      logger.info?.('jazzhr_live_search_page_scanned', {
        sessionId: session.id,
        query: session.query,
        page: result.page,
        count: result.items.length,
        matches: session.results.length,
      })
      if (result.items.length < 100) {
        session.complete = true
        break
      }
    }

    if (session.jazzhrPageScanned >= resolvedMaxPages && !session.complete) {
      session.complete = true
    }
  }

  function expire() {
    const cutoff = now() - resolvedTtlMs
    for (const [id, session] of sessions.entries()) {
      if (session.updatedAt < cutoff) sessions.delete(id)
    }
  }

  return {
    start,
    get,
    getCandidate,
    getPageCandidates,
    ensurePage,
    isCurrent,
    expire,
    get activeRequests() {
      return limiter.active
    },
    get maxObservedActiveRequests() {
      return limiter.maxObserved
    },
  }
}

export async function fetchApplicantListPage({
  apiKey,
  page = 1,
  query = '',
  fetchFn = globalThis.fetch,
  logger = console,
  sleepFn = sleep,
  maxRetries = 4,
} = {}) {
  const pathname = applicantListPath(page)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const url = new URL(`${BASE}${pathname}`)
    url.searchParams.set('apikey', apiKey)
    if (query) url.searchParams.set('name', query)
    const response = await fetchFn(String(url))

    if (response.ok) {
      const data = await response.json()
      return { page, items: extractApplicantArray(data) }
    }

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < maxRetries - 1) {
      const delay = 1000 * 2 ** attempt
      logger.warn?.('jazzhr_live_search_retry', {
        page,
        status: response.status,
        attempt,
        retryAfterMs: delay,
      })
      await sleepFn(delay)
      continue
    }

    const body = await response.text().catch(() => '')
    throw new Error(`JazzHR API ${pathname} returned ${response.status}: ${body.slice(0, 200)}`)
  }

  return { page, items: [] }
}

function addMatches(session, pageResult) {
  pageResult.items.forEach((item, index) => {
    const candidate = mapLiveApplicant(item, index)
    if (!candidate) return
    if (!normalizeSearchText(candidate.fullName).includes(session.normalizedQuery)) return
    const dedupeId = normalizeCandidateId(candidate.id)
    if (session.resultIds.has(dedupeId)) return
    session.resultIds.add(dedupeId)
    session.results.push(candidate)
  })
}

function mapLiveApplicant(item, sourceOrder = 0) {
  const jazzhrApplicationId = String(item?.id || item?.applicant_id || '').trim()
  if (!jazzhrApplicationId) return null
  const firstName = firstValue(item, ['first_name', 'firstName', 'first'])
  const lastName = firstValue(item, ['last_name', 'lastName', 'last'])
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() ||
    firstValue(item, ['name', 'full_name', 'fullName'])
  if (!fullName) return null

  return {
    id: `applicant-${jazzhrApplicationId}`,
    jazzhrApplicationId,
    fullName,
    firstName,
    lastName,
    email: firstValue(item, ['email', 'email_address', 'emailAddress']),
    phone: firstValue(item, ['phone', 'prospect_phone', 'cell_phone']),
    jobTitle: firstValue(item, ['job_title', 'jobTitle', 'job']),
    stage: firstValue(item, ['applicant_progress', 'applicantProgress', 'stage', 'status']),
    recruiterId: normalizeRecruiterId(item?.recruiter_id),
    source: 'jazzhr',
    appliedAt: firstValue(item, [
      'applied_date',
      'apply_date',
      'applyDate',
      'date_applied',
      'dateApplied',
      'created_at',
      'createdAt',
      'created',
      'updated_at',
      'updatedAt',
      'date',
    ]),
    sourceOrder,
  }
}

function snapshot(session) {
  return {
    id: session.id,
    query: session.query,
    userId: session.userId,
    version: session.version,
    pageSize: session.pageSize,
    currentPage: session.currentPage,
    resultCount: session.results.length,
    complete: session.complete,
    error: session.error,
    searching: session.searching,
    results: session.results.slice(),
  }
}

function hasResultPage(session, pageIndex) {
  return session.results.length >= (pageIndex + 1) * session.pageSize
}

function createLimiter(limit) {
  const queue = []
  const limiter = {
    limit,
    active: 0,
    maxObserved: 0,
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject })
        drain()
      })
    },
  }

  function drain() {
    while (limiter.active < limiter.limit && queue.length > 0) {
      const item = queue.shift()
      limiter.active++
      limiter.maxObserved = Math.max(limiter.maxObserved, limiter.active)
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          limiter.active--
          drain()
        })
    }
  }

  return limiter
}

function extractApplicantArray(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data.applicants)) return data.applicants
  if (Array.isArray(data.data)) return data.data
  return Object.values(data).filter((value) => value && typeof value === 'object')
}

function applicantListPath(page) {
  return page <= 1 ? '/applicants' : `/applicants/page/${page}`
}

function candidateSearchText(candidate) {
  return normalizeSearchText([
    candidate.fullName,
    candidate.firstName,
    candidate.lastName,
    candidate.email,
    candidate.jobTitle,
    candidate.jazzhrApplicationId,
  ].filter(Boolean).join(' '))
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeCandidateId(value) {
  return String(value || '').replace(/^applicant-/, '').trim()
}

function clampPage(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function normalizeRecruiterId(value) {
  const id = String(value || '').trim()
  if (!id) return ''
  return id.startsWith('rec-') ? id : `rec-${id}`
}

function firstValue(item, keys) {
  for (const key of keys) {
    const value = String(item?.[key] || '').trim()
    if (value) return value
  }
  return ''
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

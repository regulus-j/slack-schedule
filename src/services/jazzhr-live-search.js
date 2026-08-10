import crypto from 'node:crypto'

import { applicantEligibilityReason } from './jazzhr.js'

const BASE = 'https://api.resumatorapi.com/v1'
const DEFAULT_PAGE_SIZE = 20
const DEFAULT_CONCURRENCY = 2
const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_PAGES = 10

export function createJazzhrLiveSearchManager({
  apiKey,
  accountKey = '',
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

  function start({ query, userId = '', filters = {}, initialCandidates = [] } = {}) {
    expire()
    const id = crypto.randomUUID()
    const normalizedQuery = normalizeSearchText(query)
    const session = {
      id,
      query: String(query || '').trim(),
      normalizedQuery,
      userId,
      accountKey,
      version: 1,
      pageSize: resolvedPageSize,
      currentPage: 0,
      jazzhrPageScanned: 0,
      results: [],
      resultIds: new Set(),
      filters: normalizeFilters(filters),
      roleFilterFallbackUsed: false,
      excludedReasons: {},
      complete: false,
      error: '',
      searching: false,
      createdAt: now(),
      updatedAt: now(),
      inFlight: null,
    }
    addInitialCandidates(session, initialCandidates)
    if (!apiKey) {
      session.complete = true
      if (session.results.length === 0) session.error = 'JazzHR API key is not configured.'
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
    if (
      session.complete ||
      session.error ||
      (hasResultPage(session, requestedPage) && session.jazzhrPageScanned > 0)
    ) return snapshot(session)

    session.searching = true
    const targetCount = (requestedPage + 1) * session.pageSize
    session.inFlight = scanUntil(session, targetCount)
      .catch((error) => {
        session.error = error.message
        logger.warn?.('jazzhr_live_search_failed', {
          sessionId: session.id,
          query: session.query,
          roleId: session.filters.roleId,
          excludedReasons: session.excludedReasons,
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
    if (
      session.complete ||
      session.error ||
      (session.results.length >= targetCount && session.jazzhrPageScanned > 0)
    ) return

    while (
      !session.complete &&
      !session.error &&
      (session.results.length < targetCount || session.jazzhrPageScanned === 0) &&
      session.jazzhrPageScanned < resolvedMaxPages
    ) {
      session.jazzhrPageScanned++
      const matchesBeforePage = session.results.length
      const result = await limiter.run(() => fetchApplicantListPage({
        apiKey,
        page: session.jazzhrPageScanned,
        query: session.query,
        roleId: session.filters.roleId,
        fetchFn,
        logger,
        sleepFn,
      }))
      addMatches(session, result)
      let fallbackResult = null
      if (
        session.filters.roleId &&
        session.results.length === matchesBeforePage &&
        session.jazzhrPageScanned === 1 &&
        !session.roleFilterFallbackUsed
      ) {
        session.roleFilterFallbackUsed = true
        fallbackResult = await limiter.run(() => fetchApplicantListPage({
          apiKey,
          page: 1,
          query: session.query,
          fetchFn,
          logger,
          sleepFn,
        }))
        addMatches(session, fallbackResult)
      }
      logger.info?.('jazzhr_live_search_page_scanned', {
        sessionId: session.id,
        query: session.query,
        roleId: session.filters.roleId,
        page: result.page,
        count: result.items.length,
        matches: session.results.length,
        roleFilterApplied: Boolean(session.filters.roleId),
        roleFilterFallbackUsed: session.roleFilterFallbackUsed,
        fallbackCount: fallbackResult?.items.length || 0,
        excludedReasons: session.excludedReasons,
      })
      if (result.complete || result.items.length < 100) {
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
  roleId = '',
  fetchFn = globalThis.fetch,
  logger = console,
  sleepFn = sleep,
  maxRetries = 6,
} = {}) {
  const pathname = applicantSearchPath({ page, query, roleId })
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const url = new URL(`${BASE}${pathname}`)
    url.searchParams.set('apikey', apiKey)
    const response = await fetchFn(String(url))

    if (response.ok) {
      const data = await response.json()
      return { page, items: extractApplicantArray(data), complete: Boolean(query) }
    }

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < maxRetries - 1) {
      const delay = retryDelayMs(response, attempt)
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
    for (const record of applicantRoleRecords(item)) {
      const eligibilityReason = applicantEligibilityReason(record, { allowUnknown: true })
      if (eligibilityReason) {
        session.excludedReasons[eligibilityReason] = (session.excludedReasons[eligibilityReason] || 0) + 1
        continue
      }
      const candidate = mapLiveApplicant(record, index)
      addCandidate(session, candidate)
    }
  })
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers?.get?.('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)

    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now())
  }
  return Math.min(1000 * 2 ** attempt, 30000)
}

function addInitialCandidates(session, candidates) {
  for (const record of Array.isArray(candidates) ? candidates : []) {
    const candidate = mapLiveApplicant(record, record?.sourceOrder || 0)
    addCandidate(session, candidate)
  }
}

function addCandidate(session, candidate) {
  if (!candidate) return
  if (!candidateMatchesFilters(candidate, session.filters)) return
  if (!normalizeSearchText(candidate.fullName).includes(session.normalizedQuery)) return
  const dedupeId = normalizeCandidateId(candidate.id)
  if (!dedupeId || session.resultIds.has(dedupeId)) return
  session.resultIds.add(dedupeId)
  session.results.push(candidate)
}

function mapLiveApplicant(item, sourceOrder = 0) {
  const jazzhrApplicationId = firstValue(item, [
    'jazzhrApplicationId',
    'id',
    'applicant_id',
    'applicantId',
    'appjob_id',
    'appjobId',
    'application_id',
    'applicationId',
  ])
  if (!jazzhrApplicationId) return null
  const firstName = firstValue(item, ['first_name', 'firstName', 'first'])
  const lastName = firstValue(item, ['last_name', 'lastName', 'last'])
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() ||
    firstValue(item, ['name', 'full_name', 'fullName'])
  if (!fullName) return null

  const jazzhrJobId = firstValue(item, ['jazzhrJobId', 'job_id', 'jobId'])
  const candidateKey = String(item?.candidateKey || '').replace(/^applicant-/, '').trim() ||
    [jazzhrApplicationId, jazzhrJobId].filter(Boolean).join('::')
  return {
    id: `applicant-${candidateKey}`,
    candidateKey,
    jazzhrApplicationId,
    jazzhrJobId,
    fullName,
    firstName,
    lastName,
    email: firstValue(item, ['email', 'email_address', 'emailAddress']),
    phone: firstValue(item, ['phone', 'prospect_phone', 'cell_phone']),
    jobTitle: firstValue(item, ['jobTitle', 'job_title', 'job']),
    stage: firstValue(item, ['applicant_progress', 'applicantProgress', 'stage', 'status']),
    recruiterId: normalizeRecruiterId(item?.recruiter_id),
    recruiterEmail: firstValue(item, ['recruiter_email', 'recruiterEmail']),
    recruiterName: firstValue(item, ['recruiter_name', 'recruiterName']),
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
    accountKey: session.accountKey,
    version: session.version,
    pageSize: session.pageSize,
    currentPage: session.currentPage,
    resultCount: session.results.length,
    complete: session.complete,
    error: session.error,
    searching: session.searching,
    results: session.results.slice(),
    filters: session.filters,
  }
}

function applicantRoleRecords(item) {
  const rawJobs = item?.jobs || item?.job_applications || item?.applications || item?.job
  const jobs = Array.isArray(rawJobs)
    ? rawJobs.filter(Boolean)
    : rawJobs && typeof rawJobs === 'object'
      ? [rawJobs]
      : []
  if (jobs.length === 0) return [item]
  return jobs.map((job) => ({
    ...item,
    jobs: job,
    status: firstValue(job, ['status', 'job_status', 'jobStatus']),
    applicant_status: firstValue(job, ['applicant_status', 'applicantStatus']),
    job_id: job.job_id || job.jobId || job.id || '',
    job_title: job.job_title || job.jobTitle || job.title || item.job_title || item.jobTitle || '',
    applicant_progress: job.applicant_progress || job.applicantProgress || item.applicant_progress || item.applicantProgress || '',
    workflow_step_id: job.workflow_step_id || job.workflowStepId || item.workflow_step_id || item.workflowStepId || '',
    workflow_step: job.workflow_step || job.workflowStep || item.workflow_step || item.workflowStep || '',
    workflow_category: job.workflow_category || job.workflowCategory ||
      job.workflow_step_category || job.category ||
      '',
    recruiter_id: job.recruiter_id || item.recruiter_id || '',
    recruiter_email: job.recruiter_email || job.recruiterEmail || item.recruiter_email || '',
    recruiter_name: job.recruiter_name || job.recruiterName || item.recruiter_name || '',
    apply_date: job.apply_date || job.applyDate || item.apply_date || item.applyDate,
    date_applied: job.date_applied || job.dateApplied || item.date_applied || item.dateApplied,
    disposition: job.disposition || job.disposition_name || '',
    disposition_status: job.disposition_status || job.dispositionStatus || '',
  }))
}

function normalizeFilters(filters = {}) {
  return {
    roleId: String(filters.roleId || '').trim(),
    roleTitle: normalizeSearchText(filters.roleTitle),
    recruiterIds: (filters.recruiterIds || []).map(normalizeRecruiterId).filter(Boolean),
    recruiterEmails: (filters.recruiterEmails || []).map(normalizeSearchText).filter(Boolean),
    recruiterNames: (filters.recruiterNames || []).map(normalizeSearchText).filter(Boolean),
  }
}

function candidateMatchesFilters(candidate, filters = {}) {
  if (filters.roleId && String(candidate.jazzhrJobId || '').trim() !== filters.roleId) return false
  if (!filters.roleId && filters.roleTitle && normalizeSearchText(candidate.jobTitle) !== filters.roleTitle) return false
  if (filters.recruiterIds?.length > 0) {
    const recruiterId = normalizeRecruiterId(candidate.recruiterId)
    const recruiterEmail = normalizeSearchText(candidate.recruiterEmail)
    const recruiterName = normalizeSearchText(candidate.recruiterName)
    const hasRecruiter = Boolean(recruiterId || recruiterEmail || recruiterName)
    if (
      hasRecruiter &&
      !filters.recruiterIds.includes(recruiterId) &&
      !filters.recruiterEmails.includes(recruiterEmail) &&
      !filters.recruiterNames.includes(recruiterName)
    ) return false
  }
  return true
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
  for (const key of ['applicants', 'data', 'results', 'items', 'job_applicants', 'applications']) {
    if (Array.isArray(data[key])) return data[key]
    if (data[key] && typeof data[key] === 'object') {
      const nested = extractApplicantArray(data[key])
      if (nested.length > 0) return nested
    }
  }
  if (
    data.id ||
    data.applicant_id ||
    data.applicantId ||
    data.appjob_id ||
    data.appjobId ||
    data.application_id ||
    data.applicationId ||
    data.first_name ||
    data.firstName ||
    data.full_name ||
    data.fullName
  ) {
    return [data]
  }
  for (const value of Object.values(data)) {
    const nested = extractApplicantArray(value)
    if (nested.length > 0) return nested
  }
  return []
}

function applicantListPath(page) {
  return page <= 1 ? '/applicants' : `/applicants/page/${page}`
}

function applicantSearchPath({ page, query, roleId }) {
  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) return applicantListPath(page)
  const name = encodeURIComponent(normalizedQuery)
  const job = String(roleId || '').trim()
  return job
    ? `/applicants/name/${name}/job_id/${encodeURIComponent(job)}`
    : `/applicants/name/${name}`
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
    const rawValue = item?.[key]
    if (rawValue && typeof rawValue === 'object') continue
    const value = String(rawValue || '').trim()
    if (value) return value
  }
  return ''
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

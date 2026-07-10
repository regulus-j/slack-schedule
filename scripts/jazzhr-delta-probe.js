import { fetchWithTimeout } from '../src/services/http-client.js'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'https://api.resumatorapi.com/v1'
const DEFAULT_LOOKBACK_DAYS = 7
const DEFAULT_FULL_SCAN_PAGES = 3
const DEFAULT_JOB_SAMPLE_LIMIT = 3
const DEFAULT_TIMEOUT_MS = 15000
const PAGE_SIZE = 100

export function buildProbeConfig(env = process.env) {
  const today = parseDate(env.JAZZHR_PROBE_TO_DATE) || new Date()
  const lookbackDays = positiveInteger(env.JAZZHR_PROBE_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS)
  const fromDate = parseDate(env.JAZZHR_PROBE_FROM_DATE) ||
    new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000)

  return {
    apiKey: env.JAZZHR_API_KEY || '',
    baseUrl: String(env.JAZZHR_PROBE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    fromDate: ymd(fromDate),
    toDate: ymd(today),
    fullScanPages: positiveInteger(env.JAZZHR_PROBE_FULL_SCAN_PAGES, DEFAULT_FULL_SCAN_PAGES),
    jobSampleLimit: positiveInteger(env.JAZZHR_PROBE_JOB_SAMPLE_LIMIT, DEFAULT_JOB_SAMPLE_LIMIT),
    timeoutMs: positiveInteger(env.JAZZHR_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  }
}

export async function runJazzhrDeltaProbe({
  config,
  fetchImpl = fetch,
} = {}) {
  if (!config?.apiKey) throw new Error('JAZZHR_API_KEY is not set')

  const client = createJazzhrProbeClient({ config, fetchImpl })
  const activities = await probeActivities({ client, config })
  const applicantDateFilters = await probeApplicantDateFilters({ client, config })
  const openJobSync = await probeOpenJobSync({ client, config })
  const fullScanBaseline = await probeFullScanBaseline({ client, config })

  return interpretProbeResults({
    lookback: {
      fromDate: config.fromDate,
      toDate: config.toDate,
    },
    activities,
    applicantDateFilters,
    openJobSync,
    fullScanBaseline,
  })
}

export function createJazzhrProbeClient({ config, fetchImpl = fetch }) {
  return async function get(path) {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${config.baseUrl}${path}${sep}apikey=${encodeURIComponent(config.apiKey)}`
    const started = Date.now()
    const response = await fetchWithTimeout(url, {}, {
      timeoutMs: config.timeoutMs,
      fetchImpl,
      retries: 1,
    })
    const text = await response.text()
    const body = parseBody(text)

    return {
      path,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - started,
      body,
      textLength: text.length,
    }
  }
}

export async function probeActivities({ client, config }) {
  const response = await client(`/activities?from_date=${config.fromDate}&to_date=${config.toDate}`)
  return summarizeResponse(response, { kind: 'activities' })
}

export async function probeApplicantDateFilters({ client, config }) {
  const response = await client(`/applicants?from_apply_date=${config.fromDate}&to_apply_date=${config.toDate}`)
  return summarizeResponse(response, { kind: 'applicant_date_filters' })
}

export async function probeOpenJobSync({ client, config }) {
  const jobsResponse = await client('/jobs')
  const jobsSummary = summarizeResponse(jobsResponse, { kind: 'jobs' })
  const jobs = extractItems(jobsResponse.body)
  const openJobs = jobs.filter(isOpenJob)
  const sampledJobs = []

  for (const job of openJobs.slice(0, config.jobSampleLimit)) {
    const jobId = String(job?.id || job?.job_id || '').trim()
    if (!jobId) continue
    const detailResponse = await client(`/jobs/${encodeURIComponent(jobId)}`)
    const detailSummary = summarizeResponse(detailResponse, { kind: 'job_detail' })
    sampledJobs.push({
      jobId,
      status: detailResponse.status,
      durationMs: detailResponse.durationMs,
      applicantRefs: countJobApplicantRefs(detailResponse.body),
      candidateIds: extractCandidateIds(detailResponse.body).slice(0, 10),
      sample: detailSummary.sample,
    })
  }

  return {
    ...jobsSummary,
    openJobs: openJobs.length,
    sampledJobs,
  }
}

export async function probeFullScanBaseline({ client, config }) {
  const pages = []
  let totalItems = 0
  let stoppedReason = 'page_cap_reached'

  for (let page = 1; page <= config.fullScanPages; page += 1) {
    const path = page === 1 ? '/applicants' : `/applicants/page/${page}`
    const response = await client(path)
    const summary = summarizeResponse(response, { kind: 'full_scan_page' })
    totalItems += summary.count || 0
    pages.push({
      page,
      path,
      status: response.status,
      durationMs: response.durationMs,
      count: summary.count,
      candidateIds: summary.candidateIds,
      sample: summary.sample,
    })
    if (!response.ok) {
      stoppedReason = 'request_failed'
      break
    }
    if ((summary.count || 0) < PAGE_SIZE) {
      stoppedReason = 'short_page'
      break
    }
  }

  return {
    status: pages.at(-1)?.status || 0,
    pagesFetched: pages.length,
    configuredPageCap: config.fullScanPages,
    totalItems,
    estimatedRequestsForFullScan: estimateFullScanRequests(pages),
    stoppedReason,
    pages,
  }
}

export function summarizeResponse(response, { kind }) {
  const items = extractItems(response.body)
  return {
    kind,
    path: response.path,
    status: response.status,
    ok: response.ok,
    durationMs: response.durationMs,
    count: items.length,
    textLength: response.textLength,
    candidateIds: extractCandidateIds(response.body).slice(0, 20),
    detectedDateFields: detectFields(response.body, /date|time|created|updated|modified/i).slice(0, 20),
    detectedIdFields: detectFields(response.body, /(^id$|_id$|Id$|object|prospect|applicant|candidate)/i).slice(0, 30),
    sample: summarizeItems(items.slice(0, 3)),
  }
}

export function interpretProbeResults(results) {
  const activitiesUseful = results.activities.ok && results.activities.candidateIds.length > 0
  const applicantDateUseful = results.applicantDateFilters.ok && results.applicantDateFilters.count > 0
  const jobScopedUseful = results.openJobSync.ok && results.openJobSync.openJobs > 0

  let recommendation
  if (activitiesUseful) {
    recommendation = 'activity_delta_sync'
  } else if (applicantDateUseful && jobScopedUseful) {
    recommendation = 'hybrid_apply_date_plus_open_job_sync'
  } else if (jobScopedUseful) {
    recommendation = 'open_job_scoped_sync'
  } else {
    recommendation = 'scheduled_full_sync'
  }

  return {
    ...results,
    decision: {
      recommendation,
      activitiesUseful,
      applicantDateUseful,
      jobScopedUseful,
      notes: decisionNotes({
        activitiesUseful,
        applicantDateUseful,
        jobScopedUseful,
        fullScanBaseline: results.fullScanBaseline,
      }),
    },
  }
}

function decisionNotes({ activitiesUseful, applicantDateUseful, jobScopedUseful, fullScanBaseline }) {
  const notes = []
  if (activitiesUseful) {
    notes.push('Activities returned candidate/applicant identifiers; this can support a true delta-sync prototype.')
  } else {
    notes.push('Activities did not prove a usable candidate-id delta feed in this probe.')
  }
  if (applicantDateUseful) {
    notes.push('Applicant date filters returned records; treat this as new-applicant coverage unless JazzHR confirms it is modification date.')
  }
  if (jobScopedUseful) {
    notes.push('Open jobs can be sampled for role-scoped candidate refreshes.')
  }
  if (fullScanBaseline?.estimatedRequestsForFullScan) {
    notes.push(`Full scan estimate from sampled pages: about ${fullScanBaseline.estimatedRequestsForFullScan} applicant page requests.`)
  }
  return notes
}

function summarizeItems(items) {
  return items.map((item) => ({
    keys: Object.keys(item || {}).slice(0, 30),
    candidateIds: extractCandidateIds(item).slice(0, 10),
    dateFields: pickFields(item, /date|time|created|updated|modified/i),
    idFields: pickFields(item, /(^id$|_id$|Id$|object|prospect|applicant|candidate)/i),
  }))
}

function extractItems(body) {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.activities)) return body.activities
  if (Array.isArray(body?.applicants)) return body.applicants
  if (Array.isArray(body?.jobs)) return body.jobs
  return body && typeof body === 'object' ? [body] : []
}

function extractCandidateIds(value) {
  const ids = new Set()
  walk(value, (key, item) => {
    if (!isCandidateIdKey(key)) return
    if (typeof item === 'string' || typeof item === 'number') {
      const normalized = String(item).trim()
      if (normalized) ids.add(normalized)
    }
  })
  return [...ids]
}

function isCandidateIdKey(key) {
  return /^(id|applicant_id|applicantId|prospect_id|prospectId|candidate_id|candidateId|object_id|objectId)$/i.test(String(key || '')) ||
    /applicant|prospect|candidate/i.test(String(key || ''))
}

function detectFields(value, pattern) {
  const fields = new Set()
  walk(value, (key) => {
    if (key && pattern.test(String(key))) fields.add(String(key))
  })
  return [...fields]
}

function pickFields(item, pattern) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return {}
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key, value]) => pattern.test(key) && isSafeScalar(value))
      .slice(0, 12)
      .map(([key, value]) => [key, String(value).slice(0, 120)]),
  )
}

function countJobApplicantRefs(body) {
  const values = Array.isArray(body?.job_applicants)
    ? body.job_applicants
    : Array.isArray(body?.applicants)
      ? body.applicants
      : []
  return values.length
}

function isOpenJob(job) {
  const status = String(job?.status || job?.job_status || '').trim().toLowerCase()
  return ['open', 'active', 'published'].includes(status)
}

function estimateFullScanRequests(pages) {
  const last = pages.at(-1)
  if (!last?.count) return pages.length
  if (last.count < PAGE_SIZE) return pages.length
  return `at least ${pages.length}`
}

function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return String(text || '').slice(0, 500)
  }
}

function walk(value, visit, key = '') {
  visit(key, value)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, key)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      walk(childValue, visit, childKey)
    }
  }
}

function isSafeScalar(value) {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value)
}

function parseDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function ymd(date) {
  return date.toISOString().slice(0, 10)
}

async function main() {
  const config = buildProbeConfig()
  const result = await runJazzhrDeltaProbe({ config })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }, null, 2))
    process.exitCode = 1
  })
}

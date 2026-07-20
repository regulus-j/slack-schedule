import { setApplicants, setRecruiters, setJazzhrJobs, getApplicants } from '../data/cache.js';
import { searchApplicants } from '../data/search.js';
import { fetchWithTimeout } from './http-client.js'

const BASE = 'https://api.resumatorapi.com/v1';
const DEFAULT_FETCH_CONCURRENCY = 2;
const ROLE_SYNC_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCOUNT = 'default';
const roleSyncCache = new Map();

function resolveApiKey(config, accountKey = DEFAULT_ACCOUNT) {
  const accounts = config?.jazzhr?.accounts
  if (!accounts || accounts.length === 0) return ''
  const account = accounts.find((a) => a.key === accountKey) || accounts[0]
  return account.apiKey || ''
}
const EXCLUDED_APPLICANT_DISPOSITIONS = [
  '1ST INTERVIEW - REJECTED BY RECRUITER',
  'RESUME SCREENING - REJECTED BY RECRUITER',
  'RESUME SCREENING - REJECTED BY HIRING MANAGER',
  '2ND OR FINAL INTERVIEW - REJECTED BY HIRING MANAGER',
  'REJECTED DUE TO FAILED ASSESSMENT',
  'BLACK LISTED AND NOT CULTURE FIT',
  'OUT OF THE HIRING AREA',
  'OUT OF SYDNEY, AUSTRALIA',
  'WITHDREW APPLICATION',
  'AUTO REJECTION DUE LACK OF EXPERIENCE',
  'AUTO REJECTION - OUT OF THE HIRING AREA',
  'MISSED INTERVIEW',
  'UNRESPONSIVE',
  'GOOD FOR FUTURE HIRE',
  'ENDORSED TO ANOTHER ROLE',
  'DECLINED JOB OFFER',
  'FAILED TRIAL PERIOD - REJECTED BY HM',
  'OFFBOARDED',
];
const EXCLUDED_APPLICANT_DISPOSITION_KEYS = new Set(EXCLUDED_APPLICANT_DISPOSITIONS.map(statusKey));
const INACTIVE_APPLICANT_TERMS = [
  'rejected',
  'reject',
  'declined',
  'decline',
  'withdrawn',
  'withdraw',
  'hired',
  'archived',
  'deleted',
  'closed',
  'unresponsive',
  'black listed',
  'blacklisted',
  'offboarded',
];
export const ALLOWED_APPLICANT_STAGE_KEYS = new Set([
  'new',
  'prescreening',
  'resumescreening',
  'screening',
  'screen',
  'phonescreen',
  'statusupdate',
  'pre1stinterview',
  '1stinterview',
  'completed1stinterview',
  'assessment',
  'assesment',
  'submittedtohiringmanager',
  'pre2ndinterview',
  '2ndinterview',
  'finalinterview',
  'shortlisted',
  'onhold',
  'forconsideration',
  'onholdorforconsideration',
  'joboffer',
]);
const INACTIVE_WORKFLOW_CATEGORY_KEYS = new Set(['nothired', 'hired', 'inactive', 'rejected']);

export async function searchCachedApplicants(query, accountKey = DEFAULT_ACCOUNT) {
  return searchApplicants(query, getApplicants(accountKey));
}

export async function hydrateJazzhrCacheFromStore({ store, logger, limit = 50000, accountKey = DEFAULT_ACCOUNT } = {}) {
  if (!store?.listJazzhrCandidates && !store?.searchJazzhrCandidates) {
    return { hydrated: false, records: 0 };
  }

  try {
    const applicants = store.listJazzhrCandidates
      ? await store.listJazzhrCandidates({ limit, accountKey })
      : await store.searchJazzhrCandidates('', { limit, accountKey });
    setApplicants(applicants, accountKey);
    logger?.info?.('jazzhr_cache_hydrated', {
      records: applicants.length,
      source: 'store',
      accountKey,
    });
    return { hydrated: applicants.length > 0, records: applicants.length };
  } catch (err) {
    logger?.warn?.('jazzhr_cache_hydrate_failed', { error: err.message, accountKey });
    return { hydrated: false, records: 0, error: err.message };
  }
}

export async function fetchApplicantDetail(apiKey, jazzhrApplicationId, logger, { jobId = '' } = {}) {
  if (!apiKey || !jazzhrApplicationId) return null;

  try {
    const data = await jazzhrGetWithRetry(`/applicants/${encodeURIComponent(jazzhrApplicationId)}`, apiKey, logger);
    return mapApplicantDetail(data, jobId);
  } catch (err) {
    logger.warn('jazzhr_applicant_detail_failed', {
      jazzhrApplicationId,
      error: err.message,
    });
    return null;
  }
}

export async function refreshJazzhrCache({ config, logger, store, throwOnError = false, accountKey = DEFAULT_ACCOUNT }) {
  const apiKey = resolveApiKey(config, accountKey)

  if (!apiKey) {
    const msg = 'JAZZHR_API_KEY is not set';
    if (throwOnError) throw new Error(msg);
    logger.warn('jazzhr_cache_refresh_skipped', { reason: 'missing_api_key', accountKey });
    return { refreshed: false, records: 0 };
  }

  try {
    // Fetch applicants first (paginated, can be slow), then users.
    // Sequential avoids doubling up on concurrent API calls to the same rate-limited endpoint.
    const applicantResult = await fetchAllApplicants(
      apiKey,
      logger,
      config.jazzhr.applicantMaxPages,
      config.jazzhr.applicantFetchConcurrency,
    )
    const users = await fetchAllUsers(apiKey, logger)
    const { applicants, total, unique, pagesFetched, maxPagesReached, excluded, excludedReasons } = applicantResult;

    setApplicants(applicants, accountKey);
    setRecruiters(users, accountKey);
    let indexedCandidates = 0;
    if (store?.saveJazzhrCandidates) {
      indexedCandidates = await store.saveJazzhrCandidates(applicants);
    }

    logger.info('jazzhr_cache_refreshed', {
      totalApplicants: total,
      uniqueApplicants: unique,
      applicants: applicants.length,
      pagesFetched,
      maxPagesReached,
      excludedApplicants: excluded,
      excludedReasons,
      recruiters: users.length,
      indexedCandidates,
      accountKey,
    });

    return { refreshed: true, records: applicants.length, indexedCandidates };
  } catch (err) {
    if (throwOnError) throw err;
    logger.error('jazzhr_cache_refresh_failed', { error: err.message, accountKey });
    return { refreshed: false, records: 0 };
  }
}

export async function fetchAllApplicants(apiKey, logger, maxPages = 250, concurrency = DEFAULT_FETCH_CONCURRENCY) {
  const all = [];
  const seenIds = new Set();
  const perPage = 100;
  let totalFetched = 0;
  let pagesFetched = 0;
  let duplicatePages = 0;
  let nextPage = 1;
  let shouldStop = false;
  const resolvedMaxPages = positiveInteger(maxPages, 250);
  const resolvedConcurrency = positiveInteger(concurrency, DEFAULT_FETCH_CONCURRENCY);

  const processPage = ({ page, data }) => {
    if (!Array.isArray(data) || data.length === 0) {
      shouldStop = true;
      return;
    }

    totalFetched += data.length;
    pagesFetched++;
    let newCount = 0;
    for (const item of data) {
      const itemKey = applicantRecordKey(item);
      if (!seenIds.has(itemKey)) {
        seenIds.add(itemKey);
        all.push(item);
        newCount++;
      }
    }

    logger.info('jazzhr_applicants_page', { page, count: data.length, new: newCount });

    if (newCount === 0) {
      duplicatePages++;
      if (duplicatePages >= 2) {
        logger.warn('jazzhr_applicants_duplicate_pages_stopped', {
          page,
          duplicatePages,
          totalFetched,
          unique: all.length,
        });
        shouldStop = true;
        return;
      }
    } else {
      duplicatePages = 0;
    }

    if (data.length < perPage) shouldStop = true;
  };

  const fetchPage = async (page) => ({
    page,
    data: await jazzhrGetWithRetry(applicantListPath(page), apiKey, logger),
  });

  processPage(await fetchPage(nextPage));
  nextPage++;

  while (!shouldStop && nextPage <= resolvedMaxPages) {
    const batchPages = [];
    while (batchPages.length < resolvedConcurrency && nextPage <= resolvedMaxPages) {
      batchPages.push(nextPage);
      nextPage++;
    }

    const batchResults = await Promise.all(batchPages.map(fetchPage));
    for (const result of batchResults) {
      processPage(result);
      if (shouldStop) break;
    }

    // Small delay between batches to avoid hammering the JazzHR rate limiter.
    if (!shouldStop && nextPage <= resolvedMaxPages) {
      await sleep(300)
    }
  }

  const maxPagesReached = !shouldStop && nextPage > resolvedMaxPages;
  if (maxPagesReached) {
    logger.warn('jazzhr_applicants_max_pages_reached', {
      maxPages: resolvedMaxPages,
      totalFetched,
      unique: all.length,
    });
  }

  return {
    ...filterActiveApplicants(all),
    total: totalFetched,
    unique: all.length,
    pagesFetched,
    maxPagesReached,
  };
}

export async function refreshJazzhrOpenJobs({ config, logger, accountKey = DEFAULT_ACCOUNT } = {}) {
  const apiKey = resolveApiKey(config, accountKey)
  if (!apiKey) {
    logger?.info?.('jazzhr_open_jobs_skipped', { reason: 'missing_api_key', accountKey })
    return { refreshed: false, records: 0, jobs: [] }
  }

  try {
    const data = await jazzhrGetWithRetry('/jobs', apiKey, logger)
    const users = await fetchAllUsers(apiKey, logger)
    const jobs = extractJobArray(data).map(mapJazzhrJob).filter((job) => job.id)
    const openJobs = jobs.filter((job) => isOpenJobStatus(job.status))
    setJazzhrJobs(openJobs, accountKey)
    setRecruiters(users, accountKey)
    logger?.info?.('jazzhr_open_jobs_loaded', { total: jobs.length, open: openJobs.length, accountKey })
    return { refreshed: true, records: openJobs.length, jobs: openJobs }
  } catch (err) {
    logger?.warn?.('jazzhr_open_jobs_failed', { error: err.message, accountKey })
    return { refreshed: false, records: 0, jobs: [], error: err.message }
  }
}

export async function syncJazzhrJobCandidates({
  config,
  logger,
  store,
  jobId,
  concurrency,
  force = false,
  accountKey = DEFAULT_ACCOUNT,
} = {}) {
  const apiKey = resolveApiKey(config, accountKey)
  const resolvedJobId = String(jobId || '').trim()
  if (!apiKey || !resolvedJobId) {
    return { synced: false, mocked: !apiKey, job: null, workflow: null, candidates: [] }
  }

  const cacheKey = `${accountKey}::${resolvedJobId}`
  const existing = roleSyncCache.get(cacheKey)
  if (!force && existing?.result && Date.now() - existing.updatedAt < ROLE_SYNC_TTL_MS) {
    return { ...existing.result, cached: true }
  }
  if (!force && existing?.promise) return existing.promise

  const promise = performJazzhrJobCandidateSync({
    apiKey,
    config,
    logger,
    store,
    resolvedJobId,
    concurrency,
    accountKey,
  })
  roleSyncCache.set(cacheKey, { promise })

  try {
    const result = await promise
    if (result.synced && result.complete) {
      roleSyncCache.set(cacheKey, { result, updatedAt: Date.now() })
    } else {
      roleSyncCache.delete(cacheKey)
    }
    return result
  } catch (err) {
    roleSyncCache.delete(cacheKey)
    throw err
  }
}

async function fetchApplicantIdsByJob(apiKey, logger, jobId) {
  const ids = []
  let page = 1
  while (true) {
    const pathname = `/applicants?job_id=${encodeURIComponent(jobId)}&page=${page}`
    const data = await jazzhrGetWithRetry(pathname, apiKey, logger)
    const pageItems = Array.isArray(data) ? data : []
    for (const item of pageItems) {
      const id = String(item?.id || '').trim()
      if (id) {
        ids.push({
          id,
          appliedAt: item.apply_date || item.applied_at || item.date_applied || '',
        })
      }
    }
    if (pageItems.length < 100) break
    page++
  }
  return ids
}

async function performJazzhrJobCandidateSync({
  apiKey,
  config,
  logger,
  store,
  resolvedJobId,
  concurrency,
  accountKey = DEFAULT_ACCOUNT,
}) {
  try {
    // Fetch applicant IDs via paginated list (efficient — 1-3 calls instead of 1 /jobs call).
    // The list endpoint only returns 7 fields, so we still need per-applicant detail fetches
    // for email, stage, workflow, and recruiter fields.
    const applicationRefs = await fetchApplicantIdsByJob(apiKey, logger, resolvedJobId)

    if (applicationRefs.length === 0) {
      logger?.info?.('jazzhr_job_candidates_synced', {
        jobId: resolvedJobId,
        applicants: 0,
        candidates: 0,
        complete: true,
        accountKey,
      })
      return { synced: true, job: { id: resolvedJobId, title: '', status: '', hiringLeadId: '' }, workflow: null, candidates: [], complete: true }
    }

    // Job metadata: title/status/hiringLeadId come from the open-roles cache (populated at startup).
    // We pass a minimal job object; mapRoleScopedCandidate only needs job.id and job.title.
    const job = { id: resolvedJobId, title: '', status: '', hiringLeadId: '' }

    const limit = createConcurrencyLimit(positiveInteger(concurrency || config?.jazzhr?.applicantFetchConcurrency, DEFAULT_FETCH_CONCURRENCY))
    const applicationResults = await Promise.all(applicationRefs.map((application, sourceOrder) => limit(async () => {
      const detail = await fetchApplicantDetail(apiKey, application.id, logger, { jobId: resolvedJobId })
      return {
        detail,
        candidate: detail ? mapRoleScopedCandidate({
          detail,
          application,
          job,
          sourceOrder,
        }) : null,
      }
    })))
    const candidates = applicationResults.map((result) => result.candidate).filter(Boolean)
    const complete = applicationResults.every((result) => result.detail)

    if (complete && store?.replaceJazzhrJobCandidates) {
      await store.replaceJazzhrJobCandidates(resolvedJobId, candidates)
    } else if (store?.upsertJazzhrCandidates) {
      await store.upsertJazzhrCandidates(candidates)
    }
    if (complete) {
      replaceJobApplicantsInCache(resolvedJobId, candidates, accountKey)
    } else {
      mergeApplicantsIntoCache(candidates, accountKey)
    }
    const failedCount = applicationRefs.length - applicationResults.filter((r) => r.detail).length
    logger?.info?.('jazzhr_job_candidates_synced', {
      jobId: resolvedJobId,
      applicants: applicationRefs.length,
      candidates: candidates.length,
      failed: failedCount,
      complete,
      accountKey,
    })
    return {
      synced: true,
      job,
      workflow: null,
      candidates,
      complete,
      failedCount,
    }
  } catch (err) {
    logger?.warn?.('jazzhr_job_candidates_sync_failed', { jobId: resolvedJobId, error: err.message, accountKey })
    return { synced: false, job: null, workflow: null, candidates: [], error: err.message }
  }
}

function applicantListPath(page) {
  return page <= 1 ? '/applicants' : `/applicants/page/${page}`;
}

function applicantRecordKey(item) {
  const id = String(item?.id || item?.applicant_id || '').trim();
  const jobs = normalizeApplicantJobs(item?.jobs);
  if (jobs.length === 0) return id;
  return [
    id,
    ...jobs.map((job) => [
      job?.job_id || job?.id || '',
      job?.job_title || job?.title || '',
      job?.applicant_progress || job?.applicantProgress || '',
    ].join(':')),
  ].join('|');
}

export function filterActiveApplicants(items) {
  const applicants = [];
  const excludedReasonCounts = {};
  let excluded = 0;
  let total = 0;

  for (const item of items || []) {
    for (const record of applicantRoleRecords(item)) {
      total++;
      const inactiveReason = inactiveApplicantReason(record);
      if (inactiveReason) {
        excluded++;
        excludedReasonCounts[inactiveReason] = (excludedReasonCounts[inactiveReason] || 0) + 1;
        continue;
      }
      applicants.push(mapApplicant(record, applicants.length));
    }
  }

  return {
    applicants,
    total,
    excluded,
    excludedReasons: topReasonCounts(excludedReasonCounts),
  };
}

function applicantRoleRecords(item) {
  const jobs = normalizeApplicantJobs(item?.jobs);
  if (jobs.length === 0) return [item];
  return jobs.map((job) => ({
    ...item,
    jobs: job,
    job_id: job.job_id || job.id || '',
    job_title: job.job_title || job.title || item.job_title || '',
    applicant_progress: job.applicant_progress || job.applicantProgress || item.applicant_progress || '',
    workflow_step_id: job.workflow_step_id || item.workflow_step_id || '',
    workflow_step: job.workflow_step || job.workflowStep || item.workflow_step || '',
    workflow_category: job.workflow_category || job.workflowCategory ||
      job.workflow_step_category || job.category ||
      item.workflow_category || item.workflow_step_category || '',
    disposition: job.disposition || job.disposition_name || item.disposition || '',
    disposition_status: job.disposition_status || job.dispositionStatus || item.disposition_status || '',
    recruiter_id: job.recruiter_id || item.recruiter_id || '',
    recruiter_email: job.recruiter_email || job.recruiterEmail || item.recruiter_email || '',
    recruiter_name: job.recruiter_name || job.recruiterName || item.recruiter_name || '',
    apply_date: job.apply_date || job.applyDate || item.apply_date || item.applyDate,
    date_applied: job.date_applied || job.dateApplied || item.date_applied || item.dateApplied,
  }));
}

export function inactiveApplicantReason(item) {
  const workflowCategory = firstValue(item, [
    'workflowCategory',
    'workflow_category',
    'workflowStepCategory',
    'workflow_step_category',
    'category',
  ])
  const workflowCategoryKey = statusKey(workflowCategory)
  if (INACTIVE_WORKFLOW_CATEGORY_KEYS.has(workflowCategoryKey)) {
    return `workflow-category:${normalizeStatusText(workflowCategory)}`
  }

  const values = applicantStatusValues(item);
  for (const value of values) {
    const normalized = normalizeStatusText(value);
    if (EXCLUDED_APPLICANT_DISPOSITION_KEYS.has(statusKey(normalized))) {
      return `disposition:${normalized}`;
    }
    const matchedTerm = INACTIVE_APPLICANT_TERMS.find((term) => normalized.includes(term));
    if (matchedTerm) return matchedTerm;
  }
  const stage = firstValue(item, ['stage', 'applicantProgress', 'applicant_progress', 'workflowStep', 'workflow_step']);
  if (stage && !ALLOWED_APPLICANT_STAGE_KEYS.has(applicantStageKey(stage))) {
    return `unknown-stage:${normalizeStatusText(stage)}`;
  }
  return '';
}

export function applicantEligibilityReason(item, { allowUnknown = false } = {}) {
  const inactiveReason = inactiveApplicantReason(item)
  if (inactiveReason) return inactiveReason

  const stage = firstValue(item, [
    'stage',
    'applicantProgress',
    'applicant_progress',
    'workflowStep',
    'workflow_step',
  ])
  if (!stage) return allowUnknown ? '' : 'unknown-stage'
  return ALLOWED_APPLICANT_STAGE_KEYS.has(applicantStageKey(stage)) ? '' : `unknown-stage:${normalizeStatusText(stage)}`
}

export function filterEligibleApplicants(items) {
  return (items || []).filter((item) => !applicantEligibilityReason(item))
}

function applicantStatusValues(item) {
  return collectStatusValues([
    item?.applicant_progress,
    item?.status,
    item?.applicant_status,
    item?.stage,
    item?.disposition,
    item?.disposition_status,
    item?.workflow_step,
    item?.jobs,
  ]);
}

function collectStatusValues(values) {
  const collected = [];

  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      collected.push(...collectStatusValues(value));
      continue;
    }
    if (typeof value === 'object') {
      collected.push(...collectStatusValues([
        value.applicant_progress,
        value.applicantProgress,
        value.status,
        value.applicant_status,
        value.applicantStatus,
        value.disposition,
        value.disposition_status,
        value.dispositionStatus,
        value.disposition_name,
        value.dispositionName,
        value.workflow_step,
        value.workflowStep,
      ]));
      continue;
    }
    collected.push(value);
  }

  return collected;
}

function normalizeStatusText(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function statusKey(value) {
  return normalizeStatusText(value).replace(/[^a-z0-9]+/g, '');
}

export function applicantStageKey(value) {
  return statusKey(String(value || '').replace(/^\s*\d+\s*[.)-]\s*/, ''))
}

function topReasonCounts(counts, limit = 5) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Shared rate limiter ──
// All JazzHR API calls gate through this queue to avoid triggering 429s.
const _limiter = {
  active: 0,
  maxConcurrent: 2,
  minGapMs: 250,
  lastRequestAt: 0,
  pausedUntil: 0,
  queue: [],
}

function _updateLimiterFromHeaders(res) {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  if (remaining !== null && reset !== null) {
    const rem = parseInt(remaining, 10)
    const resetSec = parseInt(reset, 10)
    // If we're running low on quota, pause until the reset window.
    if (rem <= 5 && resetSec) {
      const pauseMs = Math.max(0, (resetSec * 1000) - Date.now()) + 1000
      if (pauseMs > 0 && pauseMs < 60000) {
        _limiter.pausedUntil = Math.max(_limiter.pausedUntil, Date.now() + pauseMs)
      }
    }
  }
}

function _enqueue() {
  return new Promise((resolve) => {
    _limiter.queue.push(resolve)
    _flushQueue()
  })
}

function _flushQueue() {
  while (_limiter.queue.length > 0 && _limiter.active < _limiter.maxConcurrent) {
    if (Date.now() < _limiter.pausedUntil) break
    const gap = Date.now() - _limiter.lastRequestAt
    if (gap < _limiter.minGapMs) break
    const next = _limiter.queue.shift()
    _limiter.active++
    _limiter.lastRequestAt = Date.now()
    next()
  }
  // If paused, schedule a flush when the pause ends.
  if (_limiter.queue.length > 0 && _limiter.pausedUntil > Date.now()) {
    const delay = _limiter.pausedUntil - Date.now() + 50
    setTimeout(_flushQueue, delay).unref()
  }
}

function _releaseSlot() {
  _limiter.active = Math.max(0, _limiter.active - 1)
  // Small gap between requests to avoid burst pressure.
  setTimeout(_flushQueue, _limiter.minGapMs).unref()
}

async function jazzhrGetWithRetry(pathname, apiKey, logger, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await _enqueue()
      try {
        return await jazzhrGet(pathname, apiKey)
      } finally {
        _releaseSlot()
      }
    } catch (err) {
      if (err.message.includes('429') && attempt < maxRetries - 1) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000)
        _limiter.pausedUntil = Math.max(_limiter.pausedUntil, Date.now() + delay)
        logger.warn('jazzhr_rate_limited', { pathname, attempt, retryAfterMs: delay });
        await sleep(delay)
        continue
      }
      throw err
    }
  }
}

async function fetchAllUsers(apiKey, logger) {
  const data = await jazzhrGetWithRetry('/users', apiKey, logger);

  const array = extractArray(data);
  if (!array || array.length === 0) {
    logger.warn('jazzhr_users_empty');
    return [];
  }

  const active = array.filter((u) => isActiveUser(u));
  const typeCounts = countBy(array, (u) => (u.type || 'unknown').toLowerCase());

  logger.info('jazzhr_users_loaded', {
    total: array.length,
    active: active.length,
    types: typeCounts,
  });

  return active.map((u, i) => mapUser(u, i));
}

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.users)) return data.users;
    if (Array.isArray(data.data)) return data.data;
  }
  return null;
}

function countBy(array, fn) {
  const counts = {};
  for (const item of array) {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function jazzhrGet(pathname, apiKey) {
  const url = `${BASE}${pathname}`;
  const sep = pathname.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetchWithTimeout(fullUrl);
  _updateLimiterFromHeaders(res)

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`JazzHR API ${pathname} returned ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

function isActiveUser(user) {
  const type = (user.type || '').toLowerCase();
  return type !== 'deleted';
}

function mapApplicant(item, sourceOrder = 0) {
  const firstName = item.first_name || ''
  const lastName = item.last_name || ''
  const jazzhrApplicationId = String(item.id)
  const jazzhrJobId = String(item.job_id || item.jobId || item.jobs?.job_id || item.jobs?.id || '').trim()
  const candidateKey = [jazzhrApplicationId, jazzhrJobId].filter(Boolean).join('::')
  return {
    id: `applicant-${candidateKey}`,
    candidateKey,
    jazzhrApplicationId,
    jazzhrJobId,
    fullName: [firstName, lastName].filter(Boolean).join(' ').trim(),
    firstName,
    lastName,
    email: item.email || '',
    phone: item.phone || item.prospect_phone || '',
    jobTitle: item.job_title || '',
    stage: item.applicant_progress || '',
    workflowStepId: item.workflow_step_id || '',
    workflowStep: item.workflow_step || '',
    workflowCategory: item.workflow_category || item.workflow_step_category || '',
    jobStatus: item.job_status || '',
    hiringManagerId: '',
    recruiterId: normalizeRecruiterId(item.recruiter_id),
    recruiterEmail: item.recruiter_email || '',
    recruiterName: item.recruiter_name || '',
    source: 'jazzhr',
    appliedAt: firstValue(item, ['apply_date', 'applyDate', 'date_applied', 'dateApplied', 'created_at', 'createdAt', 'created', 'updated_at', 'updatedAt']),
    sourceOrder,
  };
}

function mapApplicantDetail(item, jobId = '') {
  if (!item) return null;

  const resumeUrl = item.resume_link || item.resume || item.resume_url || item.resumeUrl || '';
  const resumeText = item.resume_text || item.resumeText || '';
  const jobs = normalizeApplicantJobs(item.jobs)
  const selectedJob = jobs.find((job) => String(job?.job_id || job?.id || '').trim() === String(jobId || '').trim()) ||
    (jobs.length === 1 ? jobs[0] : null) ||
    {}

  return {
    jazzhrApplicationId: String(item.id || item.applicant_id || '').trim(),
    jazzhrJobId: String(selectedJob.job_id || selectedJob.id || jobId || '').trim(),
    firstName: item.first_name || item.firstName || '',
    lastName: item.last_name || item.lastName || '',
    fullName: item.name || item.full_name || item.fullName || '',
    email: item.email || item.email_address || '',
    phone: item.phone || item.prospect_phone || item.cell_phone || '',
    address: [
      item.address || '',
      item.city || '',
      item.state || item.province || '',
      item.zip || item.postal_code || item.zipcode || '',
    ]
      .filter(Boolean)
      .join(', '),
    resumeUrl,
    resumeText: resumeText ? resumeText.slice(0, 500) : '',
    jobTitle: selectedJob.job_title || selectedJob.title || item.job_title || item.jobTitle || item.title || '',
    stage: selectedJob.applicant_progress || selectedJob.applicantProgress || item.applicant_progress || item.applicantProgress || item.stage || '',
    workflowStepId: selectedJob.workflow_step_id || selectedJob.workflowStepId || item.workflow_step_id || '',
    workflowStep: selectedJob.workflow_step || selectedJob.workflowStep || item.workflow_step || '',
    workflowCategory: selectedJob.workflow_category || selectedJob.workflowCategory ||
      selectedJob.workflow_step_category || selectedJob.category ||
      item.workflow_category || item.workflow_step_category || '',
    recruiterId: normalizeRecruiterId(selectedJob.recruiter_id || item.recruiter_id),
    recruiterEmail: selectedJob.recruiter_email || item.recruiter_email || '',
    recruiterName: selectedJob.recruiter_name || item.recruiter_name || '',
    source: item.source || '',
    rating: item.jobs?.hiring_lead_rating != null ? String(item.jobs.hiring_lead_rating) : (item.jobs?.average_rating != null ? String(item.jobs.average_rating) : ''),
    applyDate: item.apply_date || item.applyDate || item.date_applied || '',
    education: item.education || item.education_summary || '',
    experience: item.experience || item.experience_summary || item.work_history || '',
    linkedinUrl: item.linkedin_url || item.linkedin || item.linkedinUrl || '',
    notes: item.notes || item.internal_notes || (Array.isArray(item.comments) ? '' : item.comments) || '',
  };
}

function normalizeApplicantJobs(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (value && typeof value === 'object') return [value]
  return []
}

function extractJobArray(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.jobs)) return data.jobs
  if (Array.isArray(data?.data)) return data.data
  return []
}

function mapJazzhrJob(item) {
  return {
    id: String(item?.id || item?.job_id || '').trim(),
    title: firstValue(item, ['title', 'job_title', 'jobTitle', 'name']),
    status: firstValue(item, ['status', 'job_status', 'jobStatus']),
    hiringLeadId: firstValue(item, ['hiring_lead', 'hiringLead', 'hiring_lead_id', 'hiringLeadId']),
  }
}

function isOpenJobStatus(status) {
  return ['open', 'active', 'published'].includes(normalizeStatusText(status))
}

function mapRoleScopedCandidate({ detail, application, job, sourceOrder }) {
  const nameParts = String(detail.fullName || '').trim().split(/\s+/)
  const firstName = detail.firstName || nameParts.shift() || ''
  const lastName = detail.lastName || nameParts.join(' ')
  const jazzhrApplicationId = detail.jazzhrApplicationId || application.id
  const jazzhrJobId = job.id
  const candidate = {
    id: `applicant-${jazzhrApplicationId}::${jazzhrJobId}`,
    candidateKey: `${jazzhrApplicationId}::${jazzhrJobId}`,
    jazzhrApplicationId,
    jazzhrJobId,
    fullName: [firstName, lastName].filter(Boolean).join(' ').trim(),
    firstName,
    lastName,
    email: detail.email || '',
    phone: detail.phone || '',
    jobTitle: detail.jobTitle || job.title || '',
    stage: detail.stage || '',
    workflowStepId: detail.workflowStepId || '',
    workflowStep: detail.workflowStep || '',
    workflowCategory: detail.workflowCategory || '',
    jobStatus: job.status || '',
    recruiterId: detail.recruiterId || '',
    recruiterEmail: detail.recruiterEmail || '',
    recruiterName: detail.recruiterName || '',
    source: 'jazzhr',
    appliedAt: detail.applyDate || application.appliedAt || '',
    sourceOrder,
  }
  return applicantEligibilityReason(candidate) ? null : candidate
}

function mergeApplicantsIntoCache(candidates, accountKey = DEFAULT_ACCOUNT) {
  const byKey = new Map(getApplicants(accountKey).map((candidate) => [candidate.candidateKey || candidate.id, candidate]))
  for (const candidate of candidates) byKey.set(candidate.candidateKey || candidate.id, candidate)
  setApplicants([...byKey.values()].sort(byAppliedAtDesc), accountKey)
}

function replaceJobApplicantsInCache(jobId, candidates, accountKey = DEFAULT_ACCOUNT) {
  const retained = getApplicants(accountKey).filter((candidate) => candidate.jazzhrJobId !== jobId)
  setApplicants([...retained, ...candidates].sort(byAppliedAtDesc), accountKey)
}

function byAppliedAtDesc(a, b) {
  const aTime = Date.parse(a?.appliedAt) || 0
  const bTime = Date.parse(b?.appliedAt) || 0
  if (aTime !== bTime) return bTime - aTime
  if ((a?.sourceOrder ?? 0) !== (b?.sourceOrder ?? 0)) return (a?.sourceOrder ?? 0) - (b?.sourceOrder ?? 0)
  return (a?.fullName || '').localeCompare(b?.fullName || '')
}

function createConcurrencyLimit(concurrency) {
  let active = 0
  const queue = []
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return
    active++
    const { task, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--
        runNext()
      })
  }
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    runNext()
  })
}

function mapUser(item, index) {
  const firstName = firstValue(item, ['first_name', 'firstName', 'first', 'firstname'])
  const lastName = firstValue(item, ['last_name', 'lastName', 'last', 'lastname'])
  const email = firstValue(item, ['email', 'email_address', 'emailAddress', 'work_email', 'workEmail'])
  const fullName = firstValue(item, ['name', 'full_name', 'fullName', 'display_name', 'displayName'])
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || fullName || email || `User ${index}`;

  return {
    id: `rec-${item.id}`,
    name,
    email,
    role: 'recruiter',
    slackUserId: '',
    zoomLink: '',
    signature: name,
  };
}

function normalizeRecruiterId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  return id.startsWith('rec-') ? id : `rec-${id}`;
}

function firstValue(item, keys) {
  for (const key of keys) {
    const value = String(item?.[key] || '').trim()
    if (value) return value
  }
  return ''
}

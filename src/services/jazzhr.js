import { setApplicants, setRecruiters, setJazzhrJobs, getApplicants } from '../data/cache.js';
import { searchApplicants } from '../data/search.js';

const BASE = 'https://api.resumatorapi.com/v1';
const DEFAULT_FETCH_CONCURRENCY = 2;
const ROLE_SYNC_TTL_MS = 5 * 60 * 1000;
const roleSyncCache = new Map();
const EXCLUDED_APPLICANT_DISPOSITIONS = [
  '1ST INTERVIEW - REJECTED BY RECRUITER',
  'RESUME SCREENING - REJECTED BY RECRUITER',
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
];
const ALLOWED_APPLICANT_STAGE_KEYS = new Set([
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

export async function searchCachedApplicants(query) {
  return searchApplicants(query, getApplicants());
}

export async function hydrateJazzhrCacheFromStore({ store, logger, limit = 50000 } = {}) {
  if (!store?.listJazzhrCandidates && !store?.searchJazzhrCandidates) {
    return { hydrated: false, records: 0 };
  }

  try {
    const applicants = store.listJazzhrCandidates
      ? await store.listJazzhrCandidates({ limit })
      : await store.searchJazzhrCandidates('', { limit });
    setApplicants(applicants);
    logger?.info?.('jazzhr_cache_hydrated', {
      records: applicants.length,
      source: 'store',
    });
    return { hydrated: applicants.length > 0, records: applicants.length };
  } catch (err) {
    logger?.warn?.('jazzhr_cache_hydrate_failed', { error: err.message });
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

export async function refreshJazzhrCache({ config, logger, store, throwOnError = false }) {
  const apiKey = config.jazzhr.apiKey;

  if (!apiKey) {
    const msg = 'JAZZHR_API_KEY is not set';
    if (throwOnError) throw new Error(msg);
    logger.warn('jazzhr_cache_refresh_skipped', { reason: 'missing_api_key' });
    return { refreshed: false, records: 0 };
  }

  try {
    const [applicantResult, users] = await Promise.all([
      fetchAllApplicants(
        apiKey,
        logger,
        config.jazzhr.applicantMaxPages,
        config.jazzhr.applicantFetchConcurrency,
      ),
      fetchAllUsers(apiKey, logger),
    ]);
    const { applicants, total, unique, pagesFetched, maxPagesReached, excluded, excludedReasons } = applicantResult;

    setApplicants(applicants);
    setRecruiters(users);
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
    });

    return { refreshed: true, records: applicants.length, indexedCandidates };
  } catch (err) {
    if (throwOnError) throw err;
    logger.error('jazzhr_cache_refresh_failed', { error: err.message });
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

export async function refreshJazzhrOpenJobs({ config, logger } = {}) {
  const apiKey = config?.jazzhr?.apiKey
  if (!apiKey) {
    logger?.info?.('jazzhr_open_jobs_skipped', { reason: 'missing_api_key' })
    return { refreshed: false, records: 0, jobs: [] }
  }

  try {
    const [data, users] = await Promise.all([
      jazzhrGetWithRetry('/jobs', apiKey, logger),
      fetchAllUsers(apiKey, logger),
    ])
    const jobs = extractJobArray(data).map(mapJazzhrJob).filter((job) => job.id)
    const openJobs = jobs.filter((job) => isOpenJobStatus(job.status))
    setJazzhrJobs(openJobs)
    setRecruiters(users)
    logger?.info?.('jazzhr_open_jobs_loaded', { total: jobs.length, open: openJobs.length })
    return { refreshed: true, records: openJobs.length, jobs: openJobs }
  } catch (err) {
    logger?.warn?.('jazzhr_open_jobs_failed', { error: err.message })
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
} = {}) {
  const apiKey = config?.jazzhr?.apiKey
  const resolvedJobId = String(jobId || '').trim()
  if (!apiKey || !resolvedJobId) {
    return { synced: false, mocked: !apiKey, job: null, workflow: null, candidates: [] }
  }

  const existing = roleSyncCache.get(resolvedJobId)
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
  })
  roleSyncCache.set(resolvedJobId, { promise })

  try {
    const result = await promise
    if (result.synced && result.complete) {
      roleSyncCache.set(resolvedJobId, { result, updatedAt: Date.now() })
    } else {
      roleSyncCache.delete(resolvedJobId)
    }
    return result
  } catch (err) {
    roleSyncCache.delete(resolvedJobId)
    throw err
  }
}

async function performJazzhrJobCandidateSync({
  apiKey,
  config,
  logger,
  store,
  resolvedJobId,
  concurrency,
}) {
  try {
    const data = await jazzhrGetWithRetry(`/jobs/${encodeURIComponent(resolvedJobId)}`, apiKey, logger)
    const job = mapJazzhrJob(data)
    const applicationRefs = extractJobApplicantRefs(data)
    const limit = createConcurrencyLimit(positiveInteger(concurrency || config?.jazzhr?.applicantFetchConcurrency, DEFAULT_FETCH_CONCURRENCY))
    const applicationResults = await Promise.all(applicationRefs.map((application, sourceOrder) => limit(async () => {
      const detail = await fetchApplicantDetail(apiKey, application.id, logger, { jobId: resolvedJobId })
      return {
        detail,
        candidate: detail ? mapRoleScopedCandidate({
          detail,
          application,
          job: { ...job, id: resolvedJobId },
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
      replaceJobApplicantsInCache(resolvedJobId, candidates)
    } else {
      mergeApplicantsIntoCache(candidates)
    }
    logger?.info?.('jazzhr_job_candidates_synced', {
      jobId: resolvedJobId,
      applicants: applicationRefs.length,
      candidates: candidates.length,
      complete,
    })
    return {
      synced: true,
      job: { ...job, id: resolvedJobId },
      workflow: data?.workflow || data?.job_workflow || null,
      candidates,
      complete,
    }
  } catch (err) {
    logger?.warn?.('jazzhr_job_candidates_sync_failed', { jobId: resolvedJobId, error: err.message })
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

function applicantStageKey(value) {
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

async function jazzhrGetWithRetry(pathname, apiKey, logger, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await jazzhrGet(pathname, apiKey);
    } catch (err) {
      if (err.message.includes('429') && attempt < maxRetries - 1) {
        const delay = 2000 * (attempt + 1);
        logger.warn('jazzhr_rate_limited', { pathname, attempt, retryAfterMs: delay });
        await sleep(delay);
        continue;
      }
      throw err;
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

  const res = await fetch(fullUrl);

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

function extractJobApplicantRefs(data) {
  const values = Array.isArray(data?.job_applicants)
    ? data.job_applicants
    : Array.isArray(data?.applicants)
      ? data.applicants
      : []
  const seen = new Set()
  const refs = []
  for (const value of values) {
    const id = String(typeof value === 'string'
      ? value
      : value?.id || value?.applicant_id || value?.prospect_id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    refs.push({
      id,
      appliedAt: firstValue(value, ['apply_date', 'applyDate', 'date_applied', 'dateApplied']),
    })
  }
  return refs
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

function mergeApplicantsIntoCache(candidates) {
  const byKey = new Map(getApplicants().map((candidate) => [candidate.candidateKey || candidate.id, candidate]))
  for (const candidate of candidates) byKey.set(candidate.candidateKey || candidate.id, candidate)
  setApplicants([...byKey.values()])
}

function replaceJobApplicantsInCache(jobId, candidates) {
  const retained = getApplicants().filter((candidate) => candidate.jazzhrJobId !== jobId)
  setApplicants([...retained, ...candidates])
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

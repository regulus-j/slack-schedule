import { setApplicants, setRecruiters, getApplicants } from '../data/cache.js';
import { searchApplicants } from '../data/search.js';

const BASE = 'https://api.resumatorapi.com/v1';
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

export async function searchCachedApplicants(query) {
  return searchApplicants(query, getApplicants());
}

export async function fetchApplicantDetail(apiKey, jazzhrApplicationId, logger) {
  if (!apiKey || !jazzhrApplicationId) return null;

  try {
    const data = await jazzhrGetWithRetry(`/applicants/${encodeURIComponent(jazzhrApplicationId)}`, apiKey, logger);
    return mapApplicantDetail(data);
  } catch (err) {
    logger.warn('jazzhr_applicant_detail_failed', {
      jazzhrApplicationId,
      error: err.message,
    });
    return null;
  }
}

export async function refreshJazzhrCache({ config, logger, throwOnError = false }) {
  const apiKey = config.jazzhr.apiKey;

  if (!apiKey) {
    const msg = 'JAZZHR_API_KEY is not set';
    if (throwOnError) throw new Error(msg);
    logger.warn('jazzhr_cache_refresh_skipped', { reason: 'missing_api_key' });
    return { refreshed: false, records: 0 };
  }

  try {
    const [applicantResult, users] = await Promise.all([
      fetchAllApplicants(apiKey, logger, config.jazzhr.applicantMaxPages),
      fetchAllUsers(apiKey, logger),
    ]);
    const { applicants, total, unique, pagesFetched, maxPagesReached, excluded, excludedReasons } = applicantResult;

    setApplicants(applicants);
    setRecruiters(users);

    logger.info('jazzhr_cache_refreshed', {
      totalApplicants: total,
      uniqueApplicants: unique,
      applicants: applicants.length,
      pagesFetched,
      maxPagesReached,
      excludedApplicants: excluded,
      excludedReasons,
      recruiters: users.length,
    });

    return { refreshed: true, records: applicants.length };
  } catch (err) {
    if (throwOnError) throw err;
    logger.error('jazzhr_cache_refresh_failed', { error: err.message });
    return { refreshed: false, records: 0 };
  }
}

export async function fetchAllApplicants(apiKey, logger, maxPages = 250) {
  const all = [];
  const seenIds = new Set();
  let page = 1;
  const perPage = 100;
  let totalFetched = 0;
  let pagesFetched = 0;
  let duplicatePages = 0;
  const resolvedMaxPages = positiveInteger(maxPages, 250);

  while (page <= resolvedMaxPages) {
    const data = await jazzhrGetWithRetry(applicantListPath(page), apiKey, logger);

    if (!Array.isArray(data) || data.length === 0) break;

    totalFetched += data.length;
    pagesFetched++;
    let newCount = 0;
    for (const item of data) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
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
        break;
      }
    } else {
      duplicatePages = 0;
    }

    if (data.length < perPage) break;
    page++;

    if (page > 1) await sleep(350);
  }

  if (page > resolvedMaxPages) {
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
    maxPagesReached: page > resolvedMaxPages,
  };
}

function applicantListPath(page) {
  return page <= 1 ? '/applicants' : `/applicants/page/${page}`;
}

export function filterActiveApplicants(items) {
  const applicants = [];
  const excludedReasonCounts = {};
  let excluded = 0;

  for (const item of items || []) {
    const inactiveReason = inactiveApplicantReason(item);
    if (inactiveReason) {
      excluded++;
      excludedReasonCounts[inactiveReason] = (excludedReasonCounts[inactiveReason] || 0) + 1;
      continue;
    }
    applicants.push(mapApplicant(item));
  }

  return {
    applicants,
    total: Array.isArray(items) ? items.length : 0,
    excluded,
    excludedReasons: topReasonCounts(excludedReasonCounts),
  };
}

export function inactiveApplicantReason(item) {
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

function applicantStatusValues(item) {
  return collectStatusValues([
    item?.applicant_progress,
    item?.status,
    item?.applicant_status,
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

function mapApplicant(item) {
  return {
    id: `applicant-${item.id}`,
    jazzhrApplicationId: String(item.id),
    firstName: item.first_name || '',
    lastName: item.last_name || '',
    email: item.email || '',
    phone: item.phone || item.prospect_phone || '',
    jobTitle: item.job_title || '',
    stage: item.applicant_progress || '',
    hiringManagerId: '',
    recruiterId: normalizeRecruiterId(item.recruiter_id),
    source: 'jazzhr',
  };
}

function mapApplicantDetail(item) {
  if (!item) return null;

  const resumeUrl = item.resume_link || item.resume || item.resume_url || item.resumeUrl || '';
  const resumeText = item.resume_text || item.resumeText || '';

  return {
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
    jobTitle: item.jobs?.job_title || item.job_title || item.jobTitle || item.title || '',
    stage: item.jobs?.applicant_progress || item.applicant_progress || item.applicantProgress || item.stage || '',
    source: item.source || '',
    rating: item.jobs?.hiring_lead_rating != null ? String(item.jobs.hiring_lead_rating) : (item.jobs?.average_rating != null ? String(item.jobs.average_rating) : ''),
    applyDate: item.apply_date || item.applyDate || item.date_applied || '',
    education: item.education || item.education_summary || '',
    experience: item.experience || item.experience_summary || item.work_history || '',
    linkedinUrl: item.linkedin_url || item.linkedin || item.linkedinUrl || '',
    notes: item.notes || item.internal_notes || (Array.isArray(item.comments) ? '' : item.comments) || '',
  };
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

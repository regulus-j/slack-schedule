import { setApplicants, setRecruiters, getApplicants } from '../data/cache.js';
import { searchApplicants } from '../data/search.js';

const BASE = 'https://api.resumatorapi.com/v1';

export async function searchCachedApplicants(query) {
  return searchApplicants(query, getApplicants());
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
    const [applicants, users] = await Promise.all([
      fetchAllApplicants(apiKey, logger),
      fetchAllUsers(apiKey, logger),
    ]);

    setApplicants(applicants);
    setRecruiters(users);

    logger.info('jazzhr_cache_refreshed', {
      applicants: applicants.length,
      recruiters: users.length,
    });

    return { refreshed: true, records: applicants.length };
  } catch (err) {
    if (throwOnError) throw err;
    logger.error('jazzhr_cache_refresh_failed', { error: err.message });
    return { refreshed: false, records: 0 };
  }
}

async function fetchAllApplicants(apiKey, logger) {
  const all = [];
  const seenIds = new Set();
  let page = 1;
  const perPage = 100;
  const maxPages = 10;

  while (page <= maxPages) {
    const data = await jazzhrGetWithRetry(`/applicants?page=${page}&per_page=${perPage}`, apiKey, logger);

    if (!Array.isArray(data) || data.length === 0) break;

    let newCount = 0;
    for (const item of data) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        all.push(mapApplicant(item));
        newCount++;
      }
    }

    logger.info('jazzhr_applicants_page', { page, count: data.length, new: newCount });

    if (newCount === 0 || data.length < perPage) break;
    page++;

    if (page > 1) await sleep(350);
  }

  return all;
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

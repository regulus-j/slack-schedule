import { SAMPLE_APPLICANTS } from '../data/sample-data.js';
import { searchApplicants } from '../data/search.js';

export async function searchCachedApplicants(query) {
  return searchApplicants(query, SAMPLE_APPLICANTS);
}

export async function refreshJazzhrCache({ config, logger }) {
  if (!config.jazzhr.apiKey) {
    logger.warn('jazzhr_cache_refresh_skipped', { reason: 'missing_api_key' });
    return { refreshed: false, records: SAMPLE_APPLICANTS.length };
  }

  logger.info('jazzhr_cache_refresh_placeholder', {
    message: 'Wire JazzHR read endpoints here once account-specific field mapping is confirmed.',
  });
  return { refreshed: false, records: SAMPLE_APPLICANTS.length };
}

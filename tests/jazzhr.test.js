import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllApplicants, filterActiveApplicants, inactiveApplicantReason } from '../src/services/jazzhr.js';

function applicant(overrides = {}) {
  return {
    id: overrides.id || `id-${Math.random()}`,
    first_name: overrides.first_name || 'Alex',
    last_name: overrides.last_name || 'Reyes',
    email: overrides.email || 'alex@example.com',
    job_title: overrides.job_title || 'Support Specialist',
    ...overrides,
  };
}

test('inactiveApplicantReason detects rejected and inactive applicant fields', () => {
  assert.equal(inactiveApplicantReason(applicant({ applicant_progress: 'Rejected' })), 'rejected');
  assert.equal(inactiveApplicantReason(applicant({ stage: 'Resume Screening - Rejected by Recruiter' })), 'disposition:resume screening rejected by recruiter');
  assert.equal(inactiveApplicantReason(applicant({ status: 'Withdrawn' })), 'withdrawn');
  assert.equal(inactiveApplicantReason(applicant({ disposition: 'Declined' })), 'declined');
  assert.equal(inactiveApplicantReason(applicant({ jobs: { applicant_progress: 'Rejected' } })), 'rejected');
});

test('inactiveApplicantReason keeps active and custom stages', () => {
  for (const stage of ['New', 'Phone Screen', '1st Interview', '2nd Interview', 'Final Interview']) {
    assert.equal(inactiveApplicantReason(applicant({ applicant_progress: stage })), '');
  }
  assert.equal(inactiveApplicantReason(applicant({ workflow_step: 'Hiring Manager Review' })), '');
});

test('inactiveApplicantReason keeps records with missing status fields', () => {
  assert.equal(inactiveApplicantReason(applicant()), '');
});

test('inactiveApplicantReason excludes configured JazzHR not-hired dispositions', () => {
  const dispositions = [
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

  for (const disposition of dispositions) {
    assert.equal(
      inactiveApplicantReason(applicant({ disposition })),
      `disposition:${disposition.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()}`,
    );
  }
});

test('inactiveApplicantReason excludes nested JazzHR job dispositions', () => {
  assert.equal(
    inactiveApplicantReason(applicant({
      jobs: [
        { applicant_progress: 'Phone Screen' },
        { disposition_name: 'Good for Future Hire' },
      ],
    })),
    'disposition:good for future hire',
  );
});

test('filterActiveApplicants excludes inactive applicants and reports reason counts', () => {
  const result = filterActiveApplicants([
    applicant({ id: '1', applicant_progress: 'New', email: 'new@example.com' }),
    applicant({ id: '2', applicant_progress: 'Rejected', email: 'reject@example.com' }),
    applicant({ id: '3', status: 'Withdrawn', email: 'withdraw@example.com' }),
    applicant({ id: '4', disposition: 'Declined', email: 'decline@example.com' }),
    applicant({ id: '5', jobs: { applicant_progress: 'Rejected' }, email: 'nested@example.com' }),
  ]);

  assert.equal(result.total, 5);
  assert.equal(result.excluded, 4);
  assert.deepEqual(result.applicants.map((item) => item.email), ['new@example.com']);
  assert.deepEqual(result.excludedReasons, [
    { reason: 'rejected', count: 2 },
    { reason: 'declined', count: 1 },
    { reason: 'withdrawn', count: 1 },
  ]);
});

test('fetchAllApplicants stops after repeated duplicate pages and dedupes by applicant id', async () => {
  const originalFetch = globalThis.fetch;
  const pages = [
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
  ];
  const requestedPages = [];
  globalThis.fetch = async (url) => {
    const page = requestedApplicantPage(url);
    requestedPages.push(page);
    return {
      ok: true,
      async json() {
        return pages[page - 1] || [];
      },
    };
  };

  try {
    const logger = testLogger();
    const result = await fetchAllApplicants('api-key', logger, 5);
    assert.deepEqual(requestedPages, [1, 2, 3]);
    assert.equal(result.total, 300);
    assert.equal(result.unique, 100);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.maxPagesReached, false);
    assert.equal(result.applicants.length, 100);
    assert.equal(logger.warns[0].event, 'jazzhr_applicants_duplicate_pages_stopped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchAllApplicants tolerates one duplicate page before continuing', async () => {
  const originalFetch = globalThis.fetch;
  const pages = [
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
    [applicant({ id: '101', email: 'a101@example.com', applicant_progress: 'Phone Screen' })],
  ];
  const requestedPages = [];
  globalThis.fetch = async (url) => {
    const page = requestedApplicantPage(url);
    requestedPages.push(page);
    return {
      ok: true,
      async json() {
        return pages[page - 1] || [];
      },
    };
  };

  try {
    const result = await fetchAllApplicants('api-key', testLogger(), 5);
    assert.deepEqual(requestedPages, [1, 2, 3]);
    assert.equal(result.total, 201);
    assert.equal(result.unique, 101);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.maxPagesReached, false);
    assert.equal(result.applicants.length, 101);
    assert.equal(result.applicants.at(-1).email, 'a101@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchAllApplicants logs when applicant page cap is reached', async () => {
  const originalFetch = globalThis.fetch;
  const logger = testLogger();
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1) }));
    },
  });

  try {
    const result = await fetchAllApplicants('api-key', logger, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.maxPagesReached, true);
    assert.equal(result.total, 200);
    assert.equal(result.unique, 100);
    assert.equal(logger.warns[0].event, 'jazzhr_applicants_max_pages_reached');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchAllApplicants uses JazzHR path-based pagination', async () => {
  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  const pages = [
    Array.from({ length: 100 }, (_, index) => applicant({ id: String(index + 1), email: `a${index + 1}@example.com` })),
    [applicant({ id: '101', email: 'screening@example.com', applicant_progress: 'Resume Screening' })],
  ];

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const page = requestedApplicantPage(url);
    requestedPaths.push(parsed.pathname);
    return {
      ok: true,
      async json() {
        return pages[page - 1] || [];
      },
    };
  };

  try {
    const result = await fetchAllApplicants('api-key', testLogger(), 5);
    assert.deepEqual(requestedPaths, ['/v1/applicants', '/v1/applicants/page/2']);
    assert.equal(result.applicants.length, 101);
    assert.equal(result.applicants.at(-1).stage, 'Resume Screening');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function requestedApplicantPage(url) {
  const pathname = new URL(String(url)).pathname;
  const match = pathname.match(/\/applicants\/page\/(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function testLogger() {
  return {
    infos: [],
    warns: [],
    info(event, data) {
      this.infos.push({ event, data });
    },
    warn(event, data) {
      this.warns.push({ event, data });
    },
  };
}

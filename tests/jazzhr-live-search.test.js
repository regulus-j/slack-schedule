import test from 'node:test'
import assert from 'node:assert/strict'
import { createJazzhrLiveSearchManager, fetchApplicantListPage } from '../src/services/jazzhr-live-search.js'

function applicant(id, firstName, lastName, overrides = {}) {
  return {
    id,
    first_name: firstName,
    last_name: lastName,
    email: `${id}@example.com`,
    job_title: 'Support Specialist',
    applied_date: '2026-05-28',
    ...overrides,
  }
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data
    },
    async text() {
      return typeof data === 'string' ? data : JSON.stringify(data)
    },
  }
}

const silentLogger = { info() {}, warn() {} }

test('live search sends candidate name to the applicants endpoint', async () => {
  const requestedUrls = []
  const fetchFn = async (url) => {
    requestedUrls.push(new URL(String(url)))
    return response(200, [applicant('hanah-1', 'Hanah', 'Binwihan')])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 5,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'hanah binwihan', userId: 'U1' })
  const result = await manager.ensurePage(session.id, 0)

  assert.equal(result.resultCount, 1)
  assert.equal(result.results[0].fullName, 'Hanah Binwihan')
  assert.equal(requestedUrls.length, 1)
  assert.equal(requestedUrls[0].pathname, '/v1/applicants')
  assert.equal(requestedUrls[0].searchParams.get('name'), 'hanah binwihan')
})

test('live search scans later JazzHR pages for matching candidates', async () => {
  const requestedUrls = []
  const logger = testLogger()
  const fetchFn = async (url) => {
    const parsed = new URL(String(url))
    requestedUrls.push(parsed)
    if (parsed.pathname.endsWith('/page/2')) {
      return response(200, [applicant('late-1', 'Late', 'Candidate')])
    }
    return response(200, Array.from({ length: 100 }, (_, index) =>
      applicant(`other-${index}`, 'Other', `Person ${index}`),
    ))
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    maxPages: 3,
    logger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'late candidate' })
  const result = await manager.ensurePage(session.id, 0)

  assert.equal(result.resultCount, 1)
  assert.equal(result.results[0].fullName, 'Late Candidate')
  assert.equal(result.complete, true)
  assert.deepEqual(requestedUrls.map((url) => url.pathname), ['/v1/applicants', '/v1/applicants/page/2'])
  assert.deepEqual(requestedUrls.map((url) => url.searchParams.get('name')), ['late candidate', 'late candidate'])
  assert.deepEqual(logger.infos.map((entry) => entry.event), [
    'jazzhr_live_search_page_scanned',
    'jazzhr_live_search_page_scanned',
  ])
})

test('live search stops at configured JazzHR page cap', async () => {
  const requestedUrls = []
  const fetchFn = async (url) => {
    requestedUrls.push(new URL(String(url)))
    return response(200, Array.from({ length: 100 }, (_, index) =>
      applicant(`other-${requestedUrls.length}-${index}`, 'Other', `Person ${index}`),
    ))
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    maxPages: 2,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'missing candidate' })
  const result = await manager.ensurePage(session.id, 0)

  assert.equal(result.resultCount, 0)
  assert.equal(result.complete, true)
  assert.deepEqual(requestedUrls.map((url) => url.pathname), ['/v1/applicants', '/v1/applicants/page/2'])
})

test('live search dedupes candidates by JazzHR id', async () => {
  const fetchFn = async () => response(200, [
    applicant('same-id', 'Alex', 'Reyes', { job_title: 'Role A' }),
    applicant('same-id', 'Alex', 'Reyes', { job_title: 'Role B' }),
    applicant('other-id', 'Alex', 'Santos'),
  ])
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  const result = await manager.ensurePage(session.id, 0)

  assert.deepEqual(result.results.map((item) => item.jazzhrApplicationId), ['same-id', 'other-id'])
})

test('live search paginates matching results twenty at a time', async () => {
  let calls = 0
  const fetchFn = async () => {
    calls++
    if (calls === 1) {
      return response(200, Array.from({ length: 45 }, (_, index) =>
        applicant(`alex-${index}`, 'Alex', `Candidate ${index}`),
      ))
    }
    return response(200, [])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 0)
  const firstPage = manager.getPageCandidates(session.id, 0)
  const secondPage = manager.getPageCandidates(session.id, 1)

  assert.equal(firstPage.length, 20)
  assert.equal(secondPage.length, 20)
  assert.equal(firstPage[0].fullName, 'Alex Candidate 0')
  assert.equal(secondPage[0].fullName, 'Alex Candidate 20')
})

test('live search filters candidates to selected role and recruiter', async () => {
  const fetchFn = async () => response(200, [
    applicant('alex-1', 'Alex', 'One', { job_id: 'job-1', job_title: 'Support', recruiter_id: '123' }),
    applicant('alex-2', 'Alex', 'Two', { job_id: 'job-2', job_title: 'Sales', recruiter_id: '123' }),
    applicant('alex-3', 'Alex', 'Three', { job_id: 'job-1', job_title: 'Support', recruiter_id: '999' }),
  ])
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({
    query: 'alex',
    filters: {
      roleId: 'job-1',
      recruiterIds: ['rec-123'],
    },
  })
  const result = await manager.ensurePage(session.id, 0)

  assert.deepEqual(result.results.map((item) => item.fullName), ['Alex One'])
})

test('live search supports object-form jobs and does not drop missing recruiter metadata', async () => {
  const fetchFn = async () => response(200, [
    applicant('alex-missing', 'Alex', 'Missing', {
      jobs: {
        job_id: 'job-1',
        job_title: 'Support',
        applicant_progress: 'Screen',
      },
    }),
    applicant('alex-match', 'Alex', 'Match', {
      jobs: {
        job_id: 'job-1',
        job_title: 'Support',
        applicant_progress: 'Screen',
        recruiter_email: 'mara@example.com',
      },
    }),
    applicant('alex-other', 'Alex', 'Other', {
      jobs: {
        job_id: 'job-1',
        job_title: 'Support',
        applicant_progress: 'Screen',
        recruiter_email: 'other@example.com',
      },
    }),
  ])
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({
    query: 'alex',
    filters: {
      roleId: 'job-1',
      recruiterIds: ['rec-sheet-mara'],
      recruiterEmails: ['mara@example.com'],
    },
  })
  const result = await manager.ensurePage(session.id, 0)

  assert.deepEqual(result.results.map((item) => item.fullName), ['Alex Missing', 'Alex Match'])
})

test('live search excludes rejected candidates without excluding screening', async () => {
  const fetchFn = async () => response(200, [
    applicant('alex-1', 'Alex', 'Screening', { job_id: 'job-1', applicant_progress: 'Resume Screening' }),
    applicant('alex-2', 'Alex', 'Rejected', { job_id: 'job-1', disposition: 'Good for Future Hire' }),
  ])
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({
    query: 'alex',
    filters: { roleId: 'job-1' },
  })
  const result = await manager.ensurePage(session.id, 0)

  assert.deepEqual(result.results.map((item) => item.fullName), ['Alex Screening'])
})

test('next page uses already collected live session results', async () => {
  const requestedUrls = []
  const fetchFn = async (url) => {
    requestedUrls.push(new URL(String(url)))
    return response(200, [
      applicant('alex-1', 'Alex', 'One'),
      applicant('alex-2', 'Alex', 'Two'),
    ])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 1,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 0)
  await manager.ensurePage(session.id, 1)

  assert.deepEqual(manager.getPageCandidates(session.id, 1).map((item) => item.fullName), ['Alex Two'])
  assert.equal(requestedUrls.length, 1)
})

test('previous page uses already collected live session results', async () => {
  let calls = 0
  const fetchFn = async () => {
    calls++
    if (calls === 1) {
      return response(200, [
        applicant('alex-1', 'Alex', 'One'),
        applicant('alex-2', 'Alex', 'Two'),
      ])
    }
    return response(200, [])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 1,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 1)
  const firstPage = manager.getPageCandidates(session.id, 0)

  assert.equal(firstPage[0].fullName, 'Alex One')
  assert.equal(calls, 1)
})

test('live search coalesces concurrent page requests for one session', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const fetchFn = async (url) => {
    calls++
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return response(200, [
      applicant('alex-1', 'Alex', 'One'),
      applicant('alex-2', 'Alex', 'Two'),
    ])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 2,
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await Promise.all([
    manager.ensurePage(session.id, 0),
    manager.ensurePage(session.id, 1),
  ])

  assert.equal(calls, 1)
  assert.equal(maxActive, 1)
  assert.equal(manager.maxObservedActiveRequests, 1)
})

test('live search retries 429 responses with backoff', async () => {
  const statuses = [429, 200]
  const delays = []
  const result = await fetchApplicantListPage({
    apiKey: 'api-key',
    page: 1,
    fetchFn: async () => response(statuses.shift(), [applicant('alex-1', 'Alex', 'One')]),
    sleepFn: async (delay) => delays.push(delay),
    logger: { warn() {} },
  })

  assert.equal(result.items.length, 1)
  assert.deepEqual(delays, [1000])
})

test('live search includes query params on path-paginated applicant requests', async () => {
  const requestedUrls = []
  await fetchApplicantListPage({
    apiKey: 'api-key',
    page: 3,
    query: 'alex',
    fetchFn: async (url) => {
      requestedUrls.push(new URL(String(url)))
      return response(200, [])
    },
    sleepFn: async () => {},
  })

  assert.equal(requestedUrls[0].pathname, '/v1/applicants/page/3')
  assert.equal(requestedUrls[0].searchParams.get('name'), 'alex')
})

test('live search sessions expire and stale versions can be detected', async () => {
  let currentTime = 1000
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    ttlMs: 100,
    now: () => currentTime,
    logger: silentLogger,
    fetchFn: async () => response(200, []),
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  assert.equal(manager.isCurrent(session.id, session.version), true)
  await manager.ensurePage(session.id, 0)
  assert.equal(manager.isCurrent(session.id, session.version), false)
  currentTime = 1200
  manager.expire()
  assert.equal(manager.get(session.id), null)
})

function testLogger() {
  return {
    infos: [],
    warns: [],
    info(event, data) {
      this.infos.push({ event, data })
    },
    warn(event, data) {
      this.warns.push({ event, data })
    },
  }
}

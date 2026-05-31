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

function pageFromUrl(url) {
  const pathname = new URL(String(url)).pathname
  const match = pathname.match(/\/applicants\/page\/(\d+)$/)
  return match ? Number(match[1]) : 1
}

test('live search finds candidates beyond page 250', async () => {
  const requestedPages = []
  const fetchFn = async (url) => {
    const page = pageFromUrl(url)
    requestedPages.push(page)
    if (page === 251) return response(200, [applicant('hanah-1', 'Hanah', 'Binwihan')])
    return response(200, [applicant(`other-${page}`, 'Other', `Candidate ${page}`)])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 5,
    maxPages: 260,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'hanah binwihan', userId: 'U1' })
  const result = await manager.ensurePage(session.id, 0)

  assert.equal(result.resultCount, 1)
  assert.equal(result.results[0].fullName, 'Hanah Binwihan')
  assert.ok(requestedPages.includes(251))
})

test('live search dedupes candidates by JazzHR id', async () => {
  const fetchFn = async (url) => {
    const page = pageFromUrl(url)
    if (page === 1) {
      return response(200, [
        applicant('same-id', 'Alex', 'Reyes', { job_title: 'Role A' }),
        applicant('same-id', 'Alex', 'Reyes', { job_title: 'Role B' }),
        applicant('other-id', 'Alex', 'Santos'),
      ])
    }
    return response(200, [])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 20,
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

test('next page continues scanning from the previous JazzHR cursor', async () => {
  const requestedPages = []
  const fetchFn = async (url) => {
    const page = pageFromUrl(url)
    requestedPages.push(page)
    if (page === 1) return response(200, [applicant('alex-1', 'Alex', 'One')])
    if (page === 2) return response(200, [applicant('other-2', 'Other', 'Two')])
    if (page === 3) return response(200, [applicant('alex-3', 'Alex', 'Three')])
    return response(200, [])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 1,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 0)
  await manager.ensurePage(session.id, 1)

  assert.deepEqual(manager.getPageCandidates(session.id, 1).map((item) => item.fullName), ['Alex Three'])
  assert.deepEqual(requestedPages, [1, 2, 3])
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
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 1)
  const firstPage = manager.getPageCandidates(session.id, 0)

  assert.equal(firstPage[0].fullName, 'Alex One')
  assert.equal(calls, 1)
})

test('live search respects configured request concurrency', async () => {
  let active = 0
  let maxActive = 0
  const fetchFn = async (url) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    const page = pageFromUrl(url)
    if (page === 5) return response(200, [applicant('alex-5', 'Alex', 'Five')])
    return response(200, [applicant(`other-${page}`, 'Other', `Candidate ${page}`)])
  }
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    pageSize: 1,
    concurrency: 2,
    maxPages: 5,
    fetchFn,
    sleepFn: async () => {},
  })

  const session = manager.start({ query: 'alex' })
  await manager.ensurePage(session.id, 0)

  assert.equal(maxActive, 2)
  assert.equal(manager.maxObservedActiveRequests, 2)
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

test('live search sessions expire and stale versions can be detected', async () => {
  let currentTime = 1000
  const manager = createJazzhrLiveSearchManager({
    apiKey: 'api-key',
    ttlMs: 100,
    now: () => currentTime,
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

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkAvailability,
  partitionAvailabilityAttendees,
} from '../src/workflow/scheduler.js'

test('partitions managers to Apps Script and only recruiters and guests to OAuth', () => {
  const result = partitionAvailabilityAttendees([
    attendee('candidate', 'candidate@example.com'),
    attendee('recruiter', 'recruiter@example.com'),
    attendee('hiring_manager', 'manager@example.com'),
    attendee('guest', 'guest@example.com'),
    attendee('external', 'external@example.com'),
    attendee('recipient', 'recipient@example.com'),
    { ...attendee('guest', 'external-guest@example.com'), source: 'external' },
  ])

  assert.deepEqual(result.hiringManagers.map((item) => item.email), ['manager@example.com'])
  assert.deepEqual(result.oauthAttendees.map((item) => item.email), [
    'recruiter@example.com',
    'guest@example.com',
  ])
})

test('checks multiple managers in one Apps Script request and excludes external attendees', async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).searchParams.get('token'), 'token')
    requestBody = JSON.parse(options.body)
    return jsonResponse({
      ok: true,
      calendars: {
        'manager.one@example.com': {
          busy: [{ start: '2099-06-15T01:00:00Z', end: '2099-06-15T02:00:00Z' }],
        },
        'manager.two@example.com': { busy: [] },
      },
      errors: {},
    })
  }

  try {
    const result = await checkAvailability({
      caseRecord: {
        id: 'case-routing',
        interviewWindowStartDate: '2099-06-15',
        interviewWindowEndDate: '2099-06-16',
        interviewTimezone: 'Australia/Sydney',
        attendees: [
          attendee('candidate', 'candidate@example.com'),
          attendee('recruiter', 'recruiter@example.com'),
          attendee('hiring_manager', 'manager.one@example.com', 'Manager One'),
          attendee('hiring_manager', 'manager.two@example.com', 'Manager Two'),
          attendee('external', 'external@example.com'),
          attendee('recipient', 'recipient@example.com'),
        ],
      },
      config: {
        google: {},
        hiringManagerAvailability: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'token',
        },
      },
      logger: silentLogger(),
      store: {},
    })

    assert.deepEqual(requestBody.attendees, [
      { email: 'manager.one@example.com' },
      { email: 'manager.two@example.com' },
    ])
    assert.deepEqual(Object.keys(result.busyByEmail), [
      'manager.one@example.com',
      'manager.two@example.com',
    ])
    assert.equal(result.managerCount, 2)
    assert.deepEqual(result.sources, ['apps_script_hm', 'google_oauth'])
    assert.equal(result.mocked, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('manager lookup failure blocks availability instead of returning mocked slots', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    calendars: {},
    errors: { 'manager@example.com': { reason: 'notFound' } },
  })

  try {
    await assert.rejects(
      checkAvailability({
        caseRecord: {
          id: 'case-failure',
          interviewWindowStartDate: '2099-06-15',
          interviewWindowEndDate: '2099-06-16',
          interviewTimezone: 'Australia/Sydney',
          attendees: [
            attendee('recruiter', 'recruiter@example.com'),
            attendee('hiring_manager', 'manager@example.com', 'Unavailable Manager'),
          ],
        },
        config: {
          google: {},
          hiringManagerAvailability: {
            url: 'https://script.google.com/macros/s/demo/exec',
            token: 'token',
          },
        },
        logger: silentLogger(),
        store: {},
      }),
      (error) => error.code === 'hm_availability_incomplete' &&
        error.managerNames.includes('Unavailable Manager')
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('custom invite recipients do not invoke either availability provider', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called')
  }

  try {
    const result = await checkAvailability({
      caseRecord: {
        id: 'custom-invite',
        attendees: [attendee('recipient', 'recipient@example.com')],
      },
      config: {},
      logger: silentLogger(),
      store: {},
    })
    assert.deepEqual(result.busyByEmail, {})
    assert.deepEqual(result.sources, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

function attendee(role, email, name = email) {
  return { role, email, name, included: true }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload
    },
  }
}

function silentLogger() {
  return {
    info() {},
    warn() {},
  }
}

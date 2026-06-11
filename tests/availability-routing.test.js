import test from 'node:test'
import assert from 'node:assert/strict'

import { checkAvailability } from '../src/workflow/scheduler.js'

test('hiring-manager-only availability does not call a calendar provider', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('calendar provider should not be called')
  }

  try {
    const result = await checkAvailability({
      caseRecord: {
        id: 'case-hm-only',
        interviewWindowStartDate: '2099-06-15',
        interviewWindowEndDate: '2099-06-16',
        interviewTimezone: 'Australia/Sydney',
        attendees: [
          attendee('hiring_manager', 'manager@example.com', 'Manager One'),
        ],
      },
      config: {},
      logger: silentLogger(),
      store: {},
    })

    assert.deepEqual(result.busyByEmail, {})
    assert.deepEqual(result.sources, [])
    assert.equal(result.mocked, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Google free-busy checks recruiters but excludes hiring managers', async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /calendar\/v3\/freeBusy/)
    requestBody = JSON.parse(options.body)
    return jsonResponse({
      calendars: {
        'recruiter@example.com': {
          busy: [{ start: '2099-06-15T01:00:00Z', end: '2099-06-15T02:00:00Z' }],
        },
      },
    })
  }

  try {
    const result = await checkAvailability({
      caseRecord: {
        id: 'case-routing',
        ownerSlackUserId: 'UOWNER',
        interviewWindowStartDate: '2099-06-15',
        interviewWindowEndDate: '2099-06-16',
        interviewTimezone: 'Australia/Sydney',
        attendees: [
          attendee('candidate', 'candidate@example.com'),
          attendee('recruiter', 'recruiter@example.com'),
          attendee('hiring_manager', 'manager@example.com', 'Manager One'),
          attendee('guest', 'guest@example.com'),
          { ...attendee('guest', 'external-guest@example.com'), source: 'external' },
        ],
      },
      config: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://example.com/oauth',
          sharedCalendarId: 'calendar@example.com',
        },
      },
      logger: silentLogger(),
      store: {
        async getGoogleToken() {
          return {
            access_token: 'access-token',
            expiry_date: Date.now() + 60 * 60 * 1000,
          }
        },
      },
    })

    assert.deepEqual(requestBody.items, [
      { id: 'recruiter@example.com' },
      { id: 'guest@example.com' },
    ])
    assert.deepEqual(Object.keys(result.busyByEmail), ['recruiter@example.com'])
    assert.deepEqual(result.sources, ['google_oauth'])
    assert.equal(result.mocked, false)
    assert.equal('managerCount' in result, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('custom invite recipients do not invoke calendar availability', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('calendar provider should not be called')
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

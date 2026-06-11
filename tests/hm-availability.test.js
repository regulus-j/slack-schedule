import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkHiringManagerAvailability,
  HiringManagerAvailabilityError,
} from '../src/services/hm-availability.js'

const config = {
  hiringManagerAvailability: {
    url: 'https://script.google.com/macros/s/demo/exec',
    token: 'secret-token',
  },
}

const attendees = [
  { name: 'Alex Manager', email: ' Alex@Example.com ' },
  { name: 'Bea Manager', email: 'bea@example.com' },
]

const windows = [{
  timeMin: '2026-06-15T00:00:00.000Z',
  timeMax: '2026-06-16T00:00:00.000Z',
}]

test('batches normalized hiring managers and returns busy periods by email', async () => {
  let request
  const result = await checkHiringManagerAvailability({
    config,
    logger: silentLogger(),
    attendees,
    windows,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options }
      return jsonResponse({
        ok: true,
        calendars: {
          'alex@example.com': {
            busy: [{ start: '2026-06-15T01:00:00Z', end: '2026-06-15T02:00:00Z' }],
          },
          'BEA@example.com': { busy: [] },
        },
        errors: {},
      })
    },
  })

  const body = JSON.parse(request.options.body)
  assert.equal(new URL(request.url).searchParams.get('token'), 'secret-token')
  assert.deepEqual(body.attendees, [
    { email: 'alex@example.com' },
    { email: 'bea@example.com' },
  ])
  assert.equal(result.busyByEmail['alex@example.com'][0].start, '2026-06-15T01:00:00.000Z')
  assert.deepEqual(result.busyByEmail['bea@example.com'], [])
})

test('rejects incomplete calendar coverage and identifies affected managers', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config,
      logger: silentLogger(),
      attendees,
      windows,
      fetchImpl: async () => jsonResponse({
        ok: true,
        calendars: { 'alex@example.com': { busy: [] } },
        errors: { 'bea@example.com': { reason: 'notFound' } },
      }),
    }),
    (error) => {
      assert.ok(error instanceof HiringManagerAvailabilityError)
      assert.equal(error.code, 'hm_availability_incomplete')
      assert.deepEqual(error.managerNames, ['Bea Manager'])
      return true
    }
  )
})

test('rejects malformed responses', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config,
      logger: silentLogger(),
      attendees: attendees.slice(0, 1),
      windows,
      fetchImpl: async () => jsonResponse({ ok: true, calendars: [] }),
    }),
    (error) => error.code === 'hm_availability_service_error'
  )
})

test('rejects timed out requests', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config,
      logger: silentLogger(),
      attendees: attendees.slice(0, 1),
      windows,
      fetchImpl: async () => {
        const error = new Error('timed out')
        error.name = 'TimeoutError'
        throw error
      },
    }),
    (error) => error.code === 'hm_availability_request_failed' && /timed out/.test(error.message)
  )
})

test('requires configured Apps Script credentials when managers are selected', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config: {},
      logger: silentLogger(),
      attendees: attendees.slice(0, 1),
      windows,
    }),
    (error) => error.code === 'hm_availability_not_configured'
  )
})

test('rejects an invalid Apps Script URL as a blocking configuration error', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config: {
        hiringManagerAvailability: {
          url: 'not a url',
          token: 'token',
        },
      },
      logger: silentLogger(),
      attendees: attendees.slice(0, 1),
      windows,
    }),
    (error) => error.code === 'hm_availability_not_configured'
  )
})

test('rejects non-JSON Apps Script responses', async () => {
  await assert.rejects(
    checkHiringManagerAvailability({
      config,
      logger: silentLogger(),
      attendees: attendees.slice(0, 1),
      windows,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('invalid json')
        },
      }),
    }),
    (error) => error.code === 'hm_availability_invalid_response'
  )
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
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

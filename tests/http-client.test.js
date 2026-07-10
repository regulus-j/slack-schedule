import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout } from '../src/services/http-client.js'

test('fetchWithTimeout keeps timeout protection when caller supplies a signal', async () => {
  const callerController = new AbortController()
  const started = Date.now()
  const keepAlive = setInterval(() => {}, 1000)

  try {
    await assert.rejects(
      fetchWithTimeout('https://example.test/hangs', { signal: callerController.signal }, {
        timeoutMs: 10,
        retries: 0,
        fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        }),
      }),
      (error) => {
        assert.equal(error.code, 'HTTP_TIMEOUT')
        return true
      },
    )
  } finally {
    clearInterval(keepAlive)
  }

  assert.ok(Date.now() - started < 1000)
  assert.equal(callerController.signal.aborted, false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { logger, redact } from '../src/logger.js'
import { createSlackAlertDispatcher } from '../src/observability/slack-alerts.js'

test('logger redaction drops case PII fields and sanitizes credentials and newlines', () => {
  const result = redact({
    caseId: 'case-1',
    candidateName: 'Real Candidate',
    error: 'failed for person@example.com\nxoxb-secret-value',
    authorization: 'Bearer secret',
  })
  assert.equal(result.caseId, 'case-1')
  assert.equal(result.candidateName, undefined)
  assert.match(result.error, /\[redacted-email\]/)
  assert.match(result.error, /\[redacted-token\]/)
  assert.doesNotMatch(result.error, /\n/)
  assert.equal(result.authorization, undefined)
})

test('Slack alert dispatcher thresholds warnings and immediately sends errors', async () => {
  const messages = []
  const dispatcher = createSlackAlertDispatcher({
    client: {
      conversations: {
        async open({ users }) {
          return { channel: { id: `D-${users}` } }
        },
      },
      chat: {
        async postMessage(message) {
          messages.push(message)
        },
      },
    },
    config: {
      security: { alertUserIds: ['UONE'] },
      alerting: {
        warningThreshold: 3,
        warningWindowMs: 300000,
        cooldownMs: 900000,
      },
    },
  })

  await dispatcher({ level: 'warn', event: 'repeat_warning', details: {} })
  await dispatcher({ level: 'warn', event: 'repeat_warning', details: {} })
  assert.equal(messages.length, 0)
  await dispatcher({ level: 'warn', event: 'repeat_warning', details: {} })
  assert.equal(messages.length, 1)
  await dispatcher({ level: 'error', event: 'new_error', details: { correlationId: 'ref-1' } })
  assert.equal(messages.length, 2)
})

test.after(() => {
  logger.setAlertDispatcher(null)
})

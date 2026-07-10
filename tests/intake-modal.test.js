import test from 'node:test'
import assert from 'node:assert/strict'

import { refreshIntakeModal, hasCheckboxSelection } from '../src/slack/handlers.js'

function buildBody({ id = 'v1', hash = 'h1', privateMetadata = '' } = {}) {
  return {
    view: {
      id,
      hash,
      private_metadata: privateMetadata,
      state: { values: {} },
    },
    channel: { id: 'C1' },
    user: { id: 'U1' },
  }
}

function noOpLogger() {
  const calls = { info: [], error: [], warn: [] }
  return {
    calls,
    info: (event, details) => calls.info.push({ event, details }),
    error: (event, details) => calls.error.push({ event, details }),
    warn: (event, details) => calls.warn.push({ event, details }),
  }
}

test('refreshIntakeModal recovers from a Slack hash_conflict and retries with the fresh view', async () => {
  const logger = noOpLogger()
  const updateCalls = []
  const client = {
    views: {
      update: async (params) => {
        updateCalls.push(params)
        if (updateCalls.length === 1) {
          const err = new Error('hash_conflict')
          err.data = {
            error: 'hash_conflict',
            view: { id: 'v1-fresh', hash: 'h1-fresh' },
          }
          throw err
        }
        return { view: { id: params.view_id, hash: params.hash } }
      },
    },
  }

  const result = await refreshIntakeModal({
    client,
    body: buildBody(),
    templates: [],
    timeZones: [],
    defaultTimeZone: 'Australia/Sydney',
    logger,
  })

  assert.equal(updateCalls.length, 2, 'views.update should be called twice (initial + retry)')
  // Initial call uses the stale hash from the body.
  assert.equal(updateCalls[0].view_id, 'v1')
  assert.equal(updateCalls[0].hash, 'h1')
  // Retry uses the fresh view id/hash returned by Slack.
  assert.equal(updateCalls[1].view_id, 'v1-fresh')
  assert.equal(updateCalls[1].hash, 'h1-fresh')
  assert.deepEqual(result, { view: { id: 'v1-fresh', hash: 'h1-fresh' } })
  assert.ok(
    logger.calls.info.some((entry) => entry.event === 'intake_modal_hash_conflict_recovered'),
    'should log the hash_conflict recovery',
  )
})

test('refreshIntakeModal logs intake_modal_update_failed and rethrows on a non-recoverable views.update error', async () => {
  const logger = noOpLogger()
  const updateCalls = []
  const client = {
    views: {
      update: async (params) => {
        updateCalls.push(params)
        const err = new Error('invalid_blocks')
        err.data = { error: 'invalid_blocks' }
        throw err
      },
    },
  }

  await assert.rejects(
    refreshIntakeModal({
      client,
      body: buildBody(),
      templates: [],
      timeZones: [],
      defaultTimeZone: 'Australia/Sydney',
      logger,
    }),
  )

  assert.equal(updateCalls.length, 1, 'should not retry a non-hash_conflict error')
  const failure = logger.calls.error.find((entry) => entry.event === 'intake_modal_update_failed')
  assert.ok(failure, 'should log intake_modal_update_failed')
  assert.equal(failure.details.slackError, 'invalid_blocks')
  assert.ok(failure.details.correlationId, 'should include a correlationId reference')
})

test('hasCheckboxSelection returns false when values is empty', () => {
  assert.equal(hasCheckboxSelection({}, 'test_checkboxes'), false)
  assert.equal(hasCheckboxSelection(null, 'test_checkboxes'), false)
})

test('hasCheckboxSelection returns false when selected_options is an empty array (autofill bug scenario)', () => {
  const values = {
    test_block: {
      test_checkboxes: { type: 'checkboxes', selected_options: [] },
    },
  }
  assert.equal(hasCheckboxSelection(values, 'test_checkboxes'), false)
})

test('hasCheckboxSelection returns false when checkbox element is missing entirely', () => {
  const values = {
    test_block: {
      some_other_element: { type: 'plain_text_input', value: 'hello' },
    },
  }
  assert.equal(hasCheckboxSelection(values, 'test_checkboxes'), false)
})

test('hasCheckboxSelection returns true when selected_options has actual values', () => {
  const values = {
    test_block: {
      test_checkboxes: { type: 'checkboxes', selected_options: [{ value: 'id1' }, { value: 'id2' }] },
    },
  }
  assert.equal(hasCheckboxSelection(values, 'test_checkboxes'), true)
})

test('hasCheckboxSelection returns true with a single selected option', () => {
  const values = {
    hm_block: {
      hiring_manager_checkboxes: { type: 'checkboxes', selected_options: [{ value: 'hm-1' }] },
    },
  }
  assert.equal(hasCheckboxSelection(values, 'hiring_manager_checkboxes'), true)
})

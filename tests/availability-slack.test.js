import test from 'node:test'
import assert from 'node:assert/strict'

import { registerSlackHandlers } from '../src/slack/handlers.js'
import {
  availabilityCheckErrorModal,
  checkingAvailabilityModal,
} from '../src/slack/views.js'

test('availability loading view shows an ongoing request indicator', () => {
  const view = checkingAvailabilityModal({
    applicant: { firstName: 'Test', lastName: 'Candidate' },
  })
  assert.match(JSON.stringify(view.blocks), /hourglass_flowing_sand/)
})

test('availability error view shows no scheduling slots', () => {
  const view = availabilityCheckErrorModal(
    { applicant: { firstName: 'Test', lastName: 'Candidate' } },
    'Could not verify availability for Manager One.'
  )
  assert.equal(view.submit, undefined)
  assert.match(JSON.stringify(view.blocks), /No scheduling slots were shown/)
  assert.match(JSON.stringify(view.blocks), /Manager One/)
})

test('Slack scheduling blocks and persists a failed manager availability check', async () => {
  const views = new Map()
  const app = {
    action() {},
    command() {},
    event() {},
    message() {},
    options() {},
    view(id, handler) {
      views.set(id, handler)
    },
  }

  let caseRecord = {
    id: 'case-hm-failure',
    status: 'Draft',
    ownerSlackUserId: 'U1',
    applicant: {
      id: 'candidate-1',
      firstName: 'Test',
      lastName: 'Candidate',
      email: 'candidate@example.com',
    },
    recruiter: {
      id: 'recruiter-1',
      name: 'Recruiter One',
      email: 'recruiter@example.com',
    },
    hiringManager: {
      id: 'manager-1',
      name: 'Manager One',
      email: 'manager@example.com',
    },
    attendanceOverrides: { hiringManagerIncluded: true },
    externalAttendees: [],
    stageKey: '2nd-interview',
    stageOverrides: {},
    interviewTimezone: 'Australia/Sydney',
  }
  const updates = []
  const store = {
    async getCase(id) {
      return id === caseRecord.id ? caseRecord : null
    },
    async updateCase(id, patch) {
      assert.equal(id, caseRecord.id)
      updates.push(patch)
      caseRecord = { ...caseRecord, ...patch }
      return caseRecord
    },
  }

  registerSlackHandlers(app, {
    config: {
      slack: {},
      google: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
      hiringManagerAvailability: {
        url: 'https://script.google.com/macros/s/demo/exec',
        token: 'token',
      },
      jazzhr: { liveSearch: {} },
    },
    store,
    logger: silentLogger(),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        calendars: {},
        errors: { 'manager@example.com': { reason: 'notFound' } },
      }
    },
  })

  const acknowledgements = []
  const modalUpdates = []
  try {
    await views.get('scheduling_phase_one')({
      ack: async (payload) => acknowledgements.push(payload),
      body: {
        user: { id: 'U1' },
        view: { id: 'V1' },
      },
      view: {
        private_metadata: JSON.stringify({ caseId: caseRecord.id, stageKey: '2nd-interview' }),
        state: {
          values: {
            stage_block: {
              stage_select: { selected_option: { value: '2nd-interview' } },
            },
            attendee_toggle_block: {
              attendee_toggle: {
                selected_options: [
                  { value: 'candidate@example.com' },
                  { value: 'recruiter@example.com' },
                  { value: 'manager@example.com' },
                ],
              },
            },
            schedule_window_start_block: {
              schedule_window_start: { selected_date: '2099-06-15' },
            },
            schedule_window_end_block: {
              schedule_window_end: { selected_date: '2099-06-16' },
            },
            duration_block: {
              duration_select: { selected_option: { value: '45' } },
            },
          },
        },
      },
      client: {
        views: {
          async update(payload) {
            modalUpdates.push(payload)
          },
        },
        chat: {
          async postEphemeral() {
            throw new Error('error modal should be updated directly')
          },
        },
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(acknowledgements.length, 1)
  assert.match(JSON.stringify(acknowledgements[0]), /hourglass_flowing_sand/)
  assert.equal(modalUpdates.length, 1)
  assert.match(JSON.stringify(modalUpdates[0].view.blocks), /Manager One/)
  const failure = updates.find((patch) => patch.lastAvailabilityCheck?.status === 'failed')
  assert.equal(failure.lastAvailabilityCheck.failureCode, 'hm_availability_incomplete')
  assert.equal(failure.lastAvailabilityCheck.managerCount, 1)
})

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

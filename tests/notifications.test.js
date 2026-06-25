import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/store/json-store.js'
import {
  deliverNotification,
  hasJazzhrStatusChanged,
  markCaseComplete,
  notificationSchedule,
  NOTIFICATION_TYPES,
  scheduleCaseNotifications,
} from '../src/workflow/notifications.js'
import { buildFeedbackRequestEmail, buildReminderEmail } from '../src/workflow/messages.js'

function scheduledCase(overrides = {}) {
  return {
    id: 'case-1',
    status: 'Scheduled',
    ownerSlackUserId: 'UOWNER',
    applicant: {
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support Specialist',
      jazzhrApplicationId: 'app-1',
      jazzhrJobId: 'job-1',
      stage: '1st Interview',
      workflowStepId: 'step-1',
      workflowStep: '1st Interview',
    },
    recruiter: {
      name: 'Recruiter',
      email: 'recruiter@example.com',
      slackUserId: 'URECRUITER',
    },
    stageKey: '1st-interview',
    scheduleVersion: 1,
    interviewTimezone: 'America/New_York',
    currentSchedule: {
      date: '2026-11-02',
      time: '10:00',
      durationMinutes: 30,
      zoomLink: 'https://zoom.example/1',
    },
    ...overrides,
  }
}

test('schedules the prior-calendar-day 9 AM reminder and post-finish DM across DST', () => {
  const jobs = notificationSchedule(
    scheduledCase(),
    new Date('2026-10-30T12:00:00.000Z'),
  )
  const reminder = jobs.find((job) => job.type === NOTIFICATION_TYPES.CANDIDATE_REMINDER)
  const completion = jobs.find((job) => job.type === NOTIFICATION_TYPES.COMPLETION_REMINDER)

  assert.equal(reminder.dueAt, '2026-11-01T14:00:00.000Z')
  assert.equal(completion.dueAt, '2026-11-02T15:45:00.000Z')
})

test('late scheduling sends the candidate reminder immediately before the interview', () => {
  const now = new Date('2026-11-01T16:00:00.000Z')
  const jobs = notificationSchedule(scheduledCase(), now)
  assert.equal(
    jobs.find((job) => job.type === NOTIFICATION_TYPES.CANDIDATE_REMINDER).dueAt,
    now.toISOString(),
  )
})

test('job offers schedule completion follow-up but no preparation reminder', () => {
  const jobs = notificationSchedule(
    scheduledCase({ stageKey: 'job-offer-discussion' }),
    new Date('2026-10-30T12:00:00.000Z'),
  )
  assert.deepEqual(jobs.map((job) => job.type), [NOTIFICATION_TYPES.COMPLETION_REMINDER])
})

test('JazzHR comparison detects normalized workflow changes', () => {
  assert.equal(hasJazzhrStatusChanged(
    { stage: '1st Interview', workflowStepId: '1' },
    { stage: '1st Interview', workflowStepId: '1' },
  ), false)
  assert.equal(hasJazzhrStatusChanged(
    { stage: '1st Interview', workflowStepId: '1' },
    { stage: 'Completed 1st Interview', workflowStepId: '2' },
  ), true)
})

test('reminder and feedback templates contain required candidate copy', () => {
  const caseRecord = scheduledCase()
  const reminder = buildReminderEmail(caseRecord)
  const feedback = buildFeedbackRequestEmail(caseRecord, 'https://example.com/feedback')

  for (const phrase of [
    'Review the job description',
    'Test your internet connection',
    'quiet, professional, and distraction-free',
    '5-10 minutes early',
    'discuss your experience',
    'thoughtful questions',
  ]) {
    assert.match(reminder.htmlBody, new RegExp(phrase))
    assert.match(reminder.plainBody, new RegExp(phrase))
  }
  assert.match(feedback.htmlBody, /https:\/\/example\.com\/feedback/)
  assert.match(feedback.plainBody, /Alex/)
  assert.match(feedback.plainBody, /Support Specialist/)
})

test('rescheduling cancels old-version jobs and keeps one job per new version', async () => {
  const fixture = await createStoreFixture()
  try {
    const first = await fixture.store.createCase(scheduledCase())
    await scheduleCaseNotifications({
      store: fixture.store,
      caseRecord: first,
      now: new Date('2026-10-30T12:00:00.000Z'),
    })
    const second = await fixture.store.updateCase(first.id, {
      scheduleVersion: 2,
      currentSchedule: {
        ...first.currentSchedule,
        date: '2026-11-03',
      },
    })
    await scheduleCaseNotifications({
      store: fixture.store,
      caseRecord: second,
      now: new Date('2026-10-30T12:00:00.000Z'),
    })

    await setTimeout(500) // wait for debounced json-store flush
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    const oldJobs = state.notificationJobs.filter((job) => job.scheduleVersion === 1)
    const newJobs = state.notificationJobs.filter((job) => job.scheduleVersion === 2)
    assert.ok(oldJobs.every((job) => job.status === 'cancelled'))
    assert.equal(newJobs.length, 2)
    assert.ok(newJobs.every((job) => job.status === 'pending'))
  } finally {
    await fixture.cleanup()
  }
})

test('completion is idempotent and queues exactly one feedback job', async () => {
  const fixture = await createStoreFixture()
  try {
    const caseRecord = await fixture.store.createCase(scheduledCase())
    const first = await markCaseComplete({
      store: fixture.store,
      caseId: caseRecord.id,
      actorSlackUserId: 'URECRUITER',
      now: new Date('2026-11-02T16:00:00.000Z'),
    })
    const second = await markCaseComplete({
      store: fixture.store,
      caseId: caseRecord.id,
      actorSlackUserId: 'URECRUITER',
      now: new Date('2026-11-02T16:01:00.000Z'),
    })

    assert.equal(first.alreadyCompleted, false)
    assert.equal(second.alreadyCompleted, true)
    await setTimeout(500) // wait for debounced json-store flush
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    assert.equal(state.notificationJobs.filter((job) => job.type === NOTIFICATION_TYPES.FEEDBACK_REQUEST).length, 1)
    assert.equal(state.cases[0].status, 'Completed')
  } finally {
    await fixture.cleanup()
  }
})

test('stale completion does not complete a rescheduled case or queue feedback', async () => {
  const fixture = await createStoreFixture()
  try {
    const caseRecord = await fixture.store.createCase(scheduledCase({ scheduleVersion: 2 }))
    const result = await markCaseComplete({
      store: fixture.store,
      caseId: caseRecord.id,
      actorSlackUserId: 'URECRUITER',
      scheduleVersion: 1,
      now: new Date('2026-11-02T16:00:00.000Z'),
    })

    assert.equal(result.stale, true)
    await setTimeout(500) // wait for debounced json-store flush
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    assert.equal(state.cases[0].status, 'Scheduled')
    assert.equal(state.notificationJobs.length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('completion DM reports unchanged JazzHR and schedules one next-day recheck', async () => {
  const fixture = await createStoreFixture()
  const messages = []
  try {
    const caseRecord = await fixture.store.createCase(scheduledCase())
    await deliverNotification({
      type: NOTIFICATION_TYPES.COMPLETION_REMINDER,
      job: { caseId: caseRecord.id, scheduleVersion: 1 },
      store: fixture.store,
      client: {
        conversations: { open: async () => ({ channel: { id: 'D1' } }) },
        chat: { postMessage: async (message) => messages.push(message) },
      },
      config: { jazzhr: { apiKey: 'key' } },
      logger: { warn() {} },
      now: new Date('2026-11-02T16:00:00.000Z'),
      fetchApplicantDetailImpl: async () => ({
        stage: '1st Interview',
        workflowStepId: 'step-1',
        workflowStep: '1st Interview',
      }),
    })

    assert.equal(messages.length, 1)
    assert.match(JSON.stringify(messages[0]), /still shows/)
    await setTimeout(500) // wait for debounced json-store flush
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    assert.equal(state.notificationJobs.filter((job) => job.type === NOTIFICATION_TYPES.JAZZHR_RECHECK).length, 1)
  } finally {
    await fixture.cleanup()
  }
})

async function createStoreFixture() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'notification-store-'))
  const store = createJsonStore(runtimeDir)
  await store.init()
  return {
    store,
    statePath: path.join(runtimeDir, 'state.json'),
    cleanup: () => rm(runtimeDir, { recursive: true, force: true }),
  }
}

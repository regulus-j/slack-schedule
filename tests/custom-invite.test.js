import test from 'node:test'
import assert from 'node:assert/strict'

import { deliverCustomInviteEmails } from '../src/slack/handlers.js'
import { registerSlackHandlers } from '../src/slack/handlers.js'
import { customInviteRequestStatusModal, finalizeModal, intakeModal } from '../src/slack/views.js'
import { buildCalendarEventDraft } from '../src/time.js'
import {
  buildCustomInviteEmail,
  normalizeCustomInviteMetadata,
  parseCustomInviteRecipients,
  validateCustomInviteDraft,
} from '../src/workflow/custom-invite.js'

test('parses named and email-only custom invite recipients', () => {
  assert.deepEqual(
    parseCustomInviteRecipients('  Alex Reyes   <ALEX@example.com> \n\n guest@example.com  '),
    [
      { name: 'Alex Reyes', email: 'alex@example.com' },
      { name: '', email: 'guest@example.com' },
    ],
  )
})

test('rejects malformed, duplicate, and empty custom invite recipients', () => {
  assert.throws(() => parseCustomInviteRecipients('Alex <not-an-email>'), /invalid email/i)
  assert.throws(
    () => parseCustomInviteRecipients('Alex <same@example.com>\nSAME@example.com'),
    /Duplicate recipient: same@example\.com/,
  )
  assert.throws(() => parseCustomInviteRecipients(' \n '), /at least one recipient/i)
})

test('custom invite validation requires generic fields and allows no meeting link', () => {
  const valid = validateCustomInviteDraft({
    customInviteTitle: 'Client introduction',
    customInviteSubject: 'Invitation: [event_title]',
    customInviteBody: '[greeting]\n\nJoin us.',
    customInviteRecipients: [{ name: '', email: 'guest@example.com' }],
    customInviteMeetingLink: '',
  })
  assert.deepEqual(valid, {})

  const invalid = validateCustomInviteDraft({
    customInviteTitle: '',
    customInviteSubject: '',
    customInviteBody: '',
    customInviteRecipients: [],
    customInviteRecipientError: 'Enter at least one recipient.',
    customInviteMeetingLink: 'not-a-url',
  })
  assert.deepEqual(Object.keys(invalid).sort(), [
    'custom_body_block',
    'custom_meeting_link_block',
    'custom_recipients_block',
    'custom_subject_block',
    'custom_title_block',
  ])
})

test('custom invite submission creates a generic case without interview records', async () => {
  const views = new Map()
  const app = {
    action() {},
    command() {},
    event() {},
    options() {},
    message() {},
    view(id, handler) {
      views.set(id, handler)
    },
  }
  let createdInput
  let record
  const store = {
    async createCase(input) {
      createdInput = structuredClone(input)
      record = { id: 'case-1', status: 'Draft', approvals: [], ...structuredClone(input) }
      return structuredClone(record)
    },
    async updateCase(_id, patch) {
      record = { ...record, ...structuredClone(patch) }
      return structuredClone(record)
    },
    async addAudit() {},
    async listCasesForUser() {
      return [record]
    },
    async listCases() {
      return [record]
    },
    async hasGoogleToken() {
      return false
    },
  }
  registerSlackHandlers(app, {
    config: {
      slack: {},
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store,
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: {
      user: { id: 'U1' },
      view: { private_metadata: JSON.stringify({ channelId: 'C1' }) },
    },
    view: {
      private_metadata: JSON.stringify({ channelId: 'C1' }),
      state: {
        values: {
          event_type_block: {
            event_type_select: { selected_option: { value: 'custom-invite' } },
          },
          custom_title_block: { custom_title: { value: 'Client introduction' } },
          custom_recipients_block: {
            custom_recipients: { value: 'Alex <ALEX@example.com>\nguest@example.com' },
          },
          custom_subject_block: { custom_subject: { value: 'Invitation: [event_title]' } },
          custom_body_block: { custom_body: { value: '[greeting]\n\nJoin us on [date].' } },
          custom_meeting_link_block: { custom_meeting_link: { value: '' } },
          notes_block: { notes: { value: 'Bring the project brief.' } },
          timezone_block: {
            timezone_select: { selected_option: { value: 'Asia/Manila' } },
          },
        },
      },
    },
    client: {
      users: {
        async info() {
          return {
            user: {
              id: 'U1',
              profile: { real_name: 'Coordinator', email: 'coordinator@example.com' },
            },
          }
        },
      },
      chat: {
        async postMessage() {
          return { ts: '1.0', channel: 'C1' }
        },
      },
      views: {
        async publish() {},
      },
    },
  })

  assert.equal(ackPayload, undefined)
  assert.equal(createdInput.applicant, null)
  assert.equal(createdInput.recruiter, null)
  assert.equal(createdInput.hiringManager, null)
  assert.equal(createdInput.stageKey, null)
  assert.equal(createdInput.templateId, null)
  assert.equal(createdInput.customInvite.meetingLink, '')
  assert.deepEqual(createdInput.customInvite.recipients, [
    { name: 'Alex', email: 'alex@example.com' },
    { name: '', email: 'guest@example.com' },
  ])
})

test('custom invite intake and scheduling views use generic terminology', () => {
  const intake = intakeModal({
    templates: [],
    draft: {
      eventType: 'custom-invite',
      eventTypeOption: {
        text: { type: 'plain_text', text: 'Custom Invite' },
        value: 'custom-invite',
      },
    },
  })
  const intakeText = JSON.stringify(intake.blocks)
  assert.match(intakeText, /Event purpose \/ title/)
  assert.match(intakeText, /Recipient email addresses/)
  assert.match(intakeText, /Alex Reyes <alex@example\.com>/)
  assert.match(intakeText, /Add one recipient per line/)
  assert.match(intakeText, /Names are optional/)
  assert.match(intakeText, /one shared calendar event/)
  assert.doesNotMatch(intakeText, /Candidate|JazzHR|Recruiter|Hiring Manager|Resume/)

  const schedule = finalizeModal(makeCustomCase())
  const scheduleText = JSON.stringify(schedule.blocks)
  assert.equal(schedule.title.text, 'Schedule Event')
  assert.match(scheduleText, /Event date/)
  assert.match(scheduleText, /Meeting link/)
  assert.doesNotMatch(scheduleText, /Candidate|Interview stage|Zoom link/)
})

test('custom invite request status modal shows loading and completion states', () => {
  const loading = customInviteRequestStatusModal({
    title: 'Scheduling Event',
    message: 'Creating the event...',
  })
  assert.match(JSON.stringify(loading.blocks), /hourglass_flowing_sand/)
  assert.match(JSON.stringify(loading.blocks), /keep this window open/i)
  assert.equal(loading.close, undefined)

  const complete = customInviteRequestStatusModal({
    title: 'Event Scheduled',
    message: 'Invitation delivery is complete.',
    status: 'success',
  })
  assert.match(JSON.stringify(complete.blocks), /white_check_mark/)
  assert.equal(complete.close.text, 'Close')
})

test('generic calendar event contains every normalized recipient', () => {
  const event = buildCalendarEventDraft({
    eventTitle: 'Client introduction',
    startDate: '2026-07-01',
    startTime: '09:00',
    durationMinutes: 30,
    meetingLink: 'https://meet.example.com/abc',
    attendees: ['alex@example.com', 'guest@example.com'],
    timeZone: 'Asia/Manila',
  })

  assert.equal(event.summary, 'Client introduction')
  assert.equal(event.location, 'https://meet.example.com/abc')
  assert.deepEqual(event.attendees, [
    { email: 'alex@example.com' },
    { email: 'guest@example.com' },
  ])
  assert.doesNotMatch(event.description, /Interview/)
})

test('builds separate personalized generic emails with neutral fallback greeting', () => {
  const caseRecord = makeCustomCase({
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: '',
    },
  })
  const metadata = normalizeCustomInviteMetadata(caseRecord)
  const named = buildCustomInviteEmail(caseRecord, metadata.recipients[0])
  const unnamed = buildCustomInviteEmail(caseRecord, metadata.recipients[1])

  assert.equal(named.to, 'alex@example.com')
  assert.match(named.plainBody, /^Hello Alex,/)
  assert.match(named.plainBody, /2026-07-01/)
  assert.equal(unnamed.to, 'guest@example.com')
  assert.match(unnamed.plainBody, /^Hello,/)
  assert.doesNotMatch(named.plainBody, /candidate|interview/i)
})

test('older custom invite records remain readable through compatibility defaults', () => {
  const metadata = normalizeCustomInviteMetadata({
    autofill: {
      customInvitePurpose: 'Legacy assessment',
      zoomLink: 'https://zoom.example.com/legacy',
    },
    applicant: {
      firstName: 'Legacy',
      lastName: 'Guest',
      email: 'LEGACY@example.com',
    },
  })

  assert.equal(metadata.title, 'Legacy assessment')
  assert.equal(metadata.meetingLink, 'https://zoom.example.com/legacy')
  assert.deepEqual(metadata.recipients, [
    { name: 'Legacy Guest', email: 'legacy@example.com' },
  ])
})

test('custom invite delivery skips recipients already sent on retry', async () => {
  let record = makeCustomCase({
    id: 'case-custom-1',
    status: 'Scheduled',
    calendarEventId: 'event-1',
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: '',
    },
  })
  let mockedSendCount = 0
  const store = {
    async getCase() {
      return structuredClone(record)
    },
    async updateCase(_id, patch) {
      record = { ...record, ...structuredClone(patch) }
      return structuredClone(record)
    },
  }
  const logger = {
    warn(event) {
      if (event === 'gmail_send_mocked') mockedSendCount += 1
    },
    error() {},
  }

  const [first, concurrent] = await Promise.all([
    deliverCustomInviteEmails({
      config: { google: {} },
      logger,
      store,
      caseRecord: record,
    }),
    deliverCustomInviteEmails({
      config: { google: {} },
      logger,
      store,
      caseRecord: record,
    }),
  ])
  const retry = await deliverCustomInviteEmails({
    config: { google: {} },
    logger,
    store,
    caseRecord: record,
  })

  assert.equal(mockedSendCount, 2)
  assert.deepEqual(first.map((result) => result.status), ['mocked', 'mocked'])
  assert.deepEqual(concurrent.map((result) => result.status), ['mocked', 'mocked'])
  assert.deepEqual(retry.map((result) => result.status), ['skipped', 'skipped'])
  assert.equal(record.customInvite.deliveryStatus['alex@example.com'].status, 'mocked')
  assert.equal(record.customInvite.deliveryStatus['guest@example.com'].status, 'mocked')
})

function makeCustomCase(overrides = {}) {
  return {
    id: 'case-custom',
    status: 'Draft',
    ownerSlackUserId: 'U1',
    interviewTimezone: 'Asia/Manila',
    customInvite: {
      title: 'Client introduction',
      subject: 'Invitation: [event_title]',
      body: '[greeting]\n\nYou are invited to [event_title] on [date] at [time] [timezone].',
      recipients: [
        { name: 'Alex', email: 'alex@example.com' },
        { name: '', email: 'guest@example.com' },
      ],
      meetingLink: '',
      deliveryStatus: {},
    },
    autofill: {
      coordinatorEmail: 'coordinator@example.com',
    },
    ...overrides,
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEditCaseDraft,
  buildIntakeDraft,
  deliverCustomInviteEmails,
  registerSlackHandlers,
} from '../src/slack/handlers.js'
import {
  setRecruitmentSheetPeople,
  setSlackRecruiters,
  setSlackUsers,
  setTalentRecruiters,
} from '../src/data/cache.js'
import {
  actionButtonsForCase,
  caseMessageBlocks,
  customInviteRequestStatusModal,
  customInviteSentEmailsModal,
  finalizeModal,
  intakeModal,
} from '../src/slack/views.js'
import { buildCalendarEventDraft } from '../src/time.js'
import { loadIntakeTemplates } from '../src/templates.js'
import {
  buildCustomInviteEmail,
  buildCustomInvitePreviewVariables,
  normalizeCustomInviteMetadata,
  parseCustomInviteRecipients,
  replaceInviteVariables,
  validateCustomInviteDraft,
} from '../src/workflow/custom-invite.js'

test('parses named external custom invite recipients', () => {
  assert.deepEqual(
    parseCustomInviteRecipients('  Alex Reyes - ALEX@example.com \n\n guest@example.com  '),
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
    'custom_external_guests_block',
    'custom_meeting_link_block',
    'custom_subject_block',
    'custom_title_block',
  ])
})

test('custom invite submission creates a generic case without interview records', async () => {
  setRecruitmentSheetPeople([{
    id: 'sheet-recipient',
    name: 'Alex Recruiter',
    email: 'alex@example.com',
  }])
  setSlackUsers([])
  setSlackRecruiters([])
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
      slack: { teamId: 'T1' },
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
          custom_slack_recipients_block: {
            custom_slack_recipients: {
              selected_options: [{ value: 'URECIPIENT' }],
            },
          },
          custom_external_guests_block: {
            custom_external_guests: {
              value: 'External Guest - guest@example.com\nDuplicate Alex - ALEX@example.com',
            },
          },
          custom_email_template_block: {
            custom_email_template_select: {
              selected_option: { value: 'custom-invite-general-meeting' },
            },
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
        async list() {
          return {
            members: [{
              id: 'URECIPIENT',
              profile: { real_name: 'Alex Recruiter', email: 'alex@example.com' },
            }],
            response_metadata: { next_cursor: '' },
          }
        },
        async info({ user }) {
          if (user === 'URECIPIENT') {
            return {
              user: {
                id: user,
                profile: { real_name: 'Alex Recruiter', email: 'alex@example.com' },
              },
            }
          }
          return {
            user: {
              id: user,
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
  assert.equal(createdInput.customInvite.templateId, 'custom-invite-general-meeting')
  assert.deepEqual(createdInput.customInvite.recipients, [
    { name: 'Alex Recruiter', email: 'alex@example.com', slackUserId: 'URECIPIENT' },
    { name: 'External Guest', email: 'guest@example.com' },
  ])
})

test('custom invite rejects Slack recipients not matched to the recruitment sheet', async () => {
  setRecruitmentSheetPeople([{
    id: 'sheet-inside',
    name: 'Inside Recruiter',
    email: 'inside@example.com',
  }])
  setSlackUsers([])
  setSlackRecruiters([])
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
  registerSlackHandlers(app, {
    config: {
      slack: { teamId: 'T1' },
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store: {},
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: { user: { id: 'UCOORDINATOR' } },
    view: {
      private_metadata: '{}',
      state: {
        values: {
          event_type_block: {
            event_type_select: { selected_option: { value: 'custom-invite' } },
          },
          custom_slack_recipients_block: {
            custom_slack_recipients: {
              selected_options: [{ value: 'UOUTSIDE' }],
            },
          },
        },
      },
    },
    client: {
      users: {
        async list() {
          return {
            members: [{
              id: 'UINSIDE',
              profile: {
                real_name: 'Inside Recruiter',
                email: 'inside@example.com',
              },
            }],
            response_metadata: { next_cursor: '' },
          }
        },
      },
    },
  })

  assert.match(
    ackPayload.errors.custom_slack_recipients_block,
    /Could not identify one or more selected recipients/,
  )
})

test('custom invite accepts a Slack user not in the recruitment sheet when resolved via API', async () => {
  setRecruitmentSheetPeople([{
    id: 'sheet-inside',
    name: 'Inside Recruiter',
    email: 'inside@example.com',
  }])
  setSlackUsers([])
  setSlackRecruiters([])
  setTalentRecruiters([])
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
  const store = {
    async createCase(input) {
      createdInput = input
      return { id: 'case-custom', ...input, approvals: [] }
    },
    async getCase() { return null },
    async updateCase(id, patch) {
      return { id, ...createdInput, ...patch }
    },
    async addAudit() {},
    async listCases() { return [] },
    async listCasesForUser() { return [] },
    async listTeamCases() { return [] },
  }
  registerSlackHandlers(app, {
    config: {
      slack: { teamId: 'T1' },
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store,
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload = 'not-called'
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: { user: { id: 'UCOORDINATOR' } },
    view: {
      private_metadata: JSON.stringify({ channelId: 'C1' }),
      state: {
        values: {
          event_type_block: {
            event_type_select: { selected_option: { value: 'custom-invite' } },
          },
          custom_title_block: { custom_title: { value: 'Client introduction' } },
          custom_slack_recipients_block: {
            custom_slack_recipients: {
              selected_options: [{
                value: 'UOUTSIDE',
                text: {
                  type: 'plain_text',
                  text: 'Outside User - outside@example.com',
                },
              }],
            },
          },
          custom_email_template_block: {
            custom_email_template_select: {
              selected_option: { value: 'custom-invite-general-meeting' },
            },
          },
          custom_subject_block: { custom_subject: { value: 'Invitation: [event_title]' } },
          custom_body_block: { custom_body: { value: '[greeting]\n\nJoin us.' } },
          custom_meeting_link_block: { custom_meeting_link: { value: '' } },
          timezone_block: {
            timezone_select: { selected_option: { value: 'Asia/Manila' } },
          },
        },
      },
    },
    client: {
      users: {
        async list() { return { members: [], response_metadata: { next_cursor: '' } } },
        async info({ user }) {
          return {
            user: {
              id: user,
              profile: { real_name: 'Outside User', email: 'outside@example.com' },
            },
          }
        },
      },
      chat: {
        async postMessage() { return { ts: '1.0', channel: 'C1' } },
      },
      views: {
        async publish() {},
      },
    },
  })

  assert.equal(ackPayload, undefined)
  assert.deepEqual(createdInput.customInvite.recipients, [
    { name: 'Outside User', email: 'outside@example.com', slackUserId: 'UOUTSIDE' },
  ])
  setSlackRecruiters([])
})

test('custom invite submit uses selected option details when directory reload is denied after restart', async () => {
  setRecruitmentSheetPeople([{
    id: 'sheet-recipient',
    name: 'Alex Recruiter',
    email: 'alex@example.com',
  }])
  setSlackUsers([])
  setSlackRecruiters([])
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
  const store = {
    async createCase(input) {
      createdInput = input
      return { id: 'case-custom', ...input, approvals: [] }
    },
    async updateCase(id, patch) {
      return { id, ...createdInput, ...patch }
    },
    async addAudit() {},
    async listCases() { return [] },
    async listCasesForUser() { return [] },
    async listTeamCases() { return [] },
  }
  registerSlackHandlers(app, {
    config: {
      slack: { teamId: 'T1' },
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store,
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload = 'not-called'
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: { user: { id: 'UCOORDINATOR' } },
    view: {
      private_metadata: JSON.stringify({ channelId: 'C1' }),
      state: {
        values: {
          event_type_block: {
            event_type_select: { selected_option: { value: 'custom-invite' } },
          },
          custom_title_block: { custom_title: { value: 'Client introduction' } },
          custom_slack_recipients_block: {
            custom_slack_recipients: {
              selected_options: [{
                value: 'URECIPIENT',
                text: {
                  type: 'plain_text',
                  text: 'Alex Recruiter - alex@example.com',
                },
              }],
            },
          },
          custom_email_template_block: {
            custom_email_template_select: {
              selected_option: { value: 'custom-invite-general-meeting' },
            },
          },
          custom_subject_block: { custom_subject: { value: 'Invitation: [event_title]' } },
          custom_body_block: { custom_body: { value: '[greeting]\n\nJoin us.' } },
          custom_meeting_link_block: { custom_meeting_link: { value: '' } },
          timezone_block: {
            timezone_select: { selected_option: { value: 'Asia/Manila' } },
          },
        },
      },
    },
    client: {
      users: {
        async list() {
          const error = new Error('An API error occurred: team_access_not_granted')
          error.data = { error: 'team_access_not_granted' }
          throw error
        },
        async info({ user }) {
          return {
            user: {
              id: user,
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
  assert.deepEqual(createdInput.customInvite.recipients, [
    { name: 'Alex Recruiter', email: 'alex@example.com', slackUserId: 'URECIPIENT' },
  ])
  setSlackRecruiters([])
})

test('edit submission is rejected if a calendar event was created after the modal opened', async () => {
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
  registerSlackHandlers(app, {
    config: {
      slack: {},
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store: {
      async getCase() {
        return { id: 'case-1', status: 'Scheduled', calendarEventId: 'event-1' }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: { user: { id: 'U1' } },
    view: {
      private_metadata: JSON.stringify({ editCaseId: 'case-1' }),
      state: { values: {} },
    },
    client: {},
  })

  assert.match(ackPayload.errors.event_type_block, /calendar event has already been created/i)
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
  assert.match(intakeText, /Slack members/)
  assert.match(intakeText, /Search Slack members or recruiters/)
  assert.match(intakeText, /Email template/)
  assert.match(intakeText, /External emails/)
  assert.match(intakeText, /Shows all recruitment team members when empty/)
  assert.match(intakeText, /one shared calendar event/)
  assert.doesNotMatch(intakeText, /Candidate|JazzHR|Recruiter|Hiring Manager|Resume/)

  const schedule = finalizeModal(makeCustomCase())
  const scheduleText = JSON.stringify(schedule.blocks)
  assert.equal(schedule.title.text, 'Schedule Event')
  assert.match(scheduleText, /Event date/)
  assert.match(scheduleText, /Meeting link/)
  assert.doesNotMatch(scheduleText, /Candidate|Interview stage|Zoom link/)
})

test('custom invite templates default to General Meeting and remain editable', async () => {
  const templates = await loadIntakeTemplates()
  const draft = buildIntakeDraft({
    event_type_block: {
      event_type_select: { selected_option: { value: 'custom-invite' } },
    },
  }, templates)

  assert.equal(draft.customInviteTemplateId, 'custom-invite-general-meeting')
  assert.equal(draft.customInviteSubject, 'Invitation: [event_title]')
  assert.match(draft.customInviteBody, /You are invited to \[event_title\]/)
  assert.deepEqual(
    draft.customInviteTemplateOptions.map((option) => option.value),
    ['custom-invite-assessment', 'custom-invite-general-meeting', 'custom'],
  )

  const edited = buildIntakeDraft({
    event_type_block: {
      event_type_select: { selected_option: { value: 'custom-invite' } },
    },
    custom_email_template_block: {
      custom_email_template_select: {
        selected_option: { value: 'custom-invite-general-meeting' },
      },
    },
    custom_subject_block: {
      custom_subject: { value: 'Edited subject' },
    },
    custom_body_block: {
      custom_body: { value: 'Edited body' },
    },
  }, templates)

  assert.equal(edited.customInviteSubject, 'Edited subject')
  assert.equal(edited.customInviteBody, 'Edited body')
})

test('custom email template selection replaces copy and Custom preserves current copy', async () => {
  const actions = new Map()
  const app = {
    action(id, handler) {
      actions.set(id, handler)
    },
    command() {},
    event() {},
    options() {},
    view() {},
    message() {},
  }
  registerSlackHandlers(app, {
    config: {
      slack: {},
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store: {},
    logger: { info() {}, warn() {}, error() {} },
  })

  const updates = []
  const baseBody = {
    user: { id: 'U1' },
    view: {
      id: 'V1',
      hash: 'hash-1',
      private_metadata: JSON.stringify({ eventType: 'custom-invite' }),
      state: {
        values: {
          event_type_block: {
            event_type_select: { selected_option: { value: 'custom-invite' } },
          },
          custom_subject_block: {
            custom_subject: { value: 'Current subject' },
          },
          custom_body_block: {
            custom_body: { value: 'Current body' },
          },
        },
      },
    },
  }
  const client = {
    views: {
      async update(payload) {
        updates.push(payload)
        return {
          view: {
            ...payload.view,
            id: 'V1',
            hash: `hash-${updates.length + 1}`,
          },
        }
      },
    },
  }

  await actions.get('custom_email_template_select')({
    ack: async () => {},
    body: {
      ...baseBody,
      actions: [{
        selected_option: { value: 'custom-invite-assessment' },
      }],
    },
    client,
  })
  const assessmentView = updates.at(-1).view
  assert.equal(
    assessmentView.blocks.find((block) => block.block_id === 'custom_subject_block_custom-invite-assessment').element.initial_value,
    'Assessment Invitation: [event_title]',
  )
  assert.match(
    assessmentView.blocks.find((block) => block.block_id === 'custom_body_block_custom-invite-assessment').element.initial_value,
    /Assessment details:/,
  )

  await actions.get('custom_email_template_select')({
    ack: async () => {},
    body: {
      ...baseBody,
      actions: [{
        selected_option: { value: 'custom' },
      }],
    },
    client,
  })
  const customView = updates.at(-1).view
  assert.equal(
    customView.blocks.find((block) => block.block_id === 'custom_subject_block_custom').element.initial_value,
    'Current subject',
  )
  assert.equal(
    customView.blocks.find((block) => block.block_id === 'custom_body_block_custom').element.initial_value,
    'Current body',
  )
})

test('editing a custom invite preserves the selected template and edited copy', async () => {
  const templates = await loadIntakeTemplates()
  setSlackRecruiters([{
    id: 'U1',
    slackUserId: 'U1',
    name: 'Alex Recruiter',
    email: 'alex@example.com',
    role: 'slack_user',
  }])
  const draft = buildEditCaseDraft(makeCustomCase({
    customInvite: {
      templateId: 'custom-invite-assessment',
      title: 'Property assessment',
      subject: 'Edited assessment subject',
      body: 'Edited assessment body',
      recipients: [{
        name: 'Alex Recruiter',
        email: 'alex@example.com',
        slackUserId: 'U1',
      }],
      meetingLink: '',
      deliveryStatus: {},
    },
  }), templates)

  assert.equal(draft.customInviteTemplateId, 'custom-invite-assessment')
  assert.equal(draft.customInviteSubject, 'Edited assessment subject')
  assert.equal(draft.customInviteBody, 'Edited assessment body')
  assert.deepEqual(draft.customInviteSlackRecipientIds, ['U1'])

  const view = intakeModal({ templates, draft })
  assert.equal(
    view.blocks.find((block) => block.block_id === 'custom_email_template_block').element.initial_option.value,
    'custom-invite-assessment',
  )
  assert.equal(
    view.blocks.find((block) => block.block_id === 'custom_subject_block_custom-invite-assessment').element.initial_value,
    'Edited assessment subject',
  )
  setSlackRecruiters([])
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

test('scheduled custom invite shows recipients and personalized sent emails', () => {
  const caseRecord = makeCustomCase({
    status: 'Scheduled',
    calendarEventId: 'event-1',
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: '',
    },
    customInvite: {
      ...makeCustomCase().customInvite,
      deliveryStatus: {
        'alex@example.com': {
          status: 'sent',
          email: {
            to: 'alex@example.com',
            subject: 'Saved subject for Alex',
            plainBody: 'Hello Alex,\n\nSaved sent email.',
          },
        },
        'guest@example.com': { status: 'failed' },
      },
    },
  })

  const caseText = JSON.stringify(caseMessageBlocks(caseRecord))
  assert.match(caseText, /Alex \(alex@example\.com\).*Sent/)
  assert.match(caseText, /guest@example\.com.*Failed/)

  const labels = actionButtonsForCase(caseRecord).map((item) => item.text.text)
  assert.ok(labels.includes('View sent emails'))

  const modalText = JSON.stringify(customInviteSentEmailsModal(caseRecord))
  assert.match(modalText, /Saved subject for Alex/)
  assert.match(modalText, /Saved sent email/)
  assert.match(modalText, /Hello,/)
  assert.match(modalText, /Delivery: \*Failed\*/)
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
  assert.match(named.plainBody, /Outsourced Pro Global Limited/)
  assert.match(named.htmlBody, /font-family:Arial,Helvetica,sans-serif/)
  assert.match(named.htmlBody, /font-size:14px;line-height:1\.38/)
  assert.match(named.htmlBody, /data-opg-signature="true"/)
  assert.equal(unnamed.to, 'guest@example.com')
  assert.match(unnamed.plainBody, /^Hello,/)
  assert.doesNotMatch(named.plainBody, /candidate|interview/i)
})

test('custom invite email formats details and meeting links for Gmail', () => {
  const caseRecord = makeCustomCase()
  const email = buildCustomInviteEmail({
    ...caseRecord,
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: 'https://meet.example.com/custom',
    },
    customInvite: {
      ...caseRecord.customInvite,
      body: [
        '[greeting]',
        '',
        'You are invited to [event_title].',
        '',
        'Event details:',
        '',
        'Date: [date]',
        'Time: [time] [timezone]',
        'Meeting link: [meeting_link]',
      ].join('\n'),
    },
  }, {
    name: 'Alex',
    email: 'alex@example.com',
  })

  assert.match(email.htmlBody, /<strong>Event details:<\/strong>/)
  assert.match(email.htmlBody, /background-color:#f5f5f5/)
  assert.match(email.htmlBody, /<strong>Date:<\/strong> 2026-07-01/)
  assert.match(
    email.htmlBody,
    /<a href="https:\/\/meet\.example\.com\/custom"[^>]*>https:\/\/meet\.example\.com\/custom<\/a>/,
  )
  assert.match(email.htmlBody, /data-opg-signature="true"/)
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

  assert.equal(metadata.templateId, 'custom')
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
  assert.equal(record.customInvite.deliveryStatus['alex@example.com'].email.to, 'alex@example.com')
  assert.match(record.customInvite.deliveryStatus['alex@example.com'].email.plainBody, /^Hello Alex,/)
})

test('buildCustomInvitePreviewVariables uses first recipient for per-recipient vars', () => {
  const caseRecord = makeCustomCase({
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: 'https://meet.example.com/preview',
    },
  })
  const vars = buildCustomInvitePreviewVariables(caseRecord)

  assert.equal(vars.name, 'Alex')
  assert.equal(vars.greeting, 'Hello Alex,')
  assert.equal(vars.email, 'alex@example.com')
  assert.equal(vars.event_title, 'Client introduction')
  assert.equal(vars.date, '2026-07-01')
  assert.equal(vars.time, '09:00')
  assert.equal(vars.meeting_link, 'https://meet.example.com/preview')
})

test('buildCustomInvitePreviewVariables handles unnamed first recipient', () => {
  const vars = buildCustomInvitePreviewVariables(makeCustomCase({
    customInvite: {
      ...makeCustomCase().customInvite,
      recipients: [
        { name: '', email: 'nobody@example.com' },
      ],
    },
  }))

  assert.equal(vars.name, '')
  assert.equal(vars.greeting, 'Hello,')
  assert.equal(vars.email, 'nobody@example.com')
})

test('buildCustomInvitePreviewVariables handles no recipients', () => {
  const vars = buildCustomInvitePreviewVariables(makeCustomCase({
    customInvite: {
      ...makeCustomCase().customInvite,
      recipients: [],
    },
  }))

  assert.equal(vars.name, 'Recipient')
  assert.equal(vars.greeting, 'Hello Recipient,')
  assert.equal(vars.email, '')
})

test('buildCustomInvitePreviewVariables handles missing schedule data', () => {
  const vars = buildCustomInvitePreviewVariables(makeCustomCase({
    currentSchedule: {},
    selectedInterviewDate: '',
    selectedInterviewTime: '',
  }))

  assert.equal(vars.date, '')
  assert.equal(vars.time, '')
  assert.equal(vars.meeting_link, '')
  assert.equal(vars.timezone, 'Asia/Manila')
})

test('custom invite preview renders resolved template variables', () => {
  const caseRecord = makeCustomCase({
    currentSchedule: {
      date: '2026-07-01',
      time: '09:00',
      zoomLink: '',
    },
  })
  const vars = buildCustomInvitePreviewVariables(caseRecord)
  const subject = replaceInviteVariables(caseRecord.customInvite.subject, vars)
  const body = replaceInviteVariables(caseRecord.customInvite.body, vars)

  assert.equal(subject, 'Invitation: Client introduction')
  assert.match(body, /Hello Alex,/)
  assert.match(body, /2026-07-01/)
  assert.match(body, /09:00/)
  assert.doesNotMatch(body, /\[greeting\]/)
  assert.doesNotMatch(body, /\[event_title\]/)
  assert.doesNotMatch(body, /\[date\]/)
  assert.doesNotMatch(body, /\[time\]/)
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

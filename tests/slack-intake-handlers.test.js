import test from 'node:test'
import assert from 'node:assert/strict'

import { setApplicants, setHiringManagers, setJazzhrJobs, setRoleAssignments, setSlackUsers, setTalentRecruiters } from '../src/data/cache.js'
import { registerSlackHandlers } from '../src/slack/handlers.js'

test('cached candidate selection hydrates exact JazzHR application details and clears search errors', async () => {
  setApplicants([])
  setHiringManagers([])
  setTalentRecruiters([])
  setRoleAssignments([])
  setJazzhrJobs([])

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
  const candidate = {
    id: 'applicant-prospect-niel::job-open',
    candidateKey: 'prospect-niel::job-open',
    jazzhrApplicationId: 'prospect-niel',
    jazzhrJobId: 'job-open',
    fullName: 'Niel Justine Cabataña',
    firstName: 'Niel Justine',
    lastName: 'Cabataña',
    email: '',
    phone: '',
    jobTitle: 'Junior Valuation Analyst',
    stage: 'Completed 1st Interview',
    source: 'jazzhr',
  }
  registerSlackHandlers(app, {
    config: {
      jazzhr: {
        apiKey: 'api-key',
        applicantFetchConcurrency: 2,
        liveSearch: {
          pageSize: 20,
          concurrency: 2,
          maxPages: 10,
          sessionTtlMs: 900000,
        },
      },
      slack: {},
      google: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
    },
    store: {
      async getJazzhrCandidate(id) {
        return id === candidate.candidateKey ? candidate : null
      },
    },
    logger: silentLogger(),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        id: 'prospect-niel',
        first_name: 'Niel Justine',
        last_name: 'Cabataña',
        email: 'niel@example.com',
        phone: '0400000000',
        jobs: {
          job_id: 'job-open',
          job_title: 'Junior Valuation Analyst',
          applicant_progress: 'Completed 1st Interview',
          workflow_step_id: '10476588',
        },
      }
    },
  })

  let acked = false
  const updates = []
  let latestView
  try {
    await actions.get('applicant_select')({
      ack: async () => {
        acked = true
      },
      body: {
        user: { id: 'U1' },
        actions: [{
          selected_option: {
            value: 'applicant-prospect-niel::job-open',
            text: { text: 'Niel Justine Cabataña' },
          },
        }],
        view: {
          id: 'V1',
          hash: 'hash-1',
          private_metadata: JSON.stringify({
            channelId: 'C1',
            eventType: '1st-interview',
            candidateSearchError: 'Search expired. Press Search again.',
          }),
          state: {
            values: {
              event_type_block: {
                event_type_select: {
                  selected_option: { value: '1st-interview' },
                },
              },
              applicant_block: {
                applicant_select: {
                  selected_option: { value: 'applicant-prospect-niel::job-open' },
                },
              },
            },
          },
        },
      },
      client: {
        views: {
          async update(payload) {
            updates.push(payload)
            if (updates.length === 1) {
              latestView = {
                ...payload.view,
                id: 'V1',
                hash: 'hash-2',
                state: {
                  values: {
                    event_type_block: {
                      event_type_select: {
                        selected_option: { value: '1st-interview' },
                      },
                    },
                    applicant_block: {
                      applicant_select: {
                        selected_option: { value: 'applicant-prospect-niel::job-open' },
                      },
                    },
                  },
                },
              }
              return { view: latestView }
            }
            if (updates.length === 2) {
              const error = new Error('An API error occurred: hash_conflict')
              error.data = {
                error: 'hash_conflict',
                view: {
                  ...latestView,
                  hash: 'hash-3',
                },
              }
              throw error
            }
            return {
              view: {
                ...payload.view,
                id: 'V1',
                hash: 'hash-4',
              },
            }
          },
        },
        chat: {
          async postEphemeral() {},
        },
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(acked, true)
  assert.equal(updates.length, 3)
  assert.match(JSON.stringify(updates[0].view.blocks), /Updating form/)
  const updatedView = updates[2].view
  const emailBlock = updatedView.blocks.find((block) => block.block_id?.startsWith('applicant_email_block'))
  assert.equal(emailBlock.element.initial_value, 'niel@example.com')
  assert.match(JSON.stringify(updatedView.blocks), /0400000000/)
  assert.equal(JSON.parse(updatedView.private_metadata).candidateSearchError, '')
  assert.equal(JSON.parse(updatedView.private_metadata).remoteUpdateStatus, '')
})

test('recruiter checkboxes promote the next primary and preserve a manual Zoom link', async () => {
  setApplicants([])
  setHiringManagers([])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    },
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
    },
  ])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])

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
      jazzhr: { liveSearch: {} },
      slack: {},
      google: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
    },
    store: {},
    logger: silentLogger(),
  })

  let updated
  await actions.get('recruiter_checkboxes')({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      actions: [{
        selected_options: [{ value: 'rec-jam' }],
      }],
      view: {
        id: 'V1',
        hash: 'H1',
        private_metadata: JSON.stringify({
          eventType: '1st-interview',
          roleId: 'job-1',
          roleTitle: 'Support Specialist',
          recruiterIds: ['rec-mara', 'rec-jam'],
          zoomLink: 'https://manual.example.com/meeting',
          zoomLinkAuto: false,
        }),
        state: {
          values: {
            event_type_block: { event_type_select: { selected_option: { value: '1st-interview' } } },
            role_block: { role_select: { selected_option: { value: 'job-1' } } },
            zoom_block: { zoom_link: { value: 'https://manual.example.com/meeting' } },
          },
        },
      },
    },
    client: {
      views: {
        async update(payload) {
          updated = payload.view
          return { view: payload.view }
        },
      },
    },
  })

  const metadata = JSON.parse(updated.private_metadata)
  const recruiterBlock = updated.blocks.find((block) => block.block_id === 'recruiters_block')
  assert.deepEqual(metadata.recruiterIds, ['rec-jam'])
  assert.equal(metadata.zoomLink, 'https://manual.example.com/meeting')
  assert.deepEqual(recruiterBlock.element.initial_options.map((option) => option.value), ['rec-jam'])
  assert.equal(JSON.stringify(updated.blocks).includes('recruiter_name_override'), false)
  assert.equal(JSON.stringify(updated.blocks).includes('recruiter_email_override'), false)
  setJazzhrJobs([])
})

test('Zoom dropdown selection replaces the Zoom text input', async () => {
  setApplicants([])
  setHiringManagers([])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    },
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
    },
  ])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])

  const actions = registerActionHarness()
  let updated
  await actions.get('zoom_link_select')({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      actions: [{
        selected_option: { value: 'https://zoom.us/j/jam' },
      }],
      view: {
        id: 'V1',
        hash: 'H1',
        private_metadata: JSON.stringify({
          eventType: '1st-interview',
          roleId: 'job-1',
          roleTitle: 'Support Specialist',
          recruiterIds: ['rec-mara', 'rec-jam'],
          zoomLink: 'https://zoom.us/j/mara',
          zoomLinkRevision: 1,
          zoomLinkAuto: true,
        }),
        state: {
          values: {
            event_type_block: { event_type_select: { selected_option: { value: '1st-interview' } } },
            role_block: { role_select: { selected_option: { value: 'job-1' } } },
            recruiters_block: {
              recruiter_checkboxes: {
                selected_options: [{ value: 'rec-mara' }, { value: 'rec-jam' }],
              },
            },
            zoom_block: { zoom_link: { value: 'https://zoom.us/j/mara' } },
          },
        },
      },
    },
    client: {
      views: {
        async update(payload) {
          updated = payload.view
          return { view: payload.view }
        },
      },
    },
  })

  const metadata = JSON.parse(updated.private_metadata)
  const zoomBlock = updated.blocks.find((block) => block.block_id?.startsWith('zoom_block_2_'))
  assert.equal(metadata.zoomLink, 'https://zoom.us/j/jam')
  assert.equal(metadata.zoomLinkRevision, 2)
  assert.equal(zoomBlock.element.initial_value, 'https://zoom.us/j/jam')
  assert.equal(updated.blocks.find((block) => block.block_id === 'zoom_choice_block').element.initial_option.value, 'https://zoom.us/j/jam')
  setJazzhrJobs([])
})

test('unrelated intake refresh preserves the typed manual Zoom link over metadata', async () => {
  setApplicants([])
  setHiringManagers([])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    },
  ])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])

  const actions = registerActionHarness()
  let updated
  await actions.get('recruiter_people_search')({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      actions: [{ value: 'mara' }],
      view: {
        id: 'V1',
        hash: 'H1',
        private_metadata: JSON.stringify({
          eventType: '1st-interview',
          roleId: 'job-1',
          roleTitle: 'Support Specialist',
          recruiterIds: ['rec-mara'],
          zoomLink: 'https://zoom.us/j/mara',
          zoomLinkRevision: 1,
          zoomLinkAuto: true,
        }),
        state: {
          values: {
            event_type_block: { event_type_select: { selected_option: { value: '1st-interview' } } },
            role_block: { role_select: { selected_option: { value: 'job-1' } } },
            recruiters_block: {
              recruiter_checkboxes: {
                selected_options: [{ value: 'rec-mara' }],
              },
            },
            zoom_block: { zoom_link: { value: 'https://manual.example.com/meeting' } },
          },
        },
      },
    },
    client: {
      views: {
        async update(payload) {
          updated = payload.view
          return { view: payload.view }
        },
      },
    },
  })

  const metadata = JSON.parse(updated.private_metadata)
  const zoomBlock = updated.blocks.find((block) => block.block_id?.startsWith('zoom_block_1_'))
  assert.equal(metadata.zoomLink, 'https://manual.example.com/meeting')
  assert.equal(zoomBlock.element.initial_value, 'https://manual.example.com/meeting')
  setJazzhrJobs([])
})

test('newly checked recruiter and hiring manager become primary selections', async () => {
  setApplicants([])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
    { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
  ])
  setHiringManagers([
    { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
    { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com', role: 'hiring_manager' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
      hiringManager: { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
    },
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
      hiringManager: { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com', role: 'hiring_manager' },
    },
  ])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])

  const actions = registerActionHarness()
  const updates = []
  const client = {
    views: {
      async update(payload) {
        updates.push(payload.view)
        return { view: payload.view }
      },
    },
  }

  await actions.get('recruiter_checkboxes')({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      actions: [{
        selected_options: [{ value: 'rec-mara' }, { value: 'rec-jam' }],
      }],
      view: {
        id: 'V1',
        hash: 'H1',
        private_metadata: JSON.stringify({
          eventType: '2nd-interview',
          roleId: 'job-1',
          roleTitle: 'Support Specialist',
          recruiterIds: ['rec-mara'],
          hiringManagerIds: ['hm-ana'],
          zoomLink: 'https://zoom.us/j/mara',
          zoomLinkAuto: true,
        }),
        state: {
          values: {
            event_type_block: { event_type_select: { selected_option: { value: '2nd-interview' } } },
            role_block: { role_select: { selected_option: { value: 'job-1' } } },
            recruiters_block: {
              recruiter_checkboxes: {
                selected_options: [{ value: 'rec-mara' }, { value: 'rec-jam' }],
              },
            },
            hiring_managers_block: {
              hiring_manager_checkboxes: {
                selected_options: [{ value: 'hm-ana' }],
              },
            },
            zoom_block: { zoom_link: { value: 'https://zoom.us/j/mara' } },
          },
        },
      },
    },
    client,
  })

  await actions.get('hiring_manager_checkboxes')({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      actions: [{
        selected_options: [{ value: 'hm-ana' }, { value: 'hm-lee' }],
      }],
      view: {
        id: 'V1',
        hash: 'H2',
        private_metadata: JSON.stringify({
          eventType: '2nd-interview',
          roleId: 'job-1',
          roleTitle: 'Support Specialist',
          recruiterIds: ['rec-jam', 'rec-mara'],
          hiringManagerIds: ['hm-ana'],
          zoomLink: 'https://zoom.us/j/jam',
          zoomLinkAuto: true,
        }),
        state: {
          values: {
            event_type_block: { event_type_select: { selected_option: { value: '2nd-interview' } } },
            role_block: { role_select: { selected_option: { value: 'job-1' } } },
            recruiters_block: {
              recruiter_checkboxes: {
                selected_options: [{ value: 'rec-jam' }, { value: 'rec-mara' }],
              },
            },
            hiring_managers_block: {
              hiring_manager_checkboxes: {
                selected_options: [{ value: 'hm-ana' }, { value: 'hm-lee' }],
              },
            },
            zoom_block: { zoom_link: { value: 'https://zoom.us/j/jam' } },
          },
        },
      },
    },
    client,
  })

  const recruiterMetadata = JSON.parse(updates[0].private_metadata)
  const hmMetadata = JSON.parse(updates[1].private_metadata)
  const recruiterBlock = updates[0].blocks.find((block) => block.block_id === 'recruiters_block')
  const hmBlock = updates[1].blocks.find((block) => block.block_id === 'hiring_managers_block')
  assert.deepEqual(recruiterMetadata.recruiterIds, ['rec-jam', 'rec-mara'])
  assert.deepEqual(recruiterBlock.element.initial_options.map((option) => option.value), ['rec-jam', 'rec-mara'])
  assert.deepEqual(hmMetadata.hiringManagerIds, ['hm-lee', 'hm-ana'])
  assert.deepEqual(hmBlock.element.initial_options.map((option) => option.value), ['hm-lee', 'hm-ana'])
  setJazzhrJobs([])
})

test('shared case creation notification mentions the action owner', async () => {
  setApplicants([{
    id: 'candidate-1',
    firstName: 'Alex',
    lastName: 'Reyes',
    email: 'alex@example.com',
    phone: '0400000000',
    jobTitle: 'Support Specialist',
  }])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
  ])
  setRoleAssignments([{
    roleId: 'job-1',
    roleTitle: 'Support Specialist',
    recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
  }])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])
  setSlackUsers([{ id: 'UACTOR', slackUserId: 'UACTOR', name: 'Scheduler', email: 'scheduler@example.com', role: 'slack_user' }])

  const views = new Map()
  const app = {
    action() {},
    command() {},
    event() {},
    options() {},
    view(id, handler) {
      views.set(id, handler)
    },
    message() {},
  }
  let storedCase
  const store = {
    async createCase(input) {
      storedCase = { id: 'case-1', status: 'Draft', ...input }
      return storedCase
    },
    async updateCase(id, updates) {
      storedCase = { ...storedCase, ...updates }
      return storedCase
    },
    async addAudit() {},
    async listCasesForUser() {
      return []
    },
    async listCases() {
      return []
    },
    async hasGoogleToken() {
      return false
    },
  }
  const posted = []
  registerSlackHandlers(app, {
    config: {
      jazzhr: { liveSearch: {} },
      slack: { postingChannelId: 'CSHARED' },
      google: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
    },
    store,
    logger: silentLogger(),
  })

  await views.get('schedule_intake_submit')({
    ack: async () => {},
    body: { user: { id: 'UACTOR' }, view: { private_metadata: JSON.stringify({ channelId: 'CSHARED' }) } },
    view: {
      private_metadata: JSON.stringify({ channelId: 'CSHARED' }),
      state: {
        values: {
          event_type_block: { event_type_select: { selected_option: { value: '1st-interview' } } },
          role_block: { role_select: { selected_option: { value: 'job-1' } } },
          recruiters_block: {
            recruiter_checkboxes: {
              selected_options: [{ value: 'rec-mara' }],
            },
          },
          applicant_block: { applicant_select: { selected_option: { value: 'candidate-1' } } },
          zoom_block: { zoom_link: { value: 'https://zoom.us/j/mara' } },
          timezone_block: { timezone_select: { selected_option: { value: 'Australia/Sydney' } } },
        },
      },
    },
    client: {
      chat: {
        async postMessage(message) {
          posted.push(message)
          return { channel: message.channel, ts: '123.456' }
        },
      },
      views: {
        async publish() {},
      },
    },
  })

  assert.equal(posted.length, 1)
  assert.match(posted[0].text, /^<@UACTOR> Scheduling case created/)
  assert.equal(posted[0].blocks[0].text.text, 'Action by <@UACTOR>')
  assert.equal((JSON.stringify(posted[0].blocks).match(/<@UACTOR>/g) || []).length, 1)
  setJazzhrJobs([])
  setSlackUsers([])
})

test('shared command result mentions the action owner', async () => {
  const commands = new Map()
  const app = {
    action() {},
    command(id, handler) {
      commands.set(id, handler)
    },
    event() {},
    options() {},
    view() {},
    message() {},
  }
  const posted = []
  registerSlackHandlers(app, {
    config: {
      jazzhr: { liveSearch: {} },
      slack: {},
      google: {},
      recruiterPhoneExport: {},
      roleAssignmentExport: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
    },
    store: {
      async listTalentDirectory() {
        return [{
          id: 'hm-1',
          name: 'Mara Santos',
          email: 'mara@example.com',
          role: 'hiring_manager',
          positionTitle: 'Recruitment Manager',
        }]
      },
    },
    logger: silentLogger(),
  })

  await commands.get('/slack-scheduler')({
    ack: async () => {},
    command: {
      text: 'refresh-directory',
      channel_id: 'CSHARED',
      user_id: 'UACTOR',
    },
    client: {
      chat: {
        async postMessage(message) {
          posted.push(message)
        },
      },
    },
  })

  assert.equal(posted.length, 1)
  assert.match(posted[0].text, /^<@UACTOR> Talent directory refreshed:/)
})

function registerActionHarness() {
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
      jazzhr: { liveSearch: {} },
      slack: {},
      google: {},
      scheduling: { timeZones: ['Australia/Sydney'] },
    },
    store: {},
    logger: silentLogger(),
  })
  return actions
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  }
}

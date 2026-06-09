import test from 'node:test'
import assert from 'node:assert/strict'

import { setApplicants, setHiringManagers, setJazzhrJobs, setRoleAssignments, setTalentRecruiters } from '../src/data/cache.js'
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
            eventType: 'custom-invite',
            candidateSearchError: 'Search expired. Press Search again.',
          }),
          state: {
            values: {
              event_type_block: {
                event_type_select: {
                  selected_option: { value: 'custom-invite' },
                },
              },
              custom_purpose_block: {
                custom_purpose: { value: 'Candidate follow-up' },
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
            return { view: payload.view }
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
  assert.equal(updates.length, 2)
  assert.match(JSON.stringify(updates[0].view.blocks), /Updating form/)
  const updatedView = updates[1].view
  const emailBlock = updatedView.blocks.find((block) => block.block_id?.startsWith('applicant_email_block'))
  assert.equal(emailBlock.element.initial_value, 'niel@example.com')
  assert.match(JSON.stringify(updatedView.blocks), /0400000000/)
  assert.equal(JSON.parse(updatedView.private_metadata).candidateSearchError, '')
  assert.equal(JSON.parse(updatedView.private_metadata).remoteUpdateStatus, '')
})

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  }
}

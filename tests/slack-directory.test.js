import test from 'node:test'
import assert from 'node:assert/strict'
import { getSlackRecruiters, getSlackUsers, setSlackRecruiters, setSlackUsers } from '../src/data/cache.js'
import { ensureSlackDirectory, normalizeSlackUser } from '../src/services/slack-directory.js'

test('normalizeSlackUser maps Slack profile email and skips inactive users', () => {
  const normalized = normalizeSlackUser({
    id: 'U123',
    name: 'fallback',
    profile: {
      real_name_normalized: 'Ana Cruz',
      email: 'ana@opg.com',
      title: 'Operations Manager',
      image_72: 'https://example.com/avatar.png',
    },
  })

  assert.equal(normalized.id, 'U123')
  assert.equal(normalized.email, 'ana@opg.com')
  assert.equal(normalized.name, 'Ana Cruz')
  assert.equal(normalized.positionTitle, 'Operations Manager')
  assert.equal(normalizeSlackUser({ id: 'B1', is_bot: true, profile: {} }), null)
  assert.equal(normalizeSlackUser({ id: 'D1', deleted: true, profile: {} }), null)
})

test('ensureSlackDirectory limits recruiters to recruitment channel members', async () => {
  setSlackUsers([])
  setSlackRecruiters([])

  const client = {
    users: {
      async list() {
        return {
          members: [
            { id: 'U1', profile: { real_name_normalized: 'Recruiter One', email: 'rec1@opg.com' } },
            { id: 'U2', profile: { real_name_normalized: 'HM Two', email: 'hm2@opg.com' } },
            { id: 'B1', is_bot: true, profile: { real_name_normalized: 'Bot', email: 'bot@opg.com' } },
          ],
          response_metadata: { next_cursor: '' },
        }
      },
    },
    conversations: {
      async members({ channel }) {
        assert.equal(channel, 'C-recruiting')
        return {
          members: ['U1', 'B1'],
          response_metadata: { next_cursor: '' },
        }
      },
    },
  }

  const logger = { info() {}, warn() {} }
  const result = await ensureSlackDirectory({
    client,
    logger,
    force: true,
    config: { slack: { recruitmentChannelId: 'C-recruiting' } },
  })

  assert.equal(result.users.length, 2)
  assert.equal(result.recruiters.length, 1)
  assert.equal(result.recruiters[0].id, 'U1')
  assert.equal(result.recruiters[0].email, 'rec1@opg.com')
  assert.equal(getSlackUsers().length, 2)
  assert.equal(getSlackRecruiters().length, 1)
})

test('ensureSlackDirectory does not fall back to all users when recruiter channel scope is missing', async () => {
  setSlackUsers([])
  setSlackRecruiters([])

  const client = {
    users: {
      async list() {
        return {
          members: [
            { id: 'U1', profile: { real_name_normalized: 'Recruiter One', email: 'rec1@opg.com' } },
            { id: 'U2', profile: { real_name_normalized: 'HM Two', email: 'hm2@opg.com' } },
          ],
          response_metadata: { next_cursor: '' },
        }
      },
    },
    conversations: {
      async members() {
        const error = new Error('An API error occurred: missing_scope')
        error.data = { error: 'missing_scope' }
        throw error
      },
    },
  }

  const warnings = []
  const logger = {
    info() {},
    warn(event, data) {
      warnings.push({ event, data })
    },
  }
  const result = await ensureSlackDirectory({
    client,
    logger,
    force: true,
    config: { slack: { recruitmentChannelId: 'C-recruiting' } },
  })

  assert.equal(result.users.length, 2)
  assert.equal(result.recruiters.length, 0)
  assert.equal(getSlackRecruiters().length, 0)
  assert.equal(warnings[0].event, 'slack_recruitment_channel_missing_scope')
})

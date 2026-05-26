import test from 'node:test'
import assert from 'node:assert/strict'
import { getSlackUsers, setSlackUsers } from '../src/data/cache.js'
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

test('ensureSlackDirectory loads active Slack users without recruitment channel lookup', async () => {
  setSlackUsers([])

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
      async members() {
        throw new Error('conversations.members should not be called')
      },
    },
  }

  const logger = { info() {}, warn() {} }
  const result = await ensureSlackDirectory({
    client,
    logger,
    force: true,
    config: { slack: {} },
  })

  assert.equal(result.users.length, 2)
  assert.equal(result.recruiters.length, 0)
  assert.equal(getSlackUsers().length, 2)
})

test('ensureSlackDirectory ignores recruitment channel config and does not warn on missing scope', async () => {
  setSlackUsers([])

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
    config: { slack: {} },
  })

  assert.equal(result.users.length, 2)
  assert.equal(result.recruiters.length, 0)
  assert.equal(warnings.length, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getRecruitmentSheetPeople,
  getSlackRecruiters,
  getSlackUsers,
  setRecruitmentSheetPeople,
  setSlackRecruiters,
  setSlackUsers,
} from '../src/data/cache.js'
import {
  ensureRecruitmentSlackDirectory,
  ensureSlackDirectory,
  normalizeSlackUser,
  slackApiErrorDetails,
} from '../src/services/slack-directory.js'

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

test('ensureRecruitmentSlackDirectory matches active Slack users to recruitment sheet people', async () => {
  setSlackUsers([])
  setSlackRecruiters([])
  setRecruitmentSheetPeople([
    { id: 'sheet-1', name: 'Recruiter One', email: 'rec1@opg.com' },
    { id: 'sheet-2', name: 'Recruiter Two', email: 'rec2@other-domain.com' },
  ])
  const listCalls = []
  const client = {
    users: {
      async list(args) {
        listCalls.push(args)
        return {
          members: [
            { id: 'U1', profile: { real_name_normalized: 'Recruiter One', email: 'rec1@opg.com' } },
            { id: 'U2', profile: { real_name_normalized: 'Recruiter Two', email: 'rec2@slack-domain.com' } },
            { id: 'U3', profile: { real_name_normalized: 'Operations User', email: 'ops@opg.com' } },
            { id: 'B1', is_bot: true, profile: { real_name_normalized: 'Bot', email: 'bot@opg.com' } },
          ],
          response_metadata: { next_cursor: '' },
        }
      },
    },
  }

  const result = await ensureRecruitmentSlackDirectory({
    client,
    logger: { info() {}, warn() {} },
    force: true,
    config: { slack: { teamId: 'T1' } },
  })

  assert.deepEqual(listCalls, [{ limit: 200, team_id: 'T1' }])
  assert.deepEqual(result.users.map((user) => user.id), ['U1', 'U2'])
  assert.deepEqual(getSlackRecruiters().map((user) => user.id), ['U1', 'U2'])
  assert.equal(getRecruitmentSheetPeople().length, 2)
})

test('ensureSlackDirectory retries users.list with resolved team id when Slack requires it', async () => {
  setSlackUsers([])

  const listArgs = []
  const client = {
    auth: {
      async test() {
        return { team_id: 'T123' }
      },
    },
    users: {
      async list(args) {
        listArgs.push(args)
        if (!args.team_id) {
          const error = new Error('An API error occurred: missing_argument')
          error.data = { error: 'missing_argument', needed: 'team_id', provided: 'limit' }
          throw error
        }
        return {
          members: [
            { id: 'U1', profile: { real_name_normalized: 'Recruiter One', email: 'rec1@opg.com' } },
          ],
          response_metadata: { next_cursor: '' },
        }
      },
    },
  }

  const infos = []
  const logger = {
    info(event) {
      infos.push(event)
    },
    warn() {},
  }

  const result = await ensureSlackDirectory({
    client,
    logger,
    force: true,
    config: { slack: {} },
  })

  assert.equal(result.users.length, 1)
  assert.deepEqual(listArgs, [{ limit: 200 }, { limit: 200, team_id: 'T123' }])
  assert.ok(infos.includes('slack_directory_team_id_resolved'))
})

test('ensureSlackDirectory includes configured Slack team id on users.list calls', async () => {
  setSlackUsers([])

  const listArgs = []
  const client = {
    users: {
      async list(args) {
        listArgs.push(args)
        return {
          members: [],
          response_metadata: { next_cursor: '' },
        }
      },
    },
  }

  const logger = { info() {}, warn() {} }
  await ensureSlackDirectory({
    client,
    logger,
    force: true,
    config: { slack: { teamId: 'T456' } },
  })

  assert.deepEqual(listArgs, [{ limit: 200, team_id: 'T456' }])
})

test('slackApiErrorDetails omits raw Error objects and preserves Slack error codes', () => {
  const error = new Error('An API error occurred: team_access_not_granted')
  error.data = {
    error: 'team_access_not_granted',
    needed: 'team_id',
    provided: 'limit',
  }

  assert.deepEqual(slackApiErrorDetails(error), {
    error: 'An API error occurred: team_access_not_granted',
    slackError: 'team_access_not_granted',
    needed: 'team_id',
    provided: 'limit',
  })
})

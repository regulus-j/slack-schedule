import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/store/json-store.js'
import { buildSafeEmailHeaders } from '../src/security/email-headers.js'
import { consumeOAuthState, issueOAuthState } from '../src/security/oauth-state.js'
import {
  classifyRateLimit,
  installSlackSecurityMiddleware,
  isAdminUser,
  isRecruitmentUser,
} from '../src/security/slack-access.js'

test('authorization separates recruitment and administrator membership', () => {
  const config = {
    security: {
      accessControlEnforced: true,
      recruitmentUserIds: ['URECRUITER'],
      adminUserIds: ['UADMIN'],
    },
  }
  assert.equal(isRecruitmentUser(config, 'URECRUITER'), true)
  assert.equal(isRecruitmentUser(config, 'UADMIN'), true)
  assert.equal(isRecruitmentUser(config, 'UOUTSIDER'), false)
  assert.equal(isAdminUser(config, 'URECRUITER'), false)
  assert.equal(isAdminUser(config, 'UADMIN'), true)
})

test('Slack middleware blocks an unauthorized forged case action before next handler', async () => {
  let middleware
  installSlackSecurityMiddleware({
    use(handler) {
      middleware = handler
    },
  }, {
    config: {
      security: {
        accessControlEnforced: true,
        recruitmentUserIds: ['URECRUITER'],
        adminUserIds: [],
      },
    },
    store: {},
    logger: { warn() {} },
  })
  let acked = false
  let nextCalled = false
  await middleware({
    action: { action_id: 'view_case_details' },
    body: {
      user: { id: 'UOUTSIDER' },
      actions: [{ value: 'case-forged' }],
    },
    ack: async () => { acked = true },
    next: async () => { nextCalled = true },
  })
  assert.equal(acked, true)
  assert.equal(nextCalled, false)
})

test('rate-limit classes distinguish reads, mutations, side effects, and admin operations', () => {
  assert.equal(classifyRateLimit({ event: { type: 'app_home_opened' } }), 'read')
  assert.equal(classifyRateLimit({ action: { action_id: 'candidate_search_submit' } }), 'mutation')
  assert.equal(classifyRateLimit({ action: { action_id: 'cancel_interview' } }), 'sideEffect')
  assert.equal(classifyRateLimit({ command: { command: '/slack-scheduler' } }), 'admin')
})

test('JSON store enforces persisted fixed-window rate limits', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'security-rate-limit-'))
  const store = createJsonStore(runtimeDir)
  try {
    await store.init()
    const first = await store.consumeRateLimit({
      userId: 'UONE',
      bucket: 'sideEffect',
      limit: 2,
      windowMs: 60000,
      now: '2026-06-23T00:00:00.000Z',
    })
    const second = await store.consumeRateLimit({
      userId: 'UONE',
      bucket: 'sideEffect',
      limit: 2,
      windowMs: 60000,
      now: '2026-06-23T00:00:01.000Z',
    })
    const third = await store.consumeRateLimit({
      userId: 'UONE',
      bucket: 'sideEffect',
      limit: 2,
      windowMs: 60000,
      now: '2026-06-23T00:00:02.000Z',
    })
    assert.equal(first.allowed, true)
    assert.equal(second.allowed, true)
    assert.equal(third.allowed, false)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test('JSON store recovers from backup when state file is truncated', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'security-json-recovery-'))
  try {
    await writeFile(path.join(runtimeDir, 'state.json'), '{"cases": [')
    await writeFile(path.join(runtimeDir, 'state.json.bak'), JSON.stringify({
      cases: [{ id: 'case-existing', approvals: [], guests: [] }],
      audits: [{ id: 'audit-existing', caseId: 'case-existing' }],
      jazzhrCandidates: [],
    }))

    const store = createJsonStore(runtimeDir)
    await store.init()
    const stats = await store.stats()
    const files = await readdir(runtimeDir)

    assert.equal(stats.cases, 1)
    assert.equal(stats.audits, 1)
    assert.ok(files.some((file) => file.startsWith('state.corrupt-')))
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test('OAuth state is opaque, single-use, team-bound, and expires', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'security-oauth-state-'))
  const store = createJsonStore(runtimeDir)
  try {
    await store.init()
    const token = await issueOAuthState({
      store,
      slackUserId: 'UONE',
      teamId: 'TONE',
      tokenOwnerId: 'USHARED',
      now: new Date('2026-06-23T00:00:00.000Z'),
    })
    assert.doesNotMatch(token, /UONE|USHARED|TONE/)
    assert.equal(await consumeOAuthState({
      store,
      token,
      expectedTeamId: 'TOTHER',
      now: new Date('2026-06-23T00:01:00.000Z'),
    }), null)
    const consumed = await consumeOAuthState({
      store,
      token,
      expectedTeamId: 'TONE',
      now: new Date('2026-06-23T00:01:00.000Z'),
    })
    assert.equal(consumed.tokenOwnerId, 'USHARED')
    assert.equal(await consumeOAuthState({
      store,
      token,
      expectedTeamId: 'TONE',
      now: new Date('2026-06-23T00:02:00.000Z'),
    }), null)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test('email headers reject injection and encode Unicode subjects', () => {
  assert.throws(
    () => buildSafeEmailHeaders({
      to: 'candidate@example.com',
      from: 'recruiter@example.com',
      subject: 'Interview\r\nBcc: attacker@example.com',
    }),
    /control characters/,
  )
  const safe = buildSafeEmailHeaders({
    to: 'Candidate <candidate@example.com>',
    cc: ['manager@example.com'],
    from: 'recruiter@example.com',
    subject: 'Interview for José',
  })
  assert.match(safe.subject, /^=\?UTF-8\?B\?/)
  assert.equal(safe.to, 'Candidate <candidate@example.com>')
})

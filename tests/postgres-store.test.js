import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_DATABASE_URL,
  HAS_TEST_DB,
  ensureTestMigrations,
  truncateTestTables,
  createTestConfig,
  createTestTokenCipher,
  createTestPostgresStore,
  createTestPool,
} from './helpers/postgres-store.js'

const skip = !HAS_TEST_DB

test.describe('PostgresStore', { skip }, () => {
  let pool
  let store

  test.before(async () => {
    pool = await createTestPool()
    await ensureTestMigrations(pool)
  })

  test.beforeEach(async () => {
    await truncateTestTables(pool)
    store = createTestPostgresStore()
    await store.init()
  })

  test.afterEach(async () => {
    if (store) await store.close()
  })

  test.after(async () => {
    if (pool) await pool.end()
  })

  // -- Case lifecycle --

  test('createCase creates a case with defaults', async () => {
    const result = await store.createCase({
      ownerSlackUserId: 'U001',
      channelId: 'C001',
    })

    assert.ok(result.id.startsWith('case-'))
    assert.equal(result.status, 'Draft')
    assert.equal(result.ownerSlackUserId, 'U001')
    assert.equal(result.channelId, 'C001')
    assert.ok(result.createdAt)
    assert.ok(result.updatedAt)
    assert.equal(result.scheduleVersion, 0)
    assert.equal(result.rescheduleStatus, 'none')
    assert.deepEqual(result.approvals, [])
    assert.deepEqual(result.guests, [])
    assert.deepEqual(result.scheduleHistory, [])
    assert.deepEqual(result.attendees, [])
    assert.deepEqual(result.externalAttendees, [])
    assert.equal(result.legalHold, false)
  })

  test('createCase stores JSONB columns as objects', async () => {
    const applicant = { fullName: 'Jane Doe', email: 'jane@test.com' }
    const recruiter = { fullName: 'Rec R', slackUserId: 'U-REC' }
    const hiringManager = { fullName: 'HM H', email: 'hm@test.com' }
    const approvals = [{ approver: 'U-APP', status: 'pending' }]
    const guests = [{ name: 'Guest One', email: 'guest@test.com' }]
    const attendees = [{ name: 'Attendee A', email: 'a@test.com' }]

    const result = await store.createCase({
      ownerSlackUserId: 'U002',
      channelId: 'C002',
      applicant,
      recruiter,
      hiringManager,
      approvals,
      guests,
      attendees,
    })

    assert.deepEqual(result.applicant, applicant)
    assert.deepEqual(result.recruiter, recruiter)
    assert.deepEqual(result.hiringManager, hiringManager)
    assert.deepEqual(result.approvals, approvals)
    assert.deepEqual(result.guests, guests)
    assert.deepEqual(result.attendees, attendees)
  })

  test('getCase returns a case by id', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U003', channelId: 'C003' })
    const fetched = await store.getCase(created.id)

    assert.equal(fetched.id, created.id)
    assert.equal(fetched.ownerSlackUserId, 'U003')
  })

  test('getCase returns undefined for nonexistent id', async () => {
    const fetched = await store.getCase('case-nonexistent')
    assert.equal(fetched, undefined)
  })

  test('listCases returns cases ordered by created_at DESC', async () => {
    const a = await store.createCase({ ownerSlackUserId: 'U-A', channelId: 'C-A' })
    const b = await store.createCase({ ownerSlackUserId: 'U-B', channelId: 'C-B' })

    const cases = await store.listCases()
    assert.ok(cases.length >= 2)
    const ids = cases.map((c) => c.id)
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id))
  })

  test('listCasesForUser filters by owner', async () => {
    await store.createCase({ ownerSlackUserId: 'U-ALICE', channelId: 'C-1' })
    await store.createCase({ ownerSlackUserId: 'U-BOB', channelId: 'C-2' })
    await store.createCase({ ownerSlackUserId: 'U-ALICE', channelId: 'C-3' })

    const aliceCases = await store.listCasesForUser('U-ALICE')
    assert.equal(aliceCases.length, 2)
    for (const c of aliceCases) {
      assert.equal(c.ownerSlackUserId, 'U-ALICE')
    }
  })

  test('updateCase patches fields and bumps updatedAt', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U004', channelId: 'C004' })
    const updated = await store.updateCase(created.id, { status: 'Scheduled', notes: 'new note' })

    assert.equal(updated.status, 'Scheduled')
    assert.equal(updated.notes, 'new note')
    assert.ok(new Date(updated.updatedAt) >= new Date(created.updatedAt))
  })

  test('updateCase round-trips JSONB columns', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U005', channelId: 'C005' })
    const patch = {
      applicant: { fullName: 'Updated Name', email: 'updated@test.com' },
      currentSchedule: { date: '2026-07-15', time: '10:00' },
      guests: [{ name: 'G', email: 'g@test.com' }],
    }
    const updated = await store.updateCase(created.id, patch)

    assert.deepEqual(updated.applicant, patch.applicant)
    assert.deepEqual(updated.currentSchedule, patch.currentSchedule)
    assert.deepEqual(updated.guests, patch.guests)
  })

  test('updateCase throws on nonexistent id', async () => {
    await assert.rejects(
      () => store.updateCase('case-nonexistent', { status: 'Scheduled' }),
      /Case not found/,
    )
  })

  // -- Notification jobs --

  test('upsertNotificationJob creates a new job', async () => {
    await store.createCase({ ownerSlackUserId: 'U006', channelId: 'C006' })
    const job = await store.upsertNotificationJob({
      id: 'job-1',
      caseId: 'case-nope',
      type: 'candidate-reminder',
      dueAt: new Date(Date.now() + 3600000).toISOString(),
    })

    assert.equal(job.id, 'job-1')
    assert.equal(job.type, 'candidate-reminder')
    assert.equal(job.status, 'pending')
    assert.equal(job.attempts, 0)
    assert.equal(job.maxAttempts, 5)
  })

  test('upsertNotificationJob re-enqueues completed jobs as pending', async () => {
    const job = await store.upsertNotificationJob({
      id: 'job-r',
      caseId: 'case-r',
      type: 'feedback-request',
      dueAt: new Date().toISOString(),
    })
    assert.equal(job.status, 'pending')

    const poolForUpdate = pool
    await poolForUpdate.query(
      `UPDATE notification_jobs SET status = 'completed', locked_at = NULL WHERE id = 'job-r'`
    )

    const updated = await store.upsertNotificationJob({
      id: 'job-r',
      caseId: 'case-r',
      type: 'feedback-request',
      dueAt: new Date(Date.now() + 7200000).toISOString(),
    })
    assert.equal(updated.status, 'pending')
  })

  test('claimDueNotificationJobs picks pending jobs past due_at', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    await store.upsertNotificationJob({
      id: 'job-2',
      caseId: 'case-2',
      type: 'candidate-reminder',
      dueAt: past,
    })

    const claimed = await store.claimDueNotificationJobs({ now: new Date().toISOString(), limit: 5 })
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, 'job-2')
    assert.equal(claimed[0].status, 'running')
  })

  test('claimDueNotificationJobs skips future jobs', async () => {
    const future = new Date(Date.now() + 3600000).toISOString()
    await store.upsertNotificationJob({
      id: 'job-future',
      caseId: 'case-f',
      type: 'candidate-reminder',
      dueAt: future,
    })

    const claimed = await store.claimDueNotificationJobs({ now: new Date().toISOString(), limit: 5 })
    assert.equal(claimed.length, 0)
  })

  test('claimDueNotificationJobs re-claims expired running jobs', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    await store.upsertNotificationJob({
      id: 'job-stale',
      caseId: 'case-s',
      type: 'candidate-reminder',
      dueAt: past,
    })
    // Manually mark as running with an old lock
    await pool.query(
      `UPDATE notification_jobs SET status = 'running', locked_at = $1 WHERE id = 'job-stale'`,
      [new Date(Date.now() - 600000).toISOString()],
    )

    const claimed = await store.claimDueNotificationJobs({
      now: new Date().toISOString(),
      limit: 5,
      leaseMs: 300000,
    })
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, 'job-stale')
  })

  test('claimDueNotificationJobs skips max-attempted jobs', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    await store.upsertNotificationJob({
      id: 'job-maxed',
      caseId: 'case-max',
      type: 'candidate-reminder',
      dueAt: past,
      maxAttempts: 3,
    })
    await pool.query(
      `UPDATE notification_jobs SET attempts = 5, status = 'failed' WHERE id = 'job-maxed'`
    )

    const claimed = await store.claimDueNotificationJobs({ now: new Date().toISOString(), limit: 5 })
    assert.equal(claimed.length, 0)
  })

  test('finishNotificationJob marks completed', async () => {
    await store.upsertNotificationJob({
      id: 'job-fin',
      caseId: 'case-fin',
      type: 'candidate-reminder',
      dueAt: new Date().toISOString(),
    })

    const finished = await store.finishNotificationJob('job-fin', { sent: true })
    assert.equal(finished.status, 'completed')
    assert.ok(finished.completedAt)
    assert.equal(finished.lastError, null)
  })

  test('finishNotificationJob returns null for nonexistent id', async () => {
    const result = await store.finishNotificationJob('nonexistent')
    assert.equal(result, null)
  })

  test('retryNotificationJob resets to pending', async () => {
    await store.upsertNotificationJob({
      id: 'job-retry',
      caseId: 'case-retry',
      type: 'candidate-reminder',
      dueAt: new Date().toISOString(),
    })
    await pool.query(
      `UPDATE notification_jobs SET status = 'running', attempts = 1 WHERE id = 'job-retry'`
    )

    const retried = await store.retryNotificationJob('job-retry', {
      dueAt: new Date(Date.now() + 1800000).toISOString(),
      error: 'timeout',
    })
    assert.equal(retried.status, 'pending')
    assert.equal(retried.lastError, 'timeout')
    assert.equal(retried.lockedAt, null)
  })

  test('retryNotificationJob fails when max attempts reached', async () => {
    await store.upsertNotificationJob({
      id: 'job-fail',
      caseId: 'case-fail',
      type: 'candidate-reminder',
      dueAt: new Date().toISOString(),
      maxAttempts: 2,
    })
    await pool.query(
      `UPDATE notification_jobs SET status = 'running', attempts = 2 WHERE id = 'job-fail'`
    )

    const failed = await store.retryNotificationJob('job-fail', { error: 'exhausted' })
    assert.equal(failed.status, 'failed')
  })

  test('cancelNotificationJobs cancels pending/running/failed jobs', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    await store.upsertNotificationJob({
      id: 'job-c1',
      caseId: 'case-cancel',
      type: 'candidate-reminder',
      scheduleVersion: 1,
      dueAt: past,
    })
    await store.upsertNotificationJob({
      id: 'job-c2',
      caseId: 'case-cancel',
      type: 'feedback-request',
      scheduleVersion: 2,
      dueAt: new Date().toISOString(),
    })

    const count = await store.cancelNotificationJobs('case-cancel')
    assert.ok(count >= 2)
  })

  test('cancelNotificationJobs respects exceptScheduleVersion', async () => {
    await store.upsertNotificationJob({
      id: 'job-ex1',
      caseId: 'case-ex',
      type: 'candidate-reminder',
      scheduleVersion: 1,
      dueAt: new Date().toISOString(),
    })
    await store.upsertNotificationJob({
      id: 'job-ex2',
      caseId: 'case-ex',
      type: 'candidate-reminder',
      scheduleVersion: 2,
      dueAt: new Date().toISOString(),
    })

    await store.cancelNotificationJobs('case-ex', { exceptScheduleVersion: 2 })

    const afterCancel = await pool.query(
      `SELECT id, status FROM notification_jobs WHERE case_id = 'case-ex' ORDER BY id`
    )
    const job1 = afterCancel.rows.find((r) => r.id === 'job-ex1')
    const job2 = afterCancel.rows.find((r) => r.id === 'job-ex2')
    assert.equal(job1.status, 'cancelled')
    assert.equal(job2.status, 'pending')
  })

  // -- Case completion --

  test('completeCase marks case as Completed and cancels non-feedback jobs', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U007', channelId: 'C007' })
    await store.updateCase(created.id, { status: 'Scheduled', scheduleVersion: 1 })
    await store.upsertNotificationJob({
      id: 'job-comp1',
      caseId: created.id,
      type: 'candidate-reminder',
      scheduleVersion: 1,
      dueAt: new Date().toISOString(),
    })
    await store.upsertNotificationJob({
      id: 'job-comp2',
      caseId: created.id,
      type: 'completion-reminder',
      scheduleVersion: 1,
      dueAt: new Date().toISOString(),
    })

    const completedAt = new Date().toISOString()
    const result = await store.completeCase(created.id, {
      actorSlackUserId: 'U007',
      expectedScheduleVersion: 1,
      completedAt,
    })

    assert.equal(result.alreadyCompleted, false)
    assert.equal(result.caseRecord.status, 'Completed')
    assert.equal(result.caseRecord.completedAt, completedAt)

    const jobsAfter = await pool.query(
      `SELECT id, status FROM notification_jobs WHERE case_id = $1`,
      [created.id],
    )
    const statuses = jobsAfter.rows.map((r) => r.status)
    assert.ok(statuses.every((s) => s === 'cancelled'))
  })

  test('completeCase returns alreadyCompleted on double-complete', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U008', channelId: 'C008' })
    await store.updateCase(created.id, { status: 'Scheduled' })

    const completedAt = new Date().toISOString()
    await store.completeCase(created.id, { actorSlackUserId: 'U008', completedAt })
    const second = await store.completeCase(created.id, { actorSlackUserId: 'U008', completedAt })

    assert.equal(second.alreadyCompleted, true)
    assert.equal(second.caseRecord.status, 'Completed')
  })

  test('completeCase returns stale on version mismatch', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U009', channelId: 'C009' })
    await store.updateCase(created.id, { status: 'Scheduled', scheduleVersion: 5 })

    const result = await store.completeCase(created.id, {
      actorSlackUserId: 'U009',
      expectedScheduleVersion: 3,
      completedAt: new Date().toISOString(),
    })

    assert.equal(result.stale, true)
    assert.equal(result.caseRecord.status, 'Scheduled')
  })

  test('completeCase creates feedback job when supplied', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U010', channelId: 'C010' })
    await store.updateCase(created.id, { status: 'Scheduled' })

    const feedbackJob = {
      id: 'feedback-job-1',
      type: 'feedback-request',
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      payload: { template: 'default' },
    }

    await store.completeCase(created.id, {
      actorSlackUserId: 'U010',
      completedAt: new Date().toISOString(),
      feedbackJob,
    })

    const jobs = await pool.query(
      `SELECT id, type, status FROM notification_jobs WHERE case_id = $1`,
      [created.id],
    )
    const fb = jobs.rows.find((r) => r.id === 'feedback-job-1')
    assert.ok(fb)
    assert.equal(fb.type, 'feedback-request')
    assert.equal(fb.status, 'pending')
  })

  test('completeCase throws on nonexistent id', async () => {
    await assert.rejects(
      () => store.completeCase('case-nonexistent', { completedAt: new Date().toISOString() }),
      /Case not found/,
    )
  })

  // -- OAuth state machine --

  test('createOAuthState and consumeOAuthState round-trip', async () => {
    const record = {
      stateHash: 'hash-abc',
      slackUserId: 'U-SLACK',
      teamId: 'T-TEAM',
      tokenOwnerId: 'U-OWNER',
      source: 'slack',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    }

    const created = await store.createOAuthState(record)
    assert.equal(created.stateHash, 'hash-abc')
    assert.equal(created.slackUserId, 'U-SLACK')

    const consumed = await store.consumeOAuthState('hash-abc')
    assert.ok(consumed)
    assert.ok(consumed.consumedAt)
  })

  test('consumeOAuthState returns null for expired states', async () => {
    await store.createOAuthState({
      stateHash: 'hash-expired',
      slackUserId: 'U-S',
      teamId: '',
      tokenOwnerId: 'U-O',
      source: 'slack',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    })

    const result = await store.consumeOAuthState('hash-expired', {
      now: new Date().toISOString(),
    })
    assert.equal(result, null)
  })

  test('consumeOAuthState returns null for already-consumed state', async () => {
    await store.createOAuthState({
      stateHash: 'hash-twice',
      slackUserId: 'U-S',
      teamId: '',
      tokenOwnerId: 'U-O',
      source: 'slack',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })

    await store.consumeOAuthState('hash-twice')
    const second = await store.consumeOAuthState('hash-twice')
    assert.equal(second, null)
  })

  test('consumeOAuthState respects expectedTeamId', async () => {
    await store.createOAuthState({
      stateHash: 'hash-team',
      slackUserId: 'U-S',
      teamId: 'T-CORRECT',
      tokenOwnerId: 'U-O',
      source: 'slack',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })

    const wrongTeam = await store.consumeOAuthState('hash-team', { expectedTeamId: 'T-WRONG' })
    assert.equal(wrongTeam, null)

    const correctTeam = await store.consumeOAuthState('hash-team', { expectedTeamId: 'T-CORRECT' })
    assert.ok(correctTeam)
  })

  // -- Google tokens --

  test('saveGoogleToken and getGoogleToken round-trip', async () => {
    const tokenData = { access_token: 'ya29.test', refresh_token: '1/refresh', expiry_date: Date.now() + 3600000 }
    await store.saveGoogleToken('rec-U-TOK', tokenData)

    const retrieved = await store.getGoogleToken('rec-U-TOK')
    assert.deepEqual(retrieved, tokenData)
  })

  test('hasGoogleToken returns boolean', async () => {
    assert.equal(await store.hasGoogleToken('rec-nonexistent'), false)

    await store.saveGoogleToken('rec-U-HAS', { access_token: 'tok' })
    assert.equal(await store.hasGoogleToken('rec-U-HAS'), true)
  })

  test('Google account email IDs resolve tokens saved by the shared OAuth owner', async () => {
    const tokenData = {
      access_token: 'account-token',
      account_email: 'calendar@example.com',
      label: 'Shared calendar',
    }
    await store.saveGoogleToken('U-SHARED', tokenData)

    assert.equal(await store.hasGoogleToken('calendar@example.com'), true)
    assert.deepEqual(await store.getGoogleToken('calendar@example.com'), tokenData)
    assert.deepEqual(await store.listGoogleTokenIds(), ['calendar@example.com'])
  })

  test('getGoogleToken returns null for missing token', async () => {
    const result = await store.getGoogleToken('rec-nonexistent')
    assert.equal(result, null)
  })

  test('listGoogleTokenIds returns sorted array', async () => {
    await store.saveGoogleToken('rec-U-C', { access_token: 'c' })
    await store.saveGoogleToken('rec-U-A', { access_token: 'a' })
    await store.saveGoogleToken('rec-U-B', { access_token: 'b' })

    const ids = await store.listGoogleTokenIds()
    assert.deepEqual(ids, ['rec-U-A', 'rec-U-B', 'rec-U-C'])
  })

  test('deleteGoogleToken removes token', async () => {
    await store.saveGoogleToken('rec-U-DEL', { access_token: 'del-me' })
    assert.equal(await store.hasGoogleToken('rec-U-DEL'), true)

    await store.deleteGoogleToken('rec-U-DEL')
    assert.equal(await store.hasGoogleToken('rec-U-DEL'), false)
  })

  test('saveGoogleToken overwrites existing token', async () => {
    await store.saveGoogleToken('rec-U-OW', { access_token: 'old' })
    await store.saveGoogleToken('rec-U-OW', { access_token: 'new' })

    const retrieved = await store.getGoogleToken('rec-U-OW')
    assert.equal(retrieved.access_token, 'new')
  })

  // -- Rate limiting --

  test('consumeRateLimit allows requests under limit', async () => {
    const result = await store.consumeRateLimit({
      userId: 'U-RL',
      bucket: 'search',
      limit: 5,
      windowMs: 60000,
    })
    assert.equal(result.allowed, true)
    assert.equal(result.count, 1)
  })

  test('consumeRateLimit blocks requests over limit', async () => {
    const opts = { userId: 'U-RL2', bucket: 'api', limit: 2, windowMs: 60000 }
    await store.consumeRateLimit(opts)
    await store.consumeRateLimit(opts)
    const blocked = await store.consumeRateLimit(opts)
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.count, 3)
  })

  test('consumeRateLimit returns retryAfterMs', async () => {
    const result = await store.consumeRateLimit({
      userId: 'U-RL3',
      bucket: 'export',
      limit: 10,
      windowMs: 3600000,
    })
    assert.ok(typeof result.retryAfterMs === 'number')
    assert.ok(result.retryAfterMs > 0)
  })

  // -- JazzHR candidates --

  test('saveJazzhrCandidates replaces all and returns count', async () => {
    const candidates = [
      { candidateKey: 'ck-1', jazzhrApplicationId: 'app-1', fullName: 'Alpha One', email: 'alpha@test.com', stage: 'Phone Screen', source: 'LinkedIn', appliedAt: new Date().toISOString() },
      { candidateKey: 'ck-2', jazzhrApplicationId: 'app-2', fullName: 'Beta Two', email: 'beta@test.com', stage: 'Offer', source: 'Referral', appliedAt: new Date().toISOString() },
    ]
    const count = await store.saveJazzhrCandidates(candidates)
    assert.equal(count, 2)

    const listed = await store.listJazzhrCandidates()
    assert.equal(listed.length, 2)
  })

  test('saveJazzhrCandidates clears previous records', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-old', jazzhrApplicationId: 'app-old', fullName: 'Old', email: 'old@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-new', jazzhrApplicationId: 'app-new', fullName: 'New', email: 'new@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])
    const listed = await store.listJazzhrCandidates()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].candidateKey, 'ck-new')
  })

  test('upsertJazzhrCandidates merges by candidate_key', async () => {
    await store.upsertJazzhrCandidates([
      { candidateKey: 'ck-up', jazzhrApplicationId: 'app-up', fullName: 'Upsert Me', email: 'up@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])
    await store.upsertJazzhrCandidates([
      { candidateKey: 'ck-up', jazzhrApplicationId: 'app-up', fullName: 'Upserted Name', email: 'up@test.com', stage: 'Phone Screen', source: 'LinkedIn', appliedAt: new Date().toISOString() },
    ])
    const result = await store.getJazzhrCandidate('ck-up')
    assert.equal(result.fullName, 'Upserted Name')
    assert.equal(result.stage, 'Phone Screen')
  })

  test('replaceJazzhrJobCandidates replaces per job and removes stale', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-j1', jazzhrApplicationId: 'app-j1', jazzhrJobId: 'job-A', fullName: 'Job A One', email: 'a1@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
      { candidateKey: 'ck-j2', jazzhrApplicationId: 'app-j2', jazzhrJobId: 'job-B', fullName: 'Job B One', email: 'b1@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])
    await store.replaceJazzhrJobCandidates('job-A', [
      { candidateKey: 'ck-j3', jazzhrApplicationId: 'app-j3', jazzhrJobId: 'job-A', fullName: 'Job A New', email: 'a2@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])
    // job-A should have only the new candidate, job-B should be unchanged
    const all = await store.listJazzhrCandidates()
    const jobACandidates = all.filter((c) => c.jazzhrJobId === 'job-A')
    const jobBCandidates = all.filter((c) => c.jazzhrJobId === 'job-B')
    assert.equal(jobACandidates.length, 1)
    assert.equal(jobACandidates[0].candidateKey, 'ck-j3')
    assert.equal(jobBCandidates.length, 1)
    assert.equal(jobBCandidates[0].candidateKey, 'ck-j2')
  })

  test('searchJazzhrCandidates matches by ILIKE', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-search', jazzhrApplicationId: 'app-search', fullName: 'Searchable Name', email: 'search@test.com', jobTitle: 'Engineer', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
      { candidateKey: 'ck-other', jazzhrApplicationId: 'app-other', fullName: 'Other Person', email: 'other@test.com', jobTitle: 'Manager', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])

    const results = await store.searchJazzhrCandidates('searchable')
    assert.equal(results.length, 1)
    assert.equal(results[0].candidateKey, 'ck-search')
  })

  test('searchJazzhrCandidates matches by email ILIKE', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-email', jazzhrApplicationId: 'app-email', fullName: 'Email Test', email: 'unique.email@test.com', jobTitle: 'Role', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])

    const results = await store.searchJazzhrCandidates('unique.email')
    assert.equal(results.length, 1)
    assert.equal(results[0].candidateKey, 'ck-email')
  })

  test('searchJazzhrCandidates filters by roleId', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-rid1', jazzhrApplicationId: 'app-rid1', jazzhrJobId: 'job-R1', fullName: 'Role One', email: 'r1@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
      { candidateKey: 'ck-rid2', jazzhrApplicationId: 'app-rid2', jazzhrJobId: 'job-R2', fullName: 'Role Two', email: 'r2@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])

    const results = await store.searchJazzhrCandidates('', { roleId: 'job-R1' })
    assert.equal(results.length, 1)
    assert.equal(results[0].candidateKey, 'ck-rid1')
  })

  test('getJazzhrCandidate finds by candidateKey or applicationId', async () => {
    await store.saveJazzhrCandidates([
      { candidateKey: 'ck-get', jazzhrApplicationId: 'app-get', fullName: 'Get Me', email: 'get@test.com', stage: 'New Lead', source: '', appliedAt: new Date().toISOString() },
    ])

    const byKey = await store.getJazzhrCandidate('ck-get')
    assert.ok(byKey)
    assert.equal(byKey.fullName, 'Get Me')

    const byAppId = await store.getJazzhrCandidate('app-get')
    assert.ok(byAppId)
    assert.equal(byAppId.candidateKey, 'ck-get')
  })

  test('getJazzhrCandidate returns null for nonexistent', async () => {
    const result = await store.getJazzhrCandidate('nonexistent-id')
    assert.equal(result, null)
  })

  // -- Talent directory --

  test('listTalentDirectory returns array from talent_directory table', async () => {
    await pool.query(
      `INSERT INTO talent_directory (first_name, last_name, designation, department, work_email)
       VALUES ('John', 'Doe', 'CTO', 'Engineering', 'john@company.com'),
              ('Jane', 'Smith', 'VP', 'Product', 'jane@company.com')`
    )

    const results = await store.listTalentDirectory()
    assert.ok(Array.isArray(results))
    assert.ok(results.length >= 2)
    for (const r of results) {
      assert.ok(r.id)
      assert.ok(r.name)
      assert.ok(r.email)
      assert.equal(r.role, 'hiring_manager')
    }
  })

  test('listTalentDirectory filters out rows without name or email', async () => {
    await truncateTestTables(pool)
    await pool.query(
      `INSERT INTO talent_directory (first_name, last_name, designation, department, work_email)
       VALUES ('', '', '', '', ''),
              ('Valid', 'Name', 'Role', 'Dept', 'valid@company.com')`
    )

    const results = await store.listTalentDirectory()
    assert.equal(results.length, 1)
    assert.equal(results[0].email, 'valid@company.com')
  })

  // -- Retention / purge --

  test('purgeRetention dryRun reports counts without deleting', async () => {
    const oldDate = new Date(Date.now() - 400 * 86400000).toISOString()
    await store.createCase({ ownerSlackUserId: 'U-RET', channelId: 'C-RET' })
    await pool.query(
      `UPDATE scheduling_cases SET status = 'Completed', completed_at = $1`,
      [oldDate],
    )

    const result = await store.purgeRetention({ dryRun: true })
    assert.equal(result.dryRun, true)
    assert.ok(result.cases >= 1)

    const after = await store.listCases()
    assert.ok(after.length >= 1)
  })

  test('purgeRetention deletes when dryRun is false', async () => {
    const oldDate = new Date(Date.now() - 400 * 86400000).toISOString()
    const created = await store.createCase({ ownerSlackUserId: 'U-PURGE', channelId: 'C-PURGE' })
    await pool.query(
      `UPDATE scheduling_cases SET status = 'Completed', completed_at = $1 WHERE id = $2`,
      [oldDate, created.id],
    )

    const result = await store.purgeRetention({ dryRun: false })
    assert.equal(result.dryRun, false)
    const fetched = await store.getCase(created.id)
    assert.equal(fetched, undefined)
  })

  test('purgeRetention preserves legal hold cases', async () => {
    const oldDate = new Date(Date.now() - 400 * 86400000).toISOString()
    const created = await store.createCase({ ownerSlackUserId: 'U-LEGAL', channelId: 'C-LEGAL' })
    await pool.query(
      `UPDATE scheduling_cases SET status = 'Completed', completed_at = $1, legal_hold = true WHERE id = $2`,
      [oldDate, created.id],
    )

    await store.purgeRetention({ dryRun: false })
    const fetched = await store.getCase(created.id)
    assert.ok(fetched)
  })

  // -- Audit trail --

  test('addAudit stores an audit event', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U-AUD', channelId: 'C-AUD' })
    const audit = await store.addAudit({
      caseId: created.id,
      actorSlackUserId: 'U-AUD',
      action: 'case_created',
      extra: 'data',
    })

    assert.ok(audit.id.startsWith('audit-'))
    assert.equal(audit.case_id, created.id)
    assert.equal(audit.action, 'case_created')
  })

  test('listAudits returns most recent events for a case', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U-ALIST', channelId: 'C-ALIST' })
    await store.addAudit({ caseId: created.id, actorSlackUserId: 'U-ALIST', action: 'first' })
    await store.addAudit({ caseId: created.id, actorSlackUserId: 'U-ALIST', action: 'second' })
    await store.addAudit({ caseId: created.id, actorSlackUserId: 'U-ALIST', action: 'third' })

    const audits = await store.listAudits(created.id, { limit: 2 })
    assert.equal(audits.length, 2)
    assert.equal(audits[0].action, 'third')
    assert.equal(audits[1].action, 'second')
  })

  test('listAudits respects limit', async () => {
    const created = await store.createCase({ ownerSlackUserId: 'U-LIM', channelId: 'C-LIM' })
    for (const action of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await store.addAudit({ caseId: created.id, actorSlackUserId: 'U-LIM', action })
    }

    const audits = await store.listAudits(created.id, { limit: 4 })
    assert.ok(audits.length <= 4)
  })

  // -- Stats --

  test('stats returns case and candidate counts', async () => {
    await store.createCase({ ownerSlackUserId: 'U-STAT', channelId: 'C-STAT1' })
    await store.createCase({ ownerSlackUserId: 'U-STAT', channelId: 'C-STAT2' })

    const stats = await store.stats()
    assert.equal(stats.cases, 2)
    assert.ok(typeof stats.jazzhrCandidates === 'number')
  })

  // -- Close --

  test('close shuts down the store pool', async () => {
    const s = createTestPostgresStore()
    await s.init()
    await s.close()
    // closing again should be safe
    await s.close()
  })

  // -- Edge cases --

  test('createCase handles empty optional fields gracefully', async () => {
    const result = await store.createCase({
      ownerSlackUserId: 'U-EDGE',
      channelId: 'C-EDGE',
    })
    assert.deepEqual(result.applicant, {})
    assert.deepEqual(result.recruiter, {})
    assert.deepEqual(result.hiringManager, {})
    assert.ok(result.id)
  })

  test('saveJazzhrCandidates with empty array returns 0', async () => {
    const count = await store.saveJazzhrCandidates([])
    assert.equal(count, 0)
  })

  test('listNotificationEligibleCases filters correctly', async () => {
    const c1 = await store.createCase({ ownerSlackUserId: 'U-NE1', channelId: 'C-NE1' })
    await store.updateCase(c1.id, {
      status: 'Scheduled',
      stageKey: '1st-interview',
      currentSchedule: { date: '2026-07-10' },
    })

    const eligible = await store.listNotificationEligibleCases()
    const ids = eligible.map((c) => c.id)
    assert.ok(ids.includes(c1.id))
  })

  test('createCase round-trips resumeFile JSONB', async () => {
    const resumeFile = { downloadUrl: 'https://files.slack.com/resume.pdf', permalink: 'https://slack.com/permalink', name: 'resume.pdf' }
    const created = await store.createCase({
      ownerSlackUserId: 'U-RES',
      channelId: 'C-RES',
      resumeFile,
    })
    assert.deepEqual(created.resumeFile, resumeFile)
  })

  test('createCase round-trips customInvite JSONB', async () => {
    const customInvite = { subject: 'Custom', body: 'Hello', recipients: ['a@b.com'] }
    const created = await store.createCase({
      ownerSlackUserId: 'U-CI',
      channelId: 'C-CI',
      customInvite,
    })
    assert.deepEqual(created.customInvite, customInvite)
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createJsonStore } from '../src/store/json-store.js'

function candidate(i) {
  return {
    jazzhrApplicationId: `app-${i}`,
    jazzhrJobId: `job-${i % 2}`,
    fullName: `Candidate ${i}`,
    firstName: 'Candidate',
    lastName: String(i),
    email: `cand${i}@example.com`,
    jobTitle: `Role ${i}`,
    stage: 'New',
    workflowCategory: 'active',
  }
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-store-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

test('json store persists the candidate index in a separate file from the hot state', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonStore(dir)
    await store.init()

    const saved = await store.saveJazzhrCandidates([candidate(1), candidate(2)])
    assert.equal(saved, 2)
    await store.createCase({ ownerSlackUserId: 'U1', eventType: '1st-interview' })
    await store.close()

    const mainState = await readJsonOrNull(path.join(dir, 'state.json'))
    const candidateState = await readJsonOrNull(path.join(dir, 'candidates.json'))

    assert.ok(mainState, 'state.json should exist')
    assert.ok(candidateState, 'candidates.json should exist')
    // The hot state file must NOT carry the candidate index.
    assert.equal(mainState.jazzhrCandidates, undefined, 'state.json must not embed jazzhrCandidates')
    assert.equal(mainState.candidateSeenAt, undefined, 'state.json must not embed candidateSeenAt')
    assert.equal(mainState.cases.length, 1, 'state.json should hold the case')
    // The candidate index lives in its own file.
    assert.equal(candidateState.jazzhrCandidates.length, 2)
    assert.ok(candidateState.candidateSeenAt)
  })
})

test('json store reloads cases and candidates from the split files on re-init', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonStore(dir)
    await store.init()
    await store.saveJazzhrCandidates([candidate(1), candidate(2), candidate(3)])
    await store.createCase({ ownerSlackUserId: 'U1', eventType: '1st-interview' })
    await store.close()

    const reopened = createJsonStore(dir)
    await reopened.init()
    const candidates = await reopened.listJazzhrCandidates({ limit: 100 })
    const cases = await reopened.listCases()
    assert.equal(candidates.length, 3)
    assert.equal(cases.length, 1)
    await reopened.close()
  })
})

test('json store soft-deletes unscheduled cases and hides them from normal queries', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonStore(dir)
    await store.init()
    const draft = await store.createCase({ ownerSlackUserId: 'U-DELETE' })
    const result = await store.deleteCase(draft.id, 'U-ACTOR')
    assert.equal(result.deleted, true)
    assert.equal(result.caseRecord.deletedBy, 'U-ACTOR')
    assert.equal(await store.getCase(draft.id), undefined)
    assert.equal((await store.listCases()).some((item) => item.id === draft.id), false)
    assert.equal((await store.deleteCase(draft.id, 'U-ACTOR')).reason, 'already_deleted')
    await store.close()
  })
})

test('json store refuses to delete scheduled cases', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonStore(dir)
    await store.init()
    const scheduled = await store.createCase({ ownerSlackUserId: 'U-DELETE', status: 'Scheduled' })
    assert.deepEqual(await store.deleteCase(scheduled.id, 'U-ACTOR'), { deleted: false, reason: 'scheduled' })
    assert.ok(await store.getCase(scheduled.id))
    await store.close()
  })
})

test('json store migrates a legacy embedded candidate index into candidates.json and trims state.json', async () => {
  await withTempDir(async (dir) => {
    // Pre-write a legacy state.json that embeds the candidate index, the way
    // older versions of the store did (the 53MB single-file format).
    const legacy = {
      cases: [{ id: 'case-legacy', ownerSlackUserId: 'U9', eventType: '1st-interview', status: 'Draft' }],
      audits: [],
      googleTokens: {},
      oauthStates: {},
      rateLimits: {},
      candidateSeenAt: {},
      notificationJobs: [],
      jazzhrCandidates: [
        { ...candidate(1) },
        { ...candidate(2) },
      ],
    }
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(legacy, null, 2))

    const store = createJsonStore(dir)
    await store.init()
    // Candidates should be in memory after migration.
    const candidates = await store.listJazzhrCandidates({ limit: 100 })
    assert.equal(candidates.length, 2, 'migrated candidates should be in memory')
    await store.close()

    // After migration the main state file is trimmed and candidates live apart.
    const mainState = await readJsonOrNull(path.join(dir, 'state.json'))
    const candidateState = await readJsonOrNull(path.join(dir, 'candidates.json'))
    assert.equal(mainState.jazzhrCandidates, undefined, 'state.json should be trimmed of candidates')
    assert.equal(mainState.cases.length, 1)
    assert.equal(candidateState.jazzhrCandidates.length, 2)
  })
})

test('consumeRateLimit flushes only the small hot state, not the candidate index', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonStore(dir)
    await store.init()
    await store.saveJazzhrCandidates([candidate(1)])
    await store.close()

    const candidateFileMtimeBefore = (await fs.stat(path.join(dir, 'candidates.json'))).mtimeMs

    const store2 = createJsonStore(dir)
    await store2.init()
    await store2.consumeRateLimit({ userId: 'U1', bucket: 'mutation', limit: 20, windowMs: 60000 })
    await store2.close()

    // The candidate file should not have been rewritten just because a rate
    // limit was consumed — that is the whole point of the split.
    const candidateFileMtimeAfter = (await fs.stat(path.join(dir, 'candidates.json'))).mtimeMs
    assert.equal(candidateFileMtimeAfter, candidateFileMtimeBefore, 'candidates.json must not be rewritten on a rate-limit mutation')
  })
})

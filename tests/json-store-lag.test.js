import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/store/json-store.js'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'json-store-lag-'))
}

test('persist resolves immediately without waiting for disk write', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    const start = Date.now()
    await store.createCase({ ownerSlackUserId: 'U001' })
    await store.createCase({ ownerSlackUserId: 'U002' })
    await store.createCase({ ownerSlackUserId: 'U003' })
    const elapsed = Date.now() - start

    // Three persists should resolve in well under 100ms (no disk wait)
    assert.ok(elapsed < 500, `persist took ${elapsed}ms, expected <500ms`)

    // In-memory state should be immediately consistent
    const cases = await store.listCases()
    assert.equal(cases.length, 3)

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('multiple rapid persists coalesce into a single write', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    // Fire many persists in rapid succession
    for (let i = 0; i < 20; i++) {
      await store.createCase({ ownerSlackUserId: `U${String(i).padStart(3, '0')}` })
    }

    // All 20 cases should be in memory immediately
    const cases = await store.listCases()
    assert.equal(cases.length, 20)

    // Close flushes the final state
    await store.close()

    // Re-open and verify all 20 cases persisted
    const store2 = createJsonStore(dir)
    await store2.init()
    const reloaded = await store2.listCases()
    assert.equal(reloaded.length, 20)
    await store2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('close flushes pending writes before resolving', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    await store.createCase({ ownerSlackUserId: 'U001', status: 'Draft' })
    // Don't wait — close should flush
    await store.close()

    // Re-open and verify the case was persisted
    const store2 = createJsonStore(dir)
    await store2.init()
    const cases = await store2.listCases()
    assert.equal(cases.length, 1)
    assert.equal(cases[0].ownerSlackUserId, 'U001')
    await store2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('in-memory state is correct before disk flush completes', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    const record = await store.createCase({ ownerSlackUserId: 'U001' })

    // Immediately read back — should be in memory
    const fetched = await store.getCase(record.id)
    assert.equal(fetched.ownerSlackUserId, 'U001')
    assert.equal(fetched.status, 'Draft')

    // Update and immediately read back
    await store.updateCase(record.id, { status: 'Scheduled' })
    const updated = await store.getCase(record.id)
    assert.equal(updated.status, 'Scheduled')

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('google token save and load works with debounced persist', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir, 'test-encryption-key-32bytes!!')
    await store.init()

    await store.saveGoogleToken('U001', { access_token: 'ya29.test', refresh_token: '1/refresh' })
    await store.saveGoogleToken('U002', { access_token: 'ya29.test2', refresh_token: '2/refresh' })

    // Tokens should be immediately retrievable
    const token1 = await store.getGoogleToken('U001')
    assert.equal(token1.access_token, 'ya29.test')

    const token2 = await store.getGoogleToken('U002')
    assert.equal(token2.access_token, 'ya29.test2')

    // hasGoogleToken should work
    assert.equal(await store.hasGoogleToken('U001'), true)
    assert.equal(await store.hasGoogleToken('U999'), false)

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('oauth state create and consume works with debounced persist', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    const stateHash = 'test-hash-123'
    const record = await store.createOAuthState({
      stateHash,
      teamId: 'T001',
      tokenOwnerId: 'U001',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })

    assert.equal(record.stateHash, stateHash)

    const consumed = await store.consumeOAuthState(stateHash, { expectedTeamId: 'T001' })
    assert.equal(consumed.tokenOwnerId, 'U001')

    // Second consume should return null
    const consumedAgain = await store.consumeOAuthState(stateHash, { expectedTeamId: 'T001' })
    assert.equal(consumedAgain, null)

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adds audit entries and retrieves them', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    const caseRecord = await store.createCase({ ownerSlackUserId: 'U001' })
    await store.addAudit({ caseId: caseRecord.id, action: 'created', by: 'U001' })
    await store.addAudit({ caseId: caseRecord.id, action: 'scheduled', by: 'U001' })

    const audits = await store.listAudits(caseRecord.id)
    assert.equal(audits.length, 2)
    assert.equal(audits[0].action, 'scheduled') // most recent first

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stats reflects current in-memory state', async () => {
  const dir = tempDir()
  try {
    const store = createJsonStore(dir)
    await store.init()

    let stats = await store.stats()
    assert.equal(stats.cases, 0)

    await store.createCase({ ownerSlackUserId: 'U001' })
    await store.createCase({ ownerSlackUserId: 'U002' })

    stats = await store.stats()
    assert.equal(stats.cases, 2)

    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

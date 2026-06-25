import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/store/json-store.js'

test('retention dry-run reports records and legal holds prevent deletion', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'retention-'))
  const store = createJsonStore(runtimeDir)
  try {
    await store.init()
    const old = '2024-01-01T00:00:00.000Z'
    const removable = await store.createCase({
      ownerSlackUserId: 'UONE',
      status: 'Completed',
      completedAt: old,
    })
    const held = await store.createCase({
      ownerSlackUserId: 'UONE',
      status: 'Completed',
      completedAt: old,
      legalHold: true,
    })
    await store.addAudit({ caseId: removable.id, action: 'test' })

    const preview = await store.purgeRetention({
      now: new Date('2026-06-23T00:00:00.000Z'),
      completedCaseDays: 365,
      dryRun: true,
    })
    assert.equal(preview.cases, 1)
    assert.ok(await store.getCase(removable.id))

    await store.purgeRetention({
      now: new Date('2026-06-23T00:00:00.000Z'),
      completedCaseDays: 365,
    })
    assert.equal(await store.getCase(removable.id), undefined)
    assert.ok(await store.getCase(held.id))
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

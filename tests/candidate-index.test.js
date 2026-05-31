import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { normalizeJazzhrCandidates, searchJazzhrCandidateRecords } from '../src/store/candidate-index.js'
import { createJsonStore } from '../src/store/json-store.js'

test('normalizes and orders JazzHR candidates newest first', () => {
  const records = normalizeJazzhrCandidates([
    { jazzhrApplicationId: '1', fullName: 'Older Candidate', appliedAt: '2024-01-01', sourceOrder: 0 },
    { jazzhrApplicationId: '2', fullName: 'Newest Candidate', appliedAt: '2024-03-01', sourceOrder: 1 },
    { jazzhrApplicationId: '3', fullName: 'No Date Candidate', sourceOrder: 2 },
  ])

  assert.deepEqual(records.map((record) => record.fullName), [
    'Newest Candidate',
    'Older Candidate',
    'No Date Candidate',
  ])
})

test('searches candidate names within an optional base query', () => {
  const records = [
    { jazzhrApplicationId: '1', fullName: 'Alex Reyes', jobTitle: 'Support Specialist', appliedAt: '2024-02-01' },
    { jazzhrApplicationId: '2', fullName: 'Alex Santos', jobTitle: 'Accountant', appliedAt: '2024-03-01' },
    { jazzhrApplicationId: '3', fullName: 'Bea Cruz', jobTitle: 'Support Specialist', appliedAt: '2024-04-01' },
  ]

  const results = searchJazzhrCandidateRecords(records, 'support', { baseQuery: 'alex' })

  assert.deepEqual(results.map((record) => record.fullName), ['Alex Reyes'])
})

test('json store persists and searches JazzHR candidate index', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'candidate-index-'))
  try {
    const store = createJsonStore(runtimeDir)
    await store.init()
    await store.saveJazzhrCandidates([
      { jazzhrApplicationId: '1', fullName: 'Alex Reyes', appliedAt: '2024-01-01' },
      { jazzhrApplicationId: '2', fullName: 'Alex Santos', appliedAt: '2024-03-01' },
    ])

    const results = await store.searchJazzhrCandidates('alex')
    const selected = await store.getJazzhrCandidate('2')

    assert.deepEqual(results.map((record) => record.fullName), ['Alex Santos', 'Alex Reyes'])
    assert.equal(selected.fullName, 'Alex Santos')
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

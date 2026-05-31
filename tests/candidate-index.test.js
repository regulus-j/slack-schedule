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

test('candidate index excludes rejected stages from search results', () => {
  const records = [
    {
      jazzhrApplicationId: '1',
      fullName: 'Ashwini Megajayaraman',
      jobTitle: 'Business Data Analyst - India',
      stage: 'Resume Screening - Rejected by Recruiter',
      appliedAt: '2026-02-12',
    },
    {
      jazzhrApplicationId: '2',
      fullName: 'Ashwini Active',
      jobTitle: 'Business Data Analyst - India',
      stage: 'Resume Screening',
      appliedAt: '2026-02-13',
    },
  ]

  const results = searchJazzhrCandidateRecords(records, 'ashwini')

  assert.deepEqual(results.map((record) => record.fullName), ['Ashwini Active'])
})

test('candidate index preserves separate role applications for one prospect', () => {
  const records = normalizeJazzhrCandidates([
    {
      jazzhrApplicationId: 'prospect-1',
      jazzhrJobId: 'job-active',
      fullName: 'Hanah Binwihan',
      jobTitle: 'Real Estate VA',
      stage: 'PreScreening',
      appliedAt: '2026-05-28',
    },
    {
      jazzhrApplicationId: 'prospect-1',
      jazzhrJobId: 'job-future',
      fullName: 'Hanah Binwihan',
      jobTitle: 'DocuSign Administrator',
      stage: 'Resume Screening',
      appliedAt: '2026-05-27',
    },
  ])

  assert.deepEqual(records.map((record) => record.id), [
    'applicant-prospect-1::job-active',
    'applicant-prospect-1::job-future',
  ])
  assert.deepEqual(records.map((record) => record.jazzhrApplicationId), ['prospect-1', 'prospect-1'])
})

test('json store persists and searches JazzHR candidate index', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'candidate-index-'))
  try {
    const store = createJsonStore(runtimeDir)
    await store.init()
    await store.saveJazzhrCandidates([
      { jazzhrApplicationId: '1', fullName: 'Alex Reyes', appliedAt: '2024-01-01' },
      { jazzhrApplicationId: '2', fullName: 'Alex Santos', appliedAt: '2024-03-01' },
      { jazzhrApplicationId: '2', jazzhrJobId: 'job-2', fullName: 'Alex Santos', jobTitle: 'Second Role', appliedAt: '2024-03-02' },
    ])

    const results = await store.searchJazzhrCandidates('alex')
    const listed = await store.listJazzhrCandidates()
    const selected = await store.getJazzhrCandidate('2::job-2')

    assert.deepEqual(results.map((record) => record.id), [
      'applicant-2::job-2',
      'applicant-2',
      'applicant-1',
    ])
    assert.deepEqual(listed.map((record) => record.id), [
      'applicant-2::job-2',
      'applicant-2',
      'applicant-1',
    ])
    assert.equal(selected.fullName, 'Alex Santos')
    assert.equal(selected.jobTitle, 'Second Role')
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

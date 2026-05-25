import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAttendees,
  refreshAttendees,
  includedAttendees,
  attendeesForFreeBusy,
  validateAttendees
} from '../src/workflow/attendees.js'
import { resolveStageRules } from '../src/workflow/stage-rules.js'

function makeCaseRecord(overrides = {}) {
  return {
    id: 'case-test-1',
    applicant: { id: 'app1', firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', jobTitle: 'Engineer' },
    recruiter: { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', slackUserId: 'U001' },
    hiringManager: { id: 'hm1', name: 'John Reyes', email: 'john@opg.com', role: 'hiring_manager', slackUserId: 'U002' },
    guests: [],
    externalAttendees: [],
    stageKey: '1st-interview',
    stageOverrides: {},
    attendanceOverrides: {},
    ...overrides
  }
}

function makeValidAttendees() {
  return [
    { id: 'app1', name: 'Jane Doe', email: 'jane@test.com', role: 'candidate', required: true, included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', required: true, included: true }
  ]
}

test('normalizeAttendees always includes candidate and recruiter', () => {
  const record = makeCaseRecord()
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const candidate = result.find((a) => a.role === 'candidate')
  const recruiter = result.find((a) => a.role === 'recruiter')

  assert.ok(candidate, 'candidate should be present')
  assert.equal(candidate.included, true)
  assert.equal(candidate.required, true)
  assert.equal(candidate.email, 'jane@test.com')

  assert.ok(recruiter, 'recruiter should be present')
  assert.equal(recruiter.included, true)
  assert.equal(recruiter.required, true)
  assert.equal(recruiter.email, 'sarah@opg.com')
})

test('normalizeAttendees excludes HM for 1st-interview (default excluded)', () => {
  const record = makeCaseRecord()
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm, 'hiring manager should be in the list')
  assert.equal(hm.included, false)
  assert.equal(hm.required, false)
})

test('normalizeAttendees excludes HM for 2nd-interview by default', () => {
  const record = makeCaseRecord({ stageKey: '2nd-interview' })
  const rules = resolveStageRules('2nd-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false)
  assert.equal(hm.required, false)
})

test('normalizeAttendees excludes HM for final-interview by default', () => {
  const record = makeCaseRecord({ stageKey: 'final-interview' })
  const rules = resolveStageRules('final-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false)
  assert.equal(hm.required, false)
})

test('normalizeAttendees keeps final-offer alias compatible with optional HM', () => {
  const record = makeCaseRecord({
    stageKey: 'final-offer',
  })
  const rules = resolveStageRules('final-offer')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false)
  assert.equal(hm.required, false)
})

test('normalizeAttendees includes guests', () => {
  const record = makeCaseRecord({
    guests: [{ id: 'g1', name: 'Guest One', email: 'guest1@test.com' }]
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const guest = result.find((a) => a.role === 'guest')
  assert.ok(guest)
  assert.equal(guest.email, 'guest1@test.com')
  assert.equal(guest.included, true)
  assert.equal(guest.required, false)
})

test('normalizeAttendees handles guest as string', () => {
  const record = makeCaseRecord({
    guests: ['guest-string@test.com']
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const guest = result.find((a) => a.role === 'guest')
  assert.ok(guest)
  assert.equal(guest.email, 'guest-string@test.com')
})

test('normalizeAttendees tolerates non-array guests', () => {
  const record = makeCaseRecord({
    guests: { email: 'bad-shape@test.com' }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const guestCount = result.filter((a) => a.role === 'guest').length
  assert.equal(guestCount, 0)
})

test('normalizeAttendees includes external attendees', () => {
  const record = makeCaseRecord({
    externalAttendees: [{ id: 'ext1', name: 'External Person', email: 'external@other.com', required: true }]
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const ext = result.find((a) => a.role === 'external')
  assert.ok(ext)
  assert.equal(ext.email, 'external@other.com')
  assert.equal(ext.included, true)
  assert.equal(ext.required, true)
})

test('normalizeAttendees tolerates non-array external attendees', () => {
  const record = makeCaseRecord({
    externalAttendees: { email: 'external@bad.com' }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const externalCount = result.filter((a) => a.role === 'external').length
  assert.equal(externalCount, 0)
})

test('normalizeAttendees applies attendanceOverrides to force include HM by role', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { hiring_manager: true }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true)
})

test('normalizeAttendees applies attendanceOverrides to keep HM excluded by role', () => {
  const record = makeCaseRecord({
    stageKey: '2nd-interview',
    attendanceOverrides: { hiring_manager: false }
  })
  const rules = resolveStageRules('2nd-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false)
})

test('normalizeAttendees applies attendanceOverrides by attendee id', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { hm1: true }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.id === 'hm1')
  assert.ok(hm)
  assert.equal(hm.included, true)
})

test('normalizeAttendees applies attendanceOverrides by email', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { 'john@opg.com': true }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true)
})

test('normalizeAttendees handles attendanceOverrides with object value', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { hiring_manager: { included: false } }
  })
  const rules = resolveStageRules('2nd-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false)
})

test('normalizeAttendees supports legacy hiringManagerIncluded override', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { hiringManagerIncluded: true }
  })
  const rules = resolveStageRules('final-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true)
  assert.equal(hm.required, false)
})

test('normalizeAttendees allows excluding recruiter but fallback re-includes HM', () => {
  const record = makeCaseRecord({
    attendanceOverrides: { recruiter: false }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const recruiter = result.find((a) => a.role === 'recruiter')
  assert.ok(recruiter)
  assert.equal(recruiter.included, false, 'recruiter can be excluded via override')

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true, 'HM is re-included as fallback when no interviewer remains')
})

test('normalizeAttendees ensures at least one interviewer when all excluded', () => {
  // Force-exclude recruiter and HM; the fallback should re-include HM
  const record = makeCaseRecord({
    stageKey: '1st-interview',
    guests: [],
    attendanceOverrides: { recruiter: false }
  })
  const rules = resolveStageRules('1st-interview')
  const result = normalizeAttendees(record, rules)

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true, 'HM should be re-included when no other interviewer')
})

test('refreshAttendees rebuilds list when stage changes', () => {
  const record = makeCaseRecord({ stageKey: '1st-interview' })
  const result = refreshAttendees(record, '2nd-interview')

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, false, 'HM should remain optional for 2nd-interview after refresh')
  assert.equal(hm.required, false)
})

test('refreshAttendees uses provided attendanceOverrides', () => {
  const record = makeCaseRecord({ stageKey: '1st-interview' })
  const result = refreshAttendees(record, '1st-interview', {}, { hiring_manager: true })

  const hm = result.find((a) => a.role === 'hiring_manager')
  assert.ok(hm)
  assert.equal(hm.included, true)
})

test('includedAttendees filters to included only', () => {
  const attendees = [
    { id: 'a1', email: 'a@test.com', role: 'candidate', included: true },
    { id: 'a2', email: 'b@test.com', role: 'hiring_manager', included: false },
    { id: 'a3', email: 'c@test.com', role: 'recruiter', included: true },
    { id: 'a4', email: 'd@test.com', role: 'guest', included: false }
  ]

  const result = includedAttendees(attendees)
  assert.equal(result.length, 2)
  assert.equal(result[0].id, 'a1')
  assert.equal(result[1].id, 'a3')
})

test('attendeesForFreeBusy returns { id: email }[] format for included attendees with email', () => {
  const attendees = [
    { id: 'a1', email: 'a@test.com', role: 'candidate', included: true },
    { id: 'a2', email: 'b@test.com', role: 'hiring_manager', included: false },
    { id: 'a3', email: 'c@test.com', role: 'recruiter', included: true },
    { id: 'a4', email: '', role: 'guest', included: true }
  ]

  const result = attendeesForFreeBusy(attendees)
  assert.equal(result.length, 2)
  assert.deepEqual(result[0], { id: 'a@test.com' })
  assert.deepEqual(result[1], { id: 'c@test.com' })
})

test('validateAttendees rejects when no interviewer', () => {
  const attendees = [
    { id: 'app1', name: 'Jane', email: 'jane@test.com', role: 'candidate', required: true, included: true },
    { id: 'rec1', name: 'Sarah', email: 'sarah@opg.com', role: 'recruiter', required: true, included: false }
  ]

  const result = validateAttendees(attendees)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('At least one interviewer')))
})

test('validateAttendees rejects duplicate emails', () => {
  const attendees = [
    { id: 'app1', name: 'Jane', email: 'jane@test.com', role: 'candidate', required: true, included: true },
    { id: 'rec1', name: 'Sarah', email: 'sarah@opg.com', role: 'recruiter', required: true, included: true },
    { id: 'rec2', name: 'Sarah Dup', email: 'sarah@opg.com', role: 'hiring_manager', required: true, included: true }
  ]

  const result = validateAttendees(attendees)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('Duplicate email')))
})

test('validateAttendees rejects empty attendee list', () => {
  const result = validateAttendees([])
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('No attendees')))
})

test('validateAttendees rejects null attendees', () => {
  const result = validateAttendees(null)
  assert.equal(result.valid, false)
})

test('validateAttendees rejects missing candidate', () => {
  const attendees = [
    { id: 'rec1', name: 'Sarah', email: 'sarah@opg.com', role: 'recruiter', required: true, included: true }
  ]

  const result = validateAttendees(attendees)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('No candidate')))
})

test('validateAttendees rejects candidate not included', () => {
  const attendees = [
    { id: 'app1', name: 'Jane', email: 'jane@test.com', role: 'candidate', required: true, included: false },
    { id: 'rec1', name: 'Sarah', email: 'sarah@opg.com', role: 'recruiter', required: true, included: true }
  ]

  const result = validateAttendees(attendees)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('Candidate must be included')))
})

test('validateAttendees rejects attendee with no email', () => {
  const attendees = [
    { id: 'app1', name: 'Jane', email: 'jane@test.com', role: 'candidate', required: true, included: true },
    { id: 'rec1', name: 'Sarah', email: '', role: 'recruiter', required: true, included: true }
  ]

  const result = validateAttendees(attendees)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('has no email address')))
})

test('validateAttendees accepts valid attendee list', () => {
  const attendees = makeValidAttendees()

  const result = validateAttendees(attendees)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

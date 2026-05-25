import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStageFromTemplate, resolveStageRules } from '../src/workflow/stage-rules.js'
import { normalizeAttendees, includedAttendees, attendeesForFreeBusy } from '../src/workflow/attendees.js'
import { generateCandidateSlots, intersectSlotsWithBusy, rankSlots, detectConflicts } from '../src/workflow/scheduler.js'
import { SYDNEY_TIME_ZONE } from '../src/time.js'

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

// ─── Stage rules → Attendee list ────────────────────────────────────────────

test('integration: stage rules determine attendee list correctly for 1st-interview', () => {
  const record = makeCaseRecord({ stageKey: '1st-interview' })
  const rules = resolveStageRules('1st-interview')
  const attendees = normalizeAttendees(record, rules)

  assert.equal('hiringManagerDefault' in rules, false)
  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, false)
})

test('integration: stage rules keep HM optional for 2nd-interview', () => {
  const record = makeCaseRecord({ stageKey: '2nd-interview' })
  const rules = resolveStageRules('2nd-interview')
  const attendees = normalizeAttendees(record, rules)

  assert.equal('hiringManagerDefault' in rules, false)
  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, false)
})

test('integration: stage rules keep HM optional for final-interview', () => {
  const record = makeCaseRecord({ stageKey: 'final-interview' })
  const rules = resolveStageRules('final-interview')
  const attendees = normalizeAttendees(record, rules)

  assert.equal('hiringManagerDefault' in rules, false)
  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, false)
})

test('integration: attendance overrides include optional HM', () => {
  const record = makeCaseRecord({
    stageKey: '1st-interview',
    attendanceOverrides: { hiring_manager: true }
  })
  const rules = resolveStageRules('1st-interview', record.stageOverrides)
  const attendees = normalizeAttendees(record, rules)

  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, true)
})

test('integration: legacy final-offer alias resolves to final interview rules', () => {
  const record = makeCaseRecord({
    stageKey: 'final-offer',
    attendanceOverrides: { hiringManagerIncluded: true }
  })
  const rules = resolveStageRules('final-offer')
  const attendees = normalizeAttendees(record, rules)

  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, true)
})

// ─── Full pipeline: generate → intersect → rank ─────────────────────────────

test('integration: full pipeline generate slots → intersect with mock busy → rank', () => {
  // Step 1: Generate candidate slots
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.ok(slots.length > 0, 'should generate slots')

  // Step 2: Set up attendees and busy periods
  const attendees = [
    { id: 'app1', name: 'Jane Doe', email: 'jane@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true },
    { id: 'hm1', name: 'John Reyes', email: 'john@opg.com', role: 'hiring_manager', included: true }
  ]

  // Make first slot busy for Sarah
  const busyByEmail = {
    'sarah@opg.com': [
      { start: slots[0].start, end: slots[0].end }
    ]
  }

  // Step 3: Intersect
  const intersected = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  // First slot should be conflicted, rest should be available
  assert.equal(intersected[0].allAvailable, false)
  assert.equal(intersected[0].conflicts['sarah@opg.com'].hasConflict, true)
  assert.equal(intersected[1].allAvailable, true)

  // Step 4: Rank
  const ranked = rankSlots(intersected, SYDNEY_TIME_ZONE)

  // Available slots should rank higher than conflicted ones
  const firstAvailableIdx = ranked.findIndex((s) => s.allAvailable)
  const firstConflictedIdx = ranked.findIndex((s) => !s.allAvailable)
  assert.ok(firstAvailableIdx < firstConflictedIdx,
    `available slot at index ${firstAvailableIdx} should be before conflicted at index ${firstConflictedIdx}`)
})

// ─── Conflict detection with cross-case schedules ────────────────────────────

test('integration: conflict detection with cross-case schedules', () => {
  // Case A: Jane Doe with Sarah Chen as recruiter
  const attendeesA = [
    { id: 'app1', name: 'Jane Doe', email: 'jane@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true, required: true }
  ]

  // Case B: Bob Smith also with Sarah Chen as recruiter
  const attendeesB = [
    { id: 'app2', name: 'Bob Smith', email: 'bob@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true }
  ]

  // Both cases want the same time slot
  const proposedSlot = { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' }

  const conflicts = detectConflicts({
    proposedSlot,
    attendees: attendeesA,
    busyPeriods: {},
    existingCaseSchedules: [
      {
        id: 'case-b',
        selectedSlot: proposedSlot,
        attendees: attendeesB,
        applicant: { firstName: 'Bob', lastName: 'Smith' }
      }
    ],
    bufferMinutes: 15
  })

  // Should detect that Sarah is double-booked
  assert.equal(conflicts.length, 1, 'should detect one conflict')
  assert.equal(conflicts[0].type, 'double_booking')
  assert.equal(conflicts[0].attendeeEmail, 'sarah@opg.com')
  assert.ok(conflicts[0].message.includes('Sarah Chen'))
  assert.ok(conflicts[0].message.includes('Bob Smith'))
})

test('integration: cross-case double-booking only affects shared attendees', () => {
  // Case A: Jane with Sarah (recruiter) and John (hiring manager)
  const attendeesA = [
    { id: 'app1', name: 'Jane Doe', email: 'jane@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true, required: true },
    { id: 'hm1', name: 'John Reyes', email: 'john@opg.com', role: 'hiring_manager', included: true, required: true }
  ]

  // Case B: Bob with only Sarah as shared attendee (John is not in Case B)
  const attendeesB = [
    { id: 'app2', name: 'Bob Smith', email: 'bob@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true },
    { id: 'hm2', name: 'Maria Lopez', email: 'maria@opg.com', role: 'hiring_manager', included: true }
  ]

  const proposedSlot = { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' }

  const conflicts = detectConflicts({
    proposedSlot,
    attendees: attendeesA,
    busyPeriods: {},
    existingCaseSchedules: [
      {
        id: 'case-b',
        selectedSlot: proposedSlot,
        attendees: attendeesB,
        applicant: { firstName: 'Bob', lastName: 'Smith' }
      }
    ],
    bufferMinutes: 15
  })

  // Only Sarah should have a conflict, not John
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].attendeeEmail, 'sarah@opg.com')
  assert.ok(!conflicts.some((c) => c.attendeeEmail === 'john@opg.com'))
})

test('integration: no double-booking when cases have disjoint attendees', () => {
  const attendeesA = [
    { id: 'app1', name: 'Jane Doe', email: 'jane@test.com', role: 'candidate', included: true },
    { id: 'rec1', name: 'Sarah Chen', email: 'sarah@opg.com', role: 'recruiter', included: true }
  ]

  const attendeesB = [
    { id: 'app2', name: 'Bob Smith', email: 'bob@test.com', role: 'candidate', included: true },
    { id: 'rec2', name: 'Alex Kim', email: 'alex@opg.com', role: 'recruiter', included: true }
  ]

  const proposedSlot = { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' }

  const conflicts = detectConflicts({
    proposedSlot,
    attendees: attendeesA,
    busyPeriods: {},
    existingCaseSchedules: [
      {
        id: 'case-b',
        selectedSlot: proposedSlot,
        attendees: attendeesB,
        applicant: { firstName: 'Bob', lastName: 'Smith' }
      }
    ],
    bufferMinutes: 15
  })

  // No shared attendees, so no double-booking
  assert.equal(conflicts.length, 0)
})

// ─── End-to-end: from stage resolution to ranked slots ───────────────────────

test('integration: end-to-end from stage resolution through ranked slots', () => {
  // 1. Start with a case record for 2nd interview
  const record = makeCaseRecord({ stageKey: '2nd-interview' })

  // 2. Resolve stage rules
  const rules = resolveStageRules('2nd-interview')

  // 3. Normalize attendees
  const attendees = normalizeAttendees(record, rules)

  // 4. Verify HM remains optional for 2nd interview
  const hm = attendees.find((a) => a.role === 'hiring_manager')
  assert.equal(hm.included, false)

  // 5. Filter to included
  const included = includedAttendees(attendees)
  assert.ok(included.length >= 2, 'at least candidate + recruiter should be included')

  // 6. Get free/busy format
  const fbAttendees = attendeesForFreeBusy(included)
  assert.ok(fbAttendees.length >= 2)
  assert.deepEqual(fbAttendees[0], { id: 'jane@test.com' })

  // 7. Generate slots with 45 min duration (2nd-or-final typical)
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: rules.typicalDurationMinutes,
    timeZone: SYDNEY_TIME_ZONE
  })

  // 45-min slots in an 8-hour day = 10 slots
  assert.equal(slots.length, 10)

  // 8. Intersect with empty busy (all available)
  const intersected = intersectSlotsWithBusy(slots, {}, included)
  for (const slot of intersected) {
    assert.equal(slot.allAvailable, true)
  }

  // 9. Rank
  const ranked = rankSlots(intersected, SYDNEY_TIME_ZONE)
  assert.ok(ranked.length === 10)
  assert.ok(ranked[0].score > 0)
})

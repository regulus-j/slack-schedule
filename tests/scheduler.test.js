import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generateCandidateSlots,
  intersectSlotsWithBusy,
  detectConflicts,
  rankSlots,
  formatConflictMessage
} from '../src/workflow/scheduler.js'
import { formatDateForInput, SYDNEY_TIME_ZONE } from '../src/time.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoToTime(iso) {
  return new Date(iso).getTime()
}

function makeSlot(startIso, endIso, overrides = {}) {
  return {
    start: startIso,
    end: endIso,
    score: 0,
    conflicts: {},
    allAvailable: true,
    ...overrides
  }
}

// ─── generateCandidateSlots ──────────────────────────────────────────────────

test('generates 18 slots for a single 7-4 business day with 30 min duration', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 18)
})

test('generates 9 slots for a single business day with 60 min duration', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 60,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 9)
})

test('all generated slots have required properties', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  for (const slot of slots) {
    assert.ok(slot.start, 'slot should have start')
    assert.ok(slot.end, 'slot should have end')
    assert.equal(slot.score, 0, 'score should start at 0')
    assert.equal(slot.allAvailable, true, 'allAvailable should start true')
    assert.ok(typeof slot.conflicts === 'object', 'conflicts should be an object')
  }
})

test('slots are ordered chronologically', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  for (let i = 1; i < slots.length; i++) {
    const prevEnd = isoToTime(slots[i - 1].end)
    const currStart = isoToTime(slots[i].start)
    assert.equal(prevEnd, currStart, `slot ${i} should start exactly where slot ${i - 1} ends`)
  }
})

test('respects custom business hours', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 60,
    timeZone: SYDNEY_TIME_ZONE,
    businessStart: '10:00',
    businessEnd: '14:00'
  })

  // 10:00-14:00 = 4 hours = 4 one-hour slots
  assert.equal(slots.length, 4)
})

test('skips weekends (Saturday)', () => {
  // 2026-05-30 is a Saturday
  const slots = generateCandidateSlots({
    startDate: '2026-05-30',
    endDate: '2026-05-30',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 0, 'Saturday should have no slots')
})

test('skips weekends (Sunday)', () => {
  // 2026-05-31 is a Sunday
  const slots = generateCandidateSlots({
    startDate: '2026-05-31',
    endDate: '2026-05-31',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 0, 'Sunday should have no slots')
})

test('generates slots across multiple business days', () => {
  // Monday June 1 through Wednesday June 3, 2026 = 3 business days
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-03',
    durationMinutes: 60,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 27, '3 days x 9 one-hour slots = 27')
})

test('does not generate slots before today in the interview timezone', () => {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setUTCDate(today.getUTCDate() - 1)
  const tomorrow = new Date(today)
  tomorrow.setUTCDate(today.getUTCDate() + 1)
  const todayStr = formatDateForInput(today, SYDNEY_TIME_ZONE)

  const slots = generateCandidateSlots({
    startDate: formatDateForInput(yesterday, SYDNEY_TIME_ZONE),
    endDate: formatDateForInput(tomorrow, SYDNEY_TIME_ZONE),
    durationMinutes: 60,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.ok(slots.every((slot) => formatDateForInput(slot.start, SYDNEY_TIME_ZONE) >= todayStr))
})

test('returns empty for invalid date range (end before start)', () => {
  const slots = generateCandidateSlots({
    startDate: '2026-06-05',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  assert.equal(slots.length, 0)
})

test('handles exact slot alignment at business day boundaries', () => {
  // With 30-min slots 07:00-16:00, first slot starts at 07:00 and last ends at 16:00
  const slots = generateCandidateSlots({
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    durationMinutes: 30,
    timeZone: SYDNEY_TIME_ZONE
  })

  const firstStart = new Date(slots[0].start)
  const lastEnd = new Date(slots[slots.length - 1].end)

  // First slot should start at 07:00 Sydney time
  // Last slot should end at 16:00 Sydney time
  // We verify the slot duration is correct
  const firstDuration = isoToTime(slots[0].end) - isoToTime(slots[0].start)
  assert.equal(firstDuration, 30 * 60 * 1000, 'first slot should be exactly 30 minutes')

  const lastDuration = isoToTime(slots[slots.length - 1].end) - isoToTime(slots[slots.length - 1].start)
  assert.equal(lastDuration, 30 * 60 * 1000, 'last slot should be exactly 30 minutes')
})

// ─── intersectSlotsWithBusy ──────────────────────────────────────────────────

test('intersectSlotsWithBusy marks all slots as allAvailable when no busy periods', () => {
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z'),
    makeSlot('2026-06-01T00:30:00.000Z', '2026-06-01T01:00:00.000Z')
  ]
  const busyByEmail = {}
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result.length, 2)
  for (const slot of result) {
    assert.equal(slot.allAvailable, true)
    assert.equal(slot.conflicts['a@test.com'].hasConflict, false)
  }
})

test('intersectSlotsWithBusy marks slot as conflicted when overlaps with busy period', () => {
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
    ]
  }
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result[0].allAvailable, false)
  assert.equal(result[0].conflicts['a@test.com'].hasConflict, true)
  assert.equal(result[0].conflicts['a@test.com'].overlappingEvents.length, 1)
})

test('intersectSlotsWithBusy marks only conflicting attendee, not all', () => {
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
    ]
  }
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' },
    { email: 'b@test.com', included: true, name: 'B' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result[0].allAvailable, false)
  assert.equal(result[0].conflicts['a@test.com'].hasConflict, true)
  assert.equal(result[0].conflicts['b@test.com'].hasConflict, false)
})

test('intersectSlotsWithBusy respects buffer minutes', () => {
  // Slot: 00:00-00:30, busy: 00:30-01:00, buffer: 15 min
  // With buffer, slot extends to -00:15 to 00:45, so it overlaps with busy starting at 00:30
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:30:00.000Z', end: '2026-06-01T01:00:00.000Z' }
    ]
  }
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees, 15)

  assert.equal(result[0].allAvailable, false)
  assert.equal(result[0].conflicts['a@test.com'].hasConflict, true)
})

test('intersectSlotsWithBusy handles multiple busy periods per attendee', () => {
  const slots = [
    makeSlot('2026-06-01T01:00:00.000Z', '2026-06-01T01:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T01:05:00.000Z' },
      { start: '2026-06-01T01:25:00.000Z', end: '2026-06-01T02:00:00.000Z' }
    ]
  }
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result[0].allAvailable, false)
  assert.equal(result[0].conflicts['a@test.com'].overlappingEvents.length, 2)
})

test('intersectSlotsWithBusy handles multiple attendees with different busy periods', () => {
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
    ],
    'b@test.com': []
  }
  const attendees = [
    { email: 'a@test.com', included: true, name: 'A' },
    { email: 'b@test.com', included: true, name: 'B' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result[0].allAvailable, false)
  assert.equal(result[0].conflicts['a@test.com'].hasConflict, true)
  assert.equal(result[0].conflicts['b@test.com'].hasConflict, false)
})

test('intersectSlotsWithBusy skips excluded attendees', () => {
  const slots = [
    makeSlot('2026-06-01T00:00:00.000Z', '2026-06-01T00:30:00.000Z')
  ]
  const busyByEmail = {
    'a@test.com': [
      { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
    ]
  }
  const attendees = [
    { email: 'a@test.com', included: false, name: 'A' }
  ]

  const result = intersectSlotsWithBusy(slots, busyByEmail, attendees)

  assert.equal(result[0].allAvailable, true)
})

// ─── detectConflicts ─────────────────────────────────────────────────────────

test('detectConflicts returns empty for conflict-free slot', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Person A', role: 'recruiter', required: true }
    ],
    busyPeriods: {},
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  assert.equal(conflicts.length, 0)
})

test('detectConflicts detects time overlap conflict', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Person A', role: 'recruiter', required: true }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].type, 'overlap')
  assert.equal(conflicts[0].attendeeEmail, 'a@test.com')
  assert.equal(conflicts[0].severity, 'error')
})

test('detectConflicts includes attendee name in conflict message', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Alice Smith', role: 'recruiter', required: true }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  assert.ok(conflicts[0].message.includes('Alice Smith'))
})

test('detectConflicts uses warning severity for non-required attendees', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Optional Guest', role: 'guest', required: false }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:10:00.000Z', end: '2026-06-01T00:20:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].severity, 'warning')
})

test('detectConflicts detects double-booking across cases', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'sarah@opg.com', included: true, name: 'Sarah Chen', role: 'recruiter', required: true }
    ],
    busyPeriods: {},
    existingCaseSchedules: [
      {
        id: 'case-2',
        selectedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
        attendees: [
          { email: 'sarah@opg.com', included: true, name: 'Sarah Chen', role: 'recruiter' }
        ],
        applicant: { firstName: 'Bob', lastName: 'Jones' }
      }
    ],
    bufferMinutes: 15
  })

  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].type, 'double_booking')
  assert.ok(conflicts[0].message.includes('Bob Jones'))
})

test('detectConflicts detects buffer violation (gap before slot)', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:30:00.000Z', end: '2026-06-01T01:00:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Person A', role: 'recruiter', required: true }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:25:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  // Gap is 5 min, buffer is 15 min => violation
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].type, 'buffer')
  assert.ok(conflicts[0].message.includes('5 min buffer'))
})

test('detectConflicts detects buffer violation (gap after slot)', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Person A', role: 'recruiter', required: true }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:35:00.000Z', end: '2026-06-01T01:00:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  // Gap is 5 min, buffer is 15 min => violation
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].type, 'buffer')
  assert.ok(conflicts[0].message.includes('5 min buffer'))
})

test('detectConflicts does not flag buffer when gap is sufficient', () => {
  const conflicts = detectConflicts({
    proposedSlot: { start: '2026-06-01T00:30:00.000Z', end: '2026-06-01T01:00:00.000Z' },
    attendees: [
      { email: 'a@test.com', included: true, name: 'Person A', role: 'recruiter', required: true }
    ],
    busyPeriods: {
      'a@test.com': [
        { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:15:00.000Z' }
      ]
    },
    existingCaseSchedules: [],
    bufferMinutes: 15
  })

  // Gap is 15 min, buffer is 15 min => no violation (gap > 0 and gap < bufferMs = false, gap === bufferMs)
  // Actually gap is exactly 15 min = bufferMs, so gap < bufferMs is false. No conflict.
  assert.equal(conflicts.length, 0)
})

// ─── rankSlots ───────────────────────────────────────────────────────────────

test('rankSlots ranks all-available slots highest', () => {
  const slots = [
    {
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-06-01T00:30:00.000Z',
      score: 0,
      conflicts: { 'a@test.com': { hasConflict: true } },
      allAvailable: false
    },
    {
      start: '2026-06-01T00:30:00.000Z',
      end: '2026-06-01T01:00:00.000Z',
      score: 0,
      conflicts: {},
      allAvailable: true
    }
  ]

  const ranked = rankSlots(slots, SYDNEY_TIME_ZONE)

  assert.equal(ranked[0].allAvailable, true)
})

test('rankSlots scores slots with fewer conflicts higher', () => {
  const slots = [
    {
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-06-01T00:30:00.000Z',
      score: 0,
      conflicts: {
        'a@test.com': { hasConflict: true },
        'b@test.com': { hasConflict: true }
      },
      allAvailable: false
    },
    {
      start: '2026-06-01T00:30:00.000Z',
      end: '2026-06-01T01:00:00.000Z',
      score: 0,
      conflicts: { 'a@test.com': { hasConflict: true } },
      allAvailable: false
    }
  ]

  const ranked = rankSlots(slots, SYDNEY_TIME_ZONE)

  // Slot with 1 conflict should score higher than slot with 2 conflicts
  // Both start at same local hour if in same day
  // So the 1-conflict slot should be first
  assert.equal(ranked[0].end, '2026-06-01T01:00:00.000Z')
})

test('rankSlots scores morning slots higher than afternoon', () => {
  // Two all-available slots, one at 09:00, one at 14:00 Sydney time
  // 2026-06-01 09:00 Sydney = 2026-05-31T23:00:00Z (UTC+10 in June)
  // 2026-06-01 14:00 Sydney = 2026-06-01T04:00:00Z
  // Actually let me just use clearly different times
  const slots = [
    {
      start: '2026-05-31T23:00:00.000Z', // 09:00 Sydney on June 1
      end: '2026-05-31T23:30:00.000Z',
      score: 0,
      conflicts: {},
      allAvailable: true
    },
    {
      start: '2026-06-01T04:00:00.000Z', // 14:00 Sydney on June 1
      end: '2026-06-01T04:30:00.000Z',
      score: 0,
      conflicts: {},
      allAvailable: true
    }
  ]

  const ranked = rankSlots(slots, SYDNEY_TIME_ZONE)

  // Morning slot (09:00) should rank higher
  assert.equal(ranked[0].start, '2026-05-31T23:00:00.000Z')
})

test('rankSlots returns slots sorted descending by score', () => {
  const slots = [
    { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z', score: 0, conflicts: { 'a@test.com': { hasConflict: true } }, allAvailable: false },
    { start: '2026-06-01T00:30:00.000Z', end: '2026-06-01T01:00:00.000Z', score: 0, conflicts: {}, allAvailable: true },
    { start: '2026-06-01T01:00:00.000Z', end: '2026-06-01T01:30:00.000Z', score: 0, conflicts: { 'b@test.com': { hasConflict: true } }, allAvailable: false }
  ]

  const ranked = rankSlots(slots, SYDNEY_TIME_ZONE)

  // The allAvailable slot should have the highest score
  assert.equal(ranked[0].allAvailable, true)
  // Scores should be in descending order
  assert.ok(ranked[0].score >= ranked[1].score)
  assert.ok(ranked[1].score >= ranked[2].score)
})

test('rankSlots returns empty for empty slots array', () => {
  const ranked = rankSlots([], SYDNEY_TIME_ZONE)
  assert.equal(ranked.length, 0)
})

test('rankSlots assigns non-negative scores', () => {
  const slots = [
    { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T00:30:00.000Z', score: 0, conflicts: {}, allAvailable: true }
  ]

  const ranked = rankSlots(slots, SYDNEY_TIME_ZONE)

  assert.ok(ranked[0].score >= 0, 'score should be non-negative')
  assert.ok(Number.isFinite(ranked[0].score), 'score should be finite')
})

// ─── formatConflictMessage ───────────────────────────────────────────────────

test('formatConflictMessage formats overlap conflict message', () => {
  const conflict = {
    type: 'overlap',
    attendeeEmail: 'a@test.com',
    attendeeName: 'Alice',
    message: 'Alice (recruiter) has a conflict 10:00\u2013AM\u201311:00\u2013AM',
    severity: 'error'
  }

  const result = formatConflictMessage(conflict)
  assert.ok(result.includes('\u274C'), 'should contain the error icon')
  assert.ok(result.includes('Alice'), 'should contain attendee name')
})

test('formatConflictMessage formats double-booking conflict message', () => {
  const conflict = {
    type: 'double_booking',
    attendeeEmail: 'a@test.com',
    attendeeName: 'Alice',
    message: 'Alice (recruiter) is double-booked: Interview with Bob Jones',
    severity: 'error'
  }

  const result = formatConflictMessage(conflict)
  assert.ok(result.includes('\u274C'))
  assert.ok(result.includes('double-booked'))
})

test('formatConflictMessage formats buffer violation message', () => {
  const conflict = {
    type: 'buffer',
    attendeeEmail: 'a@test.com',
    attendeeName: 'Alice',
    message: 'Only 5 min buffer before Alice\'s next meeting',
    severity: 'warning'
  }

  const result = formatConflictMessage(conflict)
  assert.ok(result.includes('\u26A0\uFE0F'), 'should contain the warning icon')
  assert.ok(result.includes('buffer'))
})

test('formatConflictMessage includes attendee name and time in message', () => {
  const conflict = {
    type: 'overlap',
    attendeeEmail: 'bob@test.com',
    attendeeName: 'Bob Smith',
    message: 'Bob Smith (hiring manager) has a conflict 2:00\u2013PM\u20133:00\u2013PM',
    severity: 'error'
  }

  const result = formatConflictMessage(conflict)
  assert.ok(result.includes('Bob Smith'))
})

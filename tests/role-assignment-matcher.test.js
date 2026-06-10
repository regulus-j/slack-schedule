import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchRoleAssignments,
  normalizeRoleTitle,
} from '../src/workflow/role-assignment-matcher.js'

const assignments = [
  assignment('sheet-1', 'Customer Support Specialist'),
  assignment('sheet-2', 'Senior Loan Associate - Parabroker / Senior Credit Specialist'),
  assignment('sheet-3', 'Entry-Level Sales Consultant - Sydney | Full Training Provided'),
]

test('role matcher prefers exact JazzHR job id', () => {
  const result = matchRoleAssignments(
    { roleId: 'sheet-1', title: 'Different title' },
    assignments,
  )
  assert.equal(result.matchType, 'job-id')
  assert.equal(result.matchedTitle, 'Customer Support Specialist')
})

test('role matcher canonicalizes punctuation, Unicode dashes, case, and ampersands', () => {
  assert.equal(
    normalizeRoleTitle('Sales & Partnerships Manager – Property'),
    normalizeRoleTitle('sales and partnerships manager - property'),
  )
  const result = matchRoleAssignments(
    { title: 'CUSTOMER-SUPPORT specialist' },
    assignments,
  )
  assert.equal(result.matchType, 'title')
})

test('role matcher accepts one high-confidence fuzzy title', () => {
  const result = matchRoleAssignments(
    { title: 'Senior Loan Associate Parabroker Senior Credit Spec.' },
    assignments,
  )
  assert.equal(result.matchType, 'fuzzy')
  assert.equal(result.matchedTitle, assignments[1].roleTitle)
  assert.ok(result.confidence >= 0.72)
})

test('role matcher rejects ambiguous fuzzy titles', () => {
  const result = matchRoleAssignments(
    { title: 'Sales Consultant Full Training Provided' },
    [
      assignment('', 'Entry-Level Sales Consultant - Sydney | Full Training Provided'),
      assignment('', 'Entry-Level Sales Consultant - Melbourne | Full Training Provided'),
    ],
  )
  assert.equal(result.matchType, 'ambiguous')
  assert.equal(result.assignments.length, 0)
  assert.equal(result.candidates.length, 2)
})

test('role matcher rejects low-confidence and unmatched titles', () => {
  const lowConfidence = matchRoleAssignments(
    { title: 'Video Producer' },
    assignments,
  )
  const empty = matchRoleAssignments({}, assignments)
  assert.equal(lowConfidence.matchType, 'unmatched')
  assert.equal(lowConfidence.assignments.length, 0)
  assert.equal(empty.matchType, 'unmatched')
})

function assignment(roleId, roleTitle) {
  return {
    roleId,
    roleTitle,
    hiringManager: { id: `${roleId || roleTitle}-hm`, name: 'Manager' },
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchRoleAssignmentRows,
  isOpenRoleStatus,
  normalizeRoleAssignmentRow,
  normalizeRoleAssignmentRows,
  resolveRoleAssignments,
} from '../src/services/role-assignment-export.js'

test('normalizeRoleAssignmentRow tolerates role mapping headers', () => {
  const row = normalizeRoleAssignmentRow({
    'Job ID': 'job-123',
    'Job Title': 'Customer Support Specialist',
    'Job Status': 'Open',
    'Recruiter Name': 'Mara Santos',
    'Recruiter Email': 'MARA@example.com',
    'Hiring Manager': 'Ana Cruz',
    'HM Email': 'ANA@example.com',
  })

  assert.equal(row.roleId, 'job-123')
  assert.equal(row.roleTitle, 'Customer Support Specialist')
  assert.equal(row.recruiterEmail, 'mara@example.com')
  assert.equal(row.hiringManagerEmail, 'ana@example.com')
})

test('normalizeRoleAssignmentRows supports current open roles tab shape', () => {
  const rows = normalizeRoleAssignmentRows([
    {
      '4': 'Open Roles',
      'Recruiters  to manage': 'Jun 8, 2026',
      'For Automation': 'Second/Final Interviewer',
    },
    {
      '4': 'Loan Associate - Global',
      'Recruiters  to manage': '',
      'For Automation': 'Arvind Tamilarasan, Crisielle Manalastas',
    },
    {
      '4': 'Closed / Hold / Cancelled Roles',
      'Recruiters  to manage': '',
      'For Automation': '',
    },
    {
      '4': 'Video Editor',
      'Recruiters  to manage': 'cancelled',
      'For Automation': '',
    },
  ])

  assert.deepEqual(rows.map((row) => row.roleTitle), [
    'Loan Associate - Global',
    'Loan Associate - Global',
    'Video Editor',
  ])
  assert.deepEqual(rows.slice(0, 2).map((row) => row.hiringManagerName), [
    'Arvind Tamilarasan',
    'Crisielle Manalastas',
  ])
  assert.equal(isOpenRoleStatus(rows[2].status), false)
})

test('isOpenRoleStatus excludes closed inactive roles only', () => {
  assert.equal(isOpenRoleStatus('Open'), true)
  assert.equal(isOpenRoleStatus(''), true)
  assert.equal(isOpenRoleStatus('Filled'), false)
  assert.equal(isOpenRoleStatus('Cancelled'), false)
  assert.equal(isOpenRoleStatus('Inactive'), false)
})

test('resolveRoleAssignments matches mapped people by email and creates sheet fallback people', () => {
  const assignments = resolveRoleAssignments([
    normalizeRoleAssignmentRow({
      'Job ID': 'job-123',
      'Job Title': 'Customer Support Specialist',
      'Recruiter Name': 'Mara Santos',
      'Recruiter Email': 'mara@example.com',
      'Hiring Manager': 'Unknown HM',
      'HM Email': 'unknown.hm@example.com',
    }),
  ], {
    recruiters: [{ id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' }],
    hiringManagers: [],
  })

  assert.equal(assignments.length, 1)
  assert.equal(assignments[0].recruiter.id, 'rec-mara')
  assert.equal(assignments[0].recruiter.zoomLink, 'https://zoom.us/j/mara')
  assert.equal(assignments[0].hiringManager.id, 'sheet-role-hm-unknown-hm-example-com')
})

test('fetchRoleAssignmentRows sends file id and sheet name', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls = []
  globalThis.fetch = async (url) => {
    requestedUrls.push(new URL(String(url)))
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          rows: [
            {
              'Job ID': 'job-123',
              'Job Title': 'Customer Support Specialist',
              'Recruiter Email': 'mara@example.com',
            },
          ],
        }
      },
    }
  }

  try {
    const rows = await fetchRoleAssignmentRows({
      config: {
        roleAssignmentExport: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'test-token',
          fileId: 'mapping-file-id',
          sheetName: 'Assignments',
          sheetGid: '664392081',
        },
      },
      logger: testLogger(),
    })

    assert.equal(requestedUrls[0].searchParams.get('token'), 'test-token')
    assert.equal(requestedUrls[0].searchParams.get('fileId'), 'mapping-file-id')
    assert.equal(requestedUrls[0].searchParams.get('sheetName'), 'Assignments')
    assert.equal(requestedUrls[0].searchParams.get('gid'), '664392081')
    assert.equal(rows[0].roleId, 'job-123')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function testLogger() {
  return {
    info() {},
    warn() {},
  }
}

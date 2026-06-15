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

test('normalizeRoleAssignmentRows reads people from the live role sheet columns', () => {
  const rows = normalizeRoleAssignmentRows([
    {
      '4': 'Loan Associate - Global',
      'Recruiters  to manage': 'IL',
      'Recruiters  to manage 5': 'Hanna and Tiana',
      'For Automation': 'Arvind Tamilarasan, Crisielle Manalastas, Damian Power, Peter Bassilios',
      'Column V': 'arvind@example.com, crisielle@example.com, damian@example.com, peter@example.com',
      'Column W': 'hanna@example.com, tiana@example.com',
    },
  ])

  assert.deepEqual(rows.map((row) => ({
    recruiterName: row.recruiterName,
    recruiterEmail: row.recruiterEmail,
    hiringManagerName: row.hiringManagerName,
    hiringManagerEmail: row.hiringManagerEmail,
  })), [
    {
      recruiterName: 'Hanna',
      recruiterEmail: 'hanna@example.com',
      hiringManagerName: 'Arvind Tamilarasan',
      hiringManagerEmail: 'arvind@example.com',
    },
    {
      recruiterName: 'Tiana',
      recruiterEmail: 'tiana@example.com',
      hiringManagerName: 'Crisielle Manalastas',
      hiringManagerEmail: 'crisielle@example.com',
    },
    {
      recruiterName: '',
      recruiterEmail: '',
      hiringManagerName: 'Damian Power',
      hiringManagerEmail: 'damian@example.com',
    },
    {
      recruiterName: '',
      recruiterEmail: '',
      hiringManagerName: 'Peter Bassilios',
      hiringManagerEmail: 'peter@example.com',
    },
  ])
})

test('normalizeRoleAssignmentRows expands multiple recruiters and hiring managers with normalized emails', () => {
  const rows = normalizeRoleAssignmentRows([
    {
      'JazzHR Job ID': 'job-456',
      'Role Title': 'Loan Specialist',
      'Recruiter(s)': 'Mara Santos, Jamal Al Badi',
      'Recruiter Email(s)': ' MARA@EXAMPLE.COM ; jamal@example.com ',
      'Hiring Manager(s)': 'Ana Cruz | Lee Morgan',
      'Hiring Manager Emails': 'ANA@EXAMPLE.COM\nlee@example.com',
    },
  ])

  assert.deepEqual(rows.map((row) => ({
    recruiterName: row.recruiterName,
    recruiterEmail: row.recruiterEmail,
    hiringManagerName: row.hiringManagerName,
    hiringManagerEmail: row.hiringManagerEmail,
  })), [
    {
      recruiterName: 'Mara Santos',
      recruiterEmail: 'mara@example.com',
      hiringManagerName: 'Ana Cruz',
      hiringManagerEmail: 'ana@example.com',
    },
    {
      recruiterName: 'Jamal Al Badi',
      recruiterEmail: 'jamal@example.com',
      hiringManagerName: 'Lee Morgan',
      hiringManagerEmail: 'lee@example.com',
    },
  ])

  const assignments = resolveRoleAssignments(rows, {
    recruiters: [
      {
        id: 'rec-mara',
        name: 'Mara Santos',
        email: 'mara@example.com',
        phone: '0400000001',
        zoomLink: 'https://zoom.us/j/mara',
      },
      {
        id: 'rec-jamal',
        name: 'Jamal Al Badi',
        email: 'jamal@example.com',
        phone: '0400000002',
        zoomLink: 'https://zoom.us/j/jamal',
      },
    ],
    hiringManagers: [
      { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' },
      { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com' },
    ],
  })

  assert.deepEqual(assignments.map((assignment) => assignment.recruiter.id), ['rec-mara', 'rec-jamal'])
  assert.deepEqual(assignments.map((assignment) => assignment.recruiter.phone), ['0400000001', '0400000002'])
  assert.deepEqual(assignments.map((assignment) => assignment.hiringManager.id), ['hm-ana', 'hm-lee'])
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

test('resolveRoleAssignments falls back to recruiter identity when company email domains differ', () => {
  const assignments = resolveRoleAssignments(normalizeRoleAssignmentRows([
    {
      'Job Title': 'Loan Associate - Global',
      'Recruiter Name': 'Hanna Mae Marino',
      'Recruiter Email': 'hanna.marino@opglobal.com.hk',
    },
  ]), {
    recruiters: [{
      id: 'sheet-hanna',
      name: 'Hanna Marino',
      legalName: 'Hanna Mae Marino',
      email: 'hanna.marino@freedompropertyinvestors.com.au',
      phone: '0400000000',
      zoomLink: 'https://zoom.us/j/hanna',
    }],
    hiringManagers: [],
  })

  assert.equal(assignments[0].recruiter.id, 'sheet-hanna')
  assert.equal(assignments[0].recruiter.email, 'hanna.marino@freedompropertyinvestors.com.au')
  assert.equal(assignments[0].recruiter.zoomLink, 'https://zoom.us/j/hanna')
})

test('resolveRoleAssignments keeps a mapped recruiter when contact details are missing', () => {
  const assignments = resolveRoleAssignments(normalizeRoleAssignmentRows([
    {
      'Job ID': 'job-missing-details',
      'Job Title': 'Support Specialist',
      Recruiter: 'Unknown Recruiter',
      'Recruiter Email': 'UNKNOWN.RECRUITER@EXAMPLE.COM',
      'Hiring Manager': 'Ana Cruz',
    },
  ]), {
    recruiters: [],
    hiringManagers: [{ id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' }],
  })

  assert.equal(assignments[0].recruiter.name, 'Unknown Recruiter')
  assert.equal(assignments[0].recruiter.email, 'unknown.recruiter@example.com')
  assert.equal(assignments[0].recruiter.phone, undefined)
  assert.equal(assignments[0].recruiter.zoomLink, undefined)
})

test('resolveRoleAssignments returns a null hiring manager when the mapping is blank', () => {
  const assignments = resolveRoleAssignments(normalizeRoleAssignmentRows([
    {
      'Job ID': 'job-no-hm',
      'Job Title': 'Support Specialist',
      Recruiter: 'Mara Santos',
      'Recruiter Email': 'mara@example.com',
      'Hiring Manager': '',
    },
  ]), {
    recruiters: [{ id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com' }],
    hiringManagers: [],
  })

  assert.equal(assignments.length, 1)
  assert.equal(assignments[0].recruiter.id, 'rec-mara')
  assert.equal(assignments[0].hiringManager, null)
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

test('fetchRoleAssignmentRows explains an Apps Script deployment missing doGet', async () => {
  const warnings = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<!DOCTYPE html><html><body>Cannot find script function: doGet</body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )

  try {
    const rows = await fetchRoleAssignmentRows({
      config: {
        roleAssignmentExport: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'test-token',
          fileId: 'mapping-file-id',
        },
      },
      logger: {
        info() {},
        warn(event, details) {
          warnings.push({ event, details })
        },
      },
    })

    assert.deepEqual(rows, [])
    assert.equal(warnings[0].event, 'role_assignment_export_invalid_response')
    assert.match(warnings[0].details.error, /could not find doGet/i)
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

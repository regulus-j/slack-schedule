import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchRecruiterPhoneRows,
  mergeRecruiterPhones,
  normalizeRecruiterPhoneRow,
  personIdentityMatches,
  recruiterPhoneLine,
  recruiterRowsToPeople,
} from '../src/services/recruiter-phone-export.js'

test('normalizeRecruiterPhoneRow uses exact Apps Script export headers', () => {
  const row = normalizeRecruiterPhoneRow({
    'First Name': 'Christiana',
    'Last Name': 'Dela Cruz',
    'Preferred Name': 'Tin',
    Designation: 'Recruitment Specialist',
    'Aircall ': '+63 900 111 2222',
    'Work Email': 'CHRISTIANA@example.com',
    'Personal Zoom Link': 'https://zoom.us/j/123',
  })

  assert.equal(row.name, 'Tin Dela Cruz')
  assert.equal(row.legalName, 'Christiana Dela Cruz')
  assert.equal(row.email, 'christiana@example.com')
  assert.equal(row.phone, '+63 900 111 2222')
  assert.equal(row.zoomLink, 'https://zoom.us/j/123')
})

test('normalizeRecruiterPhoneRow accepts Aircall header without trailing space', () => {
  const row = normalizeRecruiterPhoneRow({
    'First Name': 'Christiana',
    'Last Name': 'Dela Cruz',
    PreferredName: '',
    Designation: 'Recruitment Specialist',
    Aircall: '+63 900 111 2222',
    'Work Email': 'christiana@example.com',
    'Personal Zoom Link': 'https://zoom.us/j/123',
  })

  assert.equal(row.phone, '+63 900 111 2222')
})

test('normalizeRecruiterPhoneRow accepts recruiter detail header variants and normalizes email keys', () => {
  const row = normalizeRecruiterPhoneRow({
    'Given Name': 'Mara',
    Surname: 'Santos',
    Nickname: 'Mars',
    'Position Title': 'Recruitment Lead',
    'Aircall Number': '0400 111 222',
    'Email Address': ' Mara.Santos@Example.COM ',
    'Zoom Link': 'https://zoom.us/j/mara',
  })

  assert.equal(row.name, 'Mars Santos')
  assert.equal(row.email, 'mara.santos@example.com')
  assert.equal(row.phone, '0400 111 222')
  assert.equal(row.zoomLink, 'https://zoom.us/j/mara')
})

test('fetchRecruiterPhoneRows sends file id and accepts xlsx export payload shape', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls = []
  globalThis.fetch = async (url) => {
    requestedUrls.push(new URL(String(url)))
    return {
      ok: true,
      async json() {
        return {
          sourceFileId: 'sheet-file-id',
          sheet: 'Recruiters',
          count: 1,
          rows: [
            {
              'First Name': 'Armi',
              'Last Name': 'Escamilla',
              'Preferred Name': 'Armi',
              Designation: 'Senior Recruiter',
              'Aircall ': '0480002413',
              'Work Email': 'armi@example.com',
              'Personal Zoom Link': 'https://zoom.us/j/armi',
            },
          ],
        }
      },
    }
  }

  try {
    const rows = await fetchRecruiterPhoneRows({
      config: {
        recruiterPhoneExport: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'test-token',
          fileId: 'sheet-file-id',
          sheetName: 'Recruiters',
        },
      },
      logger: testLogger(),
    })

    assert.equal(requestedUrls[0].searchParams.get('token'), 'test-token')
    assert.equal(requestedUrls[0].searchParams.get('fileId'), 'sheet-file-id')
    assert.equal(requestedUrls[0].searchParams.get('sheetName'), 'Recruiters')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].phone, '0480002413')
    assert.equal(rows[0].zoomLink, 'https://zoom.us/j/armi')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchRecruiterPhoneRows explains an Apps Script deployment missing doGet', async () => {
  const warnings = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<!DOCTYPE html><html><body>Cannot find script function: doGet</body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )

  try {
    const rows = await fetchRecruiterPhoneRows({
      config: {
        recruiterPhoneExport: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'test-token',
          fileId: 'sheet-file-id',
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
    assert.equal(warnings[0].event, 'recruiter_phone_export_invalid_response')
    assert.match(warnings[0].details.error, /could not find doGet/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('mergeRecruiterPhones matches by work email first', () => {
  const recruiters = [
    {
      name: 'Different Name',
      email: 'christiana@example.com',
      role: 'recruiter',
    },
  ]
  const merged = mergeRecruiterPhones(recruiters, [
    {
      name: 'Tin Dela Cruz',
      legalName: 'Christiana Dela Cruz',
      email: 'christiana@example.com',
      phone: '+63 900 111 2222',
      zoomLink: 'https://zoom.us/j/from-sheet',
    },
  ])

  assert.equal(merged[0].phone, '+63 900 111 2222')
  assert.equal(merged[0].zoomLink, 'https://zoom.us/j/from-sheet')
})

test('mergeRecruiterPhones falls back to normalized full name', () => {
  const recruiters = [
    {
      name: 'Christiana Dela Cruz',
      email: 'missing@example.com',
      role: 'recruiter',
    },
  ]
  const merged = mergeRecruiterPhones(recruiters, [
    {
      name: 'Tin Dela Cruz',
      legalName: 'Christiana Dela Cruz',
      email: 'christiana@example.com',
      phone: '+63 900 111 2222',
    },
  ])

  assert.equal(merged[0].phone, '+63 900 111 2222')
})

test('personIdentityMatches connects preferred, legal, and cross-domain recruiter identities', () => {
  const trackerRecruiter = recruiterRowsToPeople([
    normalizeRecruiterPhoneRow({
      'First Name': 'Hanna Mae',
      'Last Name': 'Marino',
      'Preferred Name': 'Hanna',
      'Work Email': 'hanna.marino@freedompropertyinvestors.com.au',
      Aircall: '0400000000',
      'Personal Zoom Link': 'https://zoom.us/j/hanna',
    }),
  ])[0]

  assert.equal(trackerRecruiter.name, 'Hanna Marino')
  assert.equal(trackerRecruiter.legalName, 'Hanna Mae Marino')
  assert.equal(personIdentityMatches(trackerRecruiter, {
    name: 'Hanna Mae Marino',
    email: 'hanna.marino@opglobal.com.hk',
  }), true)
  assert.equal(personIdentityMatches(trackerRecruiter, {
    email: 'hanna.marino@opglobal.com.hk',
  }), true)
})

test('recruiterPhoneLine renders exact email format', () => {
  assert.equal(
    recruiterPhoneLine({ name: 'Christiana Dela Cruz', phone: '+63 900 111 2222' }),
    'Christiana Dela Cruz: +63 900 111 2222',
  )
  assert.equal(recruiterPhoneLine({ name: 'Christiana Dela Cruz' }), '')
  assert.equal(recruiterPhoneLine({ name: 'Aki Zita', phone: '-' }), '')
})

test('recruiterRowsToPeople maps Apps Script rows into primary recruiter records', () => {
  const people = recruiterRowsToPeople([
    normalizeRecruiterPhoneRow({
      'First Name': 'Armi',
      'Last Name': 'Escamilla',
      'Preferred Name': 'Armi',
      Designation: 'Senior Recruiter',
      'Aircall ': '0480002413/ 0489275966',
      'Work Email': 'armi@freedompropertyinvestors.com.au',
      'Personal Zoom Link': 'https://freedompropertyinvestors-au.zoom.us/my/armi.escamilla',
    }),
  ])

  assert.equal(people[0].name, 'Armi Escamilla')
  assert.equal(people[0].email, 'armi@freedompropertyinvestors.com.au')
  assert.equal(people[0].role, 'recruiter')
  assert.equal(people[0].positionTitle, 'Senior Recruiter')
  assert.equal(people[0].phone, '0480002413/ 0489275966')
  assert.equal(people[0].zoomLink, 'https://freedompropertyinvestors-au.zoom.us/my/armi.escamilla')
})

test('recruiterRowsToPeople preserves multiple recruiter detail records', () => {
  const people = recruiterRowsToPeople([
    normalizeRecruiterPhoneRow({
      'First Name': 'Mara',
      'Last Name': 'Santos',
      'Work Email': 'mara@example.com',
      Aircall: '0400000001',
      'Personal Zoom Link': 'https://zoom.us/j/mara',
    }),
    normalizeRecruiterPhoneRow({
      'First Name': 'Jamal',
      'Last Name': 'Al Badi',
      'Work Email': 'jamal@example.com',
      Mobile: '0400000002',
      'Zoom Link': 'https://zoom.us/j/jamal',
    }),
  ])

  assert.deepEqual(people.map((person) => ({
    email: person.email,
    phone: person.phone,
    zoomLink: person.zoomLink,
  })), [
    {
      email: 'mara@example.com',
      phone: '0400000001',
      zoomLink: 'https://zoom.us/j/mara',
    },
    {
      email: 'jamal@example.com',
      phone: '0400000002',
      zoomLink: 'https://zoom.us/j/jamal',
    },
  ])
})

function testLogger() {
  return {
    info() {},
    warn() {},
  }
}

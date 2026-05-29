import test from 'node:test'
import assert from 'node:assert/strict'
import { getHiringManagers, getTalentRecruiters, setHiringManagers, setTalentRecruiters } from '../src/data/cache.js'
import { personOptions } from '../src/data/search.js'
import { isRecruitmentTalent, loadTalentDirectory, parseTalentDirectory } from '../src/services/talent-directory.js'

test('parseTalentDirectory loads SQL talent rows', () => {
  const people = parseTalentDirectory(`
    INSERT INTO talent_directory (first_name, last_name, designation, department, work_email) VALUES
    ('Ana', 'Cruz', 'Operations Manager', 'Operations', 'ana@example.com'),
    ('Mara', 'Santos', 'Recruitment Lead', 'Talent Acquisition', 'mara@example.com');
  `)

  assert.equal(people.length, 2)
  assert.equal(people[0].name, 'Ana Cruz')
  assert.equal(people[1].positionTitle, 'Recruitment Lead')
})

test('loadTalentDirectory uses Postgres talent rows and filters recruiters by recruitment designation', async () => {
  setHiringManagers([])
  setTalentRecruiters([])

  await loadTalentDirectory(
    { runtimeDir: 'unused' },
    {
      async listTalentDirectory() {
        return [
          {
            id: 'hm-1',
            name: 'Ana Cruz',
            email: 'ana@example.com',
            role: 'hiring_manager',
            positionTitle: 'Operations Manager',
            department: 'Operations',
          },
          {
            id: 'hm-2',
            name: 'Mara Santos',
            email: 'mara@example.com',
            role: 'hiring_manager',
            positionTitle: 'Recruitment Specialist',
            department: 'People',
          },
        ]
      },
    },
  )

  assert.equal(getHiringManagers().length, 2)
  assert.equal(getTalentRecruiters().length, 1)
  assert.equal(getTalentRecruiters()[0].name, 'Mara Santos')
  assert.equal(getTalentRecruiters()[0].role, 'recruiter')
})

test('loadTalentDirectory uses Apps Script recruiter rows as the primary recruiter source', async () => {
  setHiringManagers([])
  setTalentRecruiters([])

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.match(String(url), /token=test-token/)
    assert.match(String(url), /fileId=sheet-file-id/)
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          rows: [
            {
              'First Name': 'Armi',
              'Last Name': 'Escamilla',
              'Preferred Name': 'Armi',
              Designation: 'Senior Recruiter',
              'Aircall ': '0480002413/ 0489275966',
              'Work Email': 'armi@freedompropertyinvestors.com.au',
              'Personal Zoom Link': 'https://freedompropertyinvestors-au.zoom.us/my/armi.escamilla',
            },
            {
              'First Name': 'Jamal',
              'Last Name': 'Al Badi',
              'Preferred Name': 'Jam',
              Designation: 'Recruitment Automation Intern',
              'Aircall ': '-',
              'Work Email': 'jam.albadi@freedompropertyinvestors.com.au',
              'Personal Zoom Link': '',
            },
          ],
        }
      },
    }
  }

  try {
    await loadTalentDirectory(
      {
        runtimeDir: 'unused',
        recruiterPhoneExport: {
          url: 'https://script.google.com/macros/s/demo/exec',
          token: 'test-token',
          fileId: 'sheet-file-id',
        },
      },
      {
        async listTalentDirectory() {
          return [
            {
              id: 'hm-1',
              name: 'Mara Santos',
              email: 'mara@example.com',
              role: 'hiring_manager',
              positionTitle: 'Recruitment Specialist',
              department: 'People',
            },
          ]
        },
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  const recruiters = getTalentRecruiters()
  assert.equal(recruiters[0].email, 'armi@freedompropertyinvestors.com.au')
  assert.equal(recruiters[0].phone, '0480002413/ 0489275966')
  assert.equal(recruiters[0].zoomLink, 'https://freedompropertyinvestors-au.zoom.us/my/armi.escamilla')
  assert.equal(recruiters[1].email, 'jam.albadi@freedompropertyinvestors.com.au')
  assert.equal(recruiters[1].phone, '-')
  assert.ok(recruiters.some((recruiter) => recruiter.email === 'mara@example.com'))
  assert.deepEqual(personOptions('armi', recruiters).map((option) => option.text.text), [
    'Armi Escamilla - armi@freedompropertyinvestors.com.au',
  ])
})

test('isRecruitmentTalent matches recruitment in designation or department', () => {
  assert.equal(isRecruitmentTalent({ positionTitle: 'Recruitment Lead' }), true)
  assert.equal(isRecruitmentTalent({ department: 'Recruitment' }), true)
  assert.equal(isRecruitmentTalent({ positionTitle: 'Operations Manager' }), false)
})

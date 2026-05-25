import test from 'node:test'
import assert from 'node:assert/strict'
import { getHiringManagers, getTalentRecruiters, setHiringManagers, setTalentRecruiters } from '../src/data/cache.js'
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

test('isRecruitmentTalent matches recruitment in designation or department', () => {
  assert.equal(isRecruitmentTalent({ positionTitle: 'Recruitment Lead' }), true)
  assert.equal(isRecruitmentTalent({ department: 'Recruitment' }), true)
  assert.equal(isRecruitmentTalent({ positionTitle: 'Operations Manager' }), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getApplicants,
  getHiringManagers,
  getOpenRoles,
  getRoleAssignments,
  getTalentRecruiters,
  setApplicants,
  setHiringManagers,
  setJazzhrJobs,
  setRoleAssignments,
  setTalentRecruiters,
} from '../src/data/cache.js'
import { filterApplicants } from '../src/data/search.js'
import {
  TEST_DIRECTORY_HIRING_MANAGERS,
  TEST_DIRECTORY_RECRUITERS,
  TEST_DIRECTORY_ROLE,
  TEST_DIRECTORY_ROLE_ID,
  applyTestDirectoryData,
  isTestDirectoryRoleId,
} from '../src/services/test-directory-data.js'
import {
  mappedHiringManagersForRole,
  mappedRecruitersForRole,
  resolveZoomLinkForRecruiters,
  roleAutofillSelections,
} from '../src/slack/handlers.js'

test('test directory data is not visible when email test mode is off', () => {
  resetDirectoryCaches()

  const result = applyTestDirectoryData({ email: { testMode: false } })

  assert.deepEqual(result, { applied: false })
  assert.equal(getOpenRoles().some((role) => role.id === TEST_DIRECTORY_ROLE_ID), false)
  assert.equal(getTalentRecruiters().length, 0)
  assert.equal(getHiringManagers().length, 0)
})

test('email test mode exposes dummy role, recruiters, HM, and candidate autofill data', () => {
  resetDirectoryCaches()

  const result = applyTestDirectoryData({ email: { testMode: true } })
  applyTestDirectoryData({ email: { testMode: true } })

  assert.equal(result.applied, true)
  assert.equal(getOpenRoles().filter((role) => role.id === TEST_DIRECTORY_ROLE_ID).length, 1)
  assert.equal(getRoleAssignments().filter((assignment) => assignment.roleId === TEST_DIRECTORY_ROLE_ID).length, 2)

  const role = getOpenRoles().find((item) => item.id === TEST_DIRECTORY_ROLE_ID)
  assert.equal(role.title, TEST_DIRECTORY_ROLE.title)

  const recruiters = mappedRecruitersForRole(TEST_DIRECTORY_ROLE_ID)
  assert.deepEqual(recruiters.map((person) => person.id), TEST_DIRECTORY_RECRUITERS.map((person) => person.id))
  assert.equal(recruiters[0].email, TEST_DIRECTORY_RECRUITERS[0].email)
  assert.equal(recruiters[0].phone, TEST_DIRECTORY_RECRUITERS[0].phone)
  assert.equal(recruiters[0].zoomLink, TEST_DIRECTORY_RECRUITERS[0].zoomLink)
  assert.equal(recruiters[0].signature, TEST_DIRECTORY_RECRUITERS[0].signature)

  const hiringManagers = mappedHiringManagersForRole(TEST_DIRECTORY_ROLE_ID)
  assert.deepEqual(hiringManagers.map((person) => person.id), TEST_DIRECTORY_HIRING_MANAGERS.map((person) => person.id))
  assert.equal(hiringManagers[0].email, TEST_DIRECTORY_HIRING_MANAGERS[0].email)
  assert.equal(hiringManagers[0].positionTitle, TEST_DIRECTORY_HIRING_MANAGERS[0].positionTitle)
  assert.equal(hiringManagers[0].department, TEST_DIRECTORY_HIRING_MANAGERS[0].department)

  assert.deepEqual(roleAutofillSelections('final-interview', recruiters, hiringManagers), {
    recruiterIds: [TEST_DIRECTORY_RECRUITERS[0].id],
    hiringManagerIds: [TEST_DIRECTORY_HIRING_MANAGERS[0].id],
  })
  assert.equal(resolveZoomLinkForRecruiters([recruiters[0]]), TEST_DIRECTORY_RECRUITERS[0].zoomLink)
  assert.equal(isTestDirectoryRoleId(TEST_DIRECTORY_ROLE_ID), true)

  const candidates = filterApplicants(getApplicants(), {
    roleId: TEST_DIRECTORY_ROLE_ID,
    recruiterIds: [TEST_DIRECTORY_RECRUITERS[0].id],
  })
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['applicant-test-scheduling-demo'])
})

function resetDirectoryCaches() {
  setApplicants([])
  setJazzhrJobs([])
  setTalentRecruiters([])
  setHiringManagers([])
  setRoleAssignments([])
}

import {
  getApplicants,
  getHiringManagers,
  getJazzhrJobs,
  getRoleAssignments,
  getTalentRecruiters,
  getRecruitmentSheetPeople,
  setApplicants,
  setHiringManagers,
  setJazzhrJobs,
  setRoleAssignments,
  setTalentRecruiters,
  setRecruitmentSheetPeople,
} from '../data/cache.js'

export const TEST_DIRECTORY_ROLE_ID = 'job-test-scheduling-automation'

export const TEST_DIRECTORY_ROLE = {
  id: TEST_DIRECTORY_ROLE_ID,
  roleId: TEST_DIRECTORY_ROLE_ID,
  roleKey: TEST_DIRECTORY_ROLE_ID,
  title: '[TEST] Scheduling Automation Demo Role',
  status: 'Open',
  hiringLeadId: 'rec-test-scheduling-primary',
}

export const TEST_DIRECTORY_RECRUITERS = [
  {
    id: 'rec-test-scheduling-primary',
    name: '[TEST] Ava Recruiter',
    email: 'test.recruiter.primary@example.com',
    role: 'recruiter',
    slackUserId: '',
    legalName: 'Ava Recruiter',
    preferredName: 'Ava',
    phone: '+63 900 000 0101',
    zoomLink: 'https://zoom.us/j/9000000101',
    positionTitle: 'Test Recruitment Lead',
    department: 'Recruitment',
    signature: 'Ava Recruiter\nTest Recruitment Lead',
    source: 'email_test_mode',
  },
  {
    id: 'rec-test-scheduling-backup',
    name: '[TEST] Ben Backup Recruiter',
    email: 'test.recruiter.backup@example.com',
    role: 'recruiter',
    slackUserId: '',
    legalName: 'Ben Backup Recruiter',
    preferredName: 'Ben',
    phone: '+63 900 000 0102',
    zoomLink: 'https://zoom.us/j/9000000102',
    positionTitle: 'Test Talent Partner',
    department: 'Recruitment',
    signature: 'Ben Backup Recruiter\nTest Talent Partner',
    source: 'email_test_mode',
  },
]

export const TEST_DIRECTORY_HIRING_MANAGERS = [
  {
    id: 'hm-test-scheduling-primary',
    name: '[TEST] Nora Hiring Manager',
    email: 'test.hm.primary@example.com',
    role: 'hiring_manager',
    slackUserId: '',
    positionTitle: 'Test Operations Manager',
    department: 'Operations',
    source: 'email_test_mode',
  },
  {
    id: 'hm-test-scheduling-backup',
    name: '[TEST] Leo Backup HM',
    email: 'test.hm.backup@example.com',
    role: 'hiring_manager',
    slackUserId: '',
    positionTitle: 'Test Client Services Lead',
    department: 'Client Services',
    source: 'email_test_mode',
  },
]

export const TEST_DIRECTORY_APPLICANTS = [
  {
    id: 'applicant-test-scheduling-demo',
    jazzhrApplicationId: '',
    firstName: 'Test',
    lastName: 'Candidate',
    fullName: 'Test Candidate',
    email: 'test.candidate@example.com',
    phone: '+63 900 000 0103',
    jobTitle: TEST_DIRECTORY_ROLE.title,
    jazzhrJobId: TEST_DIRECTORY_ROLE_ID,
    jobStatus: 'Open',
    stage: '2nd Interview',
    workflowStep: '2nd Interview',
    workflowCategory: 'Interview',
    recruiterId: TEST_DIRECTORY_RECRUITERS[0].id,
    recruiterEmail: TEST_DIRECTORY_RECRUITERS[0].email,
    recruiterName: TEST_DIRECTORY_RECRUITERS[0].name,
    source: 'email_test_mode',
  },
]

export const TEST_DIRECTORY_ROLE_ASSIGNMENTS = [
  {
    roleId: TEST_DIRECTORY_ROLE_ID,
    roleTitle: TEST_DIRECTORY_ROLE.title,
    roleKey: TEST_DIRECTORY_ROLE_ID,
    status: 'Open',
    recruiterName: TEST_DIRECTORY_RECRUITERS[0].name,
    recruiterEmail: TEST_DIRECTORY_RECRUITERS[0].email,
    hiringManagerName: TEST_DIRECTORY_HIRING_MANAGERS[0].name,
    hiringManagerEmail: TEST_DIRECTORY_HIRING_MANAGERS[0].email,
    recruiter: TEST_DIRECTORY_RECRUITERS[0],
    hiringManager: TEST_DIRECTORY_HIRING_MANAGERS[0],
    source: 'email_test_mode',
  },
  {
    roleId: TEST_DIRECTORY_ROLE_ID,
    roleTitle: TEST_DIRECTORY_ROLE.title,
    roleKey: TEST_DIRECTORY_ROLE_ID,
    status: 'Open',
    recruiterName: TEST_DIRECTORY_RECRUITERS[1].name,
    recruiterEmail: TEST_DIRECTORY_RECRUITERS[1].email,
    hiringManagerName: TEST_DIRECTORY_HIRING_MANAGERS[1].name,
    hiringManagerEmail: TEST_DIRECTORY_HIRING_MANAGERS[1].email,
    recruiter: TEST_DIRECTORY_RECRUITERS[1],
    hiringManager: TEST_DIRECTORY_HIRING_MANAGERS[1],
    source: 'email_test_mode',
  },
]

export function applyTestDirectoryData(config, logger) {
  if (!config?.email?.testMode) {
    return { applied: false }
  }

  setJazzhrJobs(mergeById(getJazzhrJobs(), [TEST_DIRECTORY_ROLE]))
  setTalentRecruiters(mergeById(getTalentRecruiters(), TEST_DIRECTORY_RECRUITERS))
  setRecruitmentSheetPeople(mergeById(getRecruitmentSheetPeople(), TEST_DIRECTORY_RECRUITERS))
  setHiringManagers(mergeById(getHiringManagers(), TEST_DIRECTORY_HIRING_MANAGERS))
  setApplicants(mergeById(getApplicants(), TEST_DIRECTORY_APPLICANTS))
  setRoleAssignments(mergeRoleAssignments(getRoleAssignments(), TEST_DIRECTORY_ROLE_ASSIGNMENTS))

  logger?.info?.('test_directory_data_loaded', {
    roleId: TEST_DIRECTORY_ROLE_ID,
    recruiters: TEST_DIRECTORY_RECRUITERS.length,
    hiringManagers: TEST_DIRECTORY_HIRING_MANAGERS.length,
    applicants: TEST_DIRECTORY_APPLICANTS.length,
  })

  return {
    applied: true,
    roleId: TEST_DIRECTORY_ROLE_ID,
    recruiters: TEST_DIRECTORY_RECRUITERS.length,
    hiringManagers: TEST_DIRECTORY_HIRING_MANAGERS.length,
    applicants: TEST_DIRECTORY_APPLICANTS.length,
  }
}

export function isTestDirectoryRoleId(roleId) {
  return String(roleId || '').trim() === TEST_DIRECTORY_ROLE_ID
}

function mergeById(existing, additions) {
  const byId = new Map()
  for (const item of [...array(existing), ...array(additions)]) {
    const id = String(item?.id || '').trim()
    if (!id) continue
    byId.set(id, item)
  }
  return [...byId.values()]
}

function mergeRoleAssignments(existing, additions) {
  const byKey = new Map()
  for (const item of [...array(existing), ...array(additions)]) {
    const key = [
      item?.roleId || item?.roleKey || item?.roleTitle,
      item?.recruiter?.id || item?.recruiterEmail || item?.recruiterName,
      item?.hiringManager?.id || item?.hiringManagerEmail || item?.hiringManagerName,
    ].map((value) => String(value || '').trim().toLowerCase()).join('|')
    if (!key.replace(/\|/g, '')) continue
    byKey.set(key, item)
  }
  return [...byKey.values()]
}

function array(value) {
  return Array.isArray(value) ? value : []
}

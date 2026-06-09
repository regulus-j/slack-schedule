let applicants = [];
let recruiters = [];
let hiringManagers = [];
let talentRecruiters = [];
let slackUsers = [];
let slackRecruiters = [];
let roleAssignments = [];
let jazzhrJobs = [];
let openRoles = [];
const applicantDetails = new Map();

export function getApplicants() {
  return applicants;
}

export function getRecruiters() {
  return recruiters;
}

export function getHiringManagers() {
  return hiringManagers;
}

export function getTalentRecruiters() {
  return talentRecruiters;
}

export function getSlackUsers() {
  return slackUsers;
}

export function getSlackRecruiters() {
  return slackRecruiters;
}

export function getRoleAssignments() {
  return roleAssignments;
}

export function getOpenRoles() {
  return openRoles;
}

export function getJazzhrJobs() {
  return jazzhrJobs;
}

export function getAllPeople() {
  return [...slackUsers, ...talentRecruiters, ...recruiters, ...hiringManagers];
}

export function setApplicants(data) {
  applicants = Array.isArray(data) ? data : [];
}

export function setRecruiters(data) {
  recruiters = Array.isArray(data) ? data : [];
}

export function setHiringManagers(data) {
  hiringManagers = Array.isArray(data) ? data : [];
}

export function setTalentRecruiters(data) {
  talentRecruiters = Array.isArray(data) ? data : [];
}

export function setSlackUsers(data) {
  slackUsers = Array.isArray(data) ? data : [];
}

export function setSlackRecruiters(data) {
  slackRecruiters = Array.isArray(data) ? data : [];
}

export function setRoleAssignments(data) {
  roleAssignments = Array.isArray(data) ? data : [];
  rebuildOpenRoles()
}

export function setJazzhrJobs(data) {
  jazzhrJobs = Array.isArray(data) ? data : []
  rebuildOpenRoles()
}

function rebuildOpenRoles() {
  if (jazzhrJobs.length > 0) {
    openRoles = jazzhrJobs
      .filter((job) => isOpenJazzhrJob(job))
      .map((job) => ({
        id: job.id,
        roleId: job.id,
        roleKey: job.id,
        title: job.title || job.id,
        status: job.status || 'Open',
        hiringLeadId: job.hiringLeadId || '',
      }))
    return
  }

  const byId = new Map()
  for (const assignment of roleAssignments) {
    const id = assignment.roleId || assignment.roleKey
    if (!id || byId.has(id)) continue
    byId.set(id, {
      id,
      roleId: assignment.roleId || '',
      roleKey: assignment.roleKey || id,
      title: assignment.roleTitle || assignment.title || '',
      status: assignment.status || '',
    })
  }
  openRoles = [...byId.values()]
}

function isOpenJazzhrJob(job) {
  const status = String(job?.status || '').trim().toLowerCase()
  return status === 'open' || status === 'active' || status === 'published'
}

export function getApplicantDetail(id) {
  return applicantDetails.get(id) || null;
}

export function setApplicantDetail(id, data) {
  if (id && data) {
    applicantDetails.set(id, data);
  }
}

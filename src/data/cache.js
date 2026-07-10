// Global / non-JazzHR data (shared across all accounts)
let hiringManagers = []
let talentRecruiters = []
let recruitmentSheetPeople = []
let slackUsers = []
let slackRecruiters = []
let roleAssignments = []

// Per-account JazzHR-sourced data
const accounts = new Map() // Map<string, AccountState>

const DEFAULT_ACCOUNT = 'default'

function getAccountState(accountKey = DEFAULT_ACCOUNT) {
  if (!accounts.has(accountKey)) {
    accounts.set(accountKey, {
      applicants: [],
      recruiters: [],
      jazzhrJobs: [],
      openRoles: [],
      applicantDetails: new Map(),
      _allPeopleDirty: true,
      _allPeopleCache: [],
    })
  }
  return accounts.get(accountKey)
}

// ── JazzHR-sourced getters (per-account) ──

export function getApplicants(accountKey = DEFAULT_ACCOUNT) {
  return getAccountState(accountKey).applicants
}

export function getRecruiters(accountKey = DEFAULT_ACCOUNT) {
  return getAccountState(accountKey).recruiters
}

export function getJazzhrJobs(accountKey = DEFAULT_ACCOUNT) {
  return getAccountState(accountKey).jazzhrJobs
}

export function getOpenRoles(accountKey = DEFAULT_ACCOUNT) {
  const state = getAccountState(accountKey)
  // Lazy fallback: if neither JazzHR jobs nor role assignments have populated this
  // account's openRoles yet, rebuild from global roleAssignments on first access.
  if (state.openRoles.length === 0 && state.jazzhrJobs.length === 0) {
    rebuildOpenRoles(accountKey)
  }
  return state.openRoles
}

export function getApplicantDetail(id, accountKey = DEFAULT_ACCOUNT) {
  return getAccountState(accountKey).applicantDetails.get(id) || null
}

// ── JazzHR-sourced setters (per-account) ──

export function setApplicants(data, accountKey = DEFAULT_ACCOUNT) {
  getAccountState(accountKey).applicants = Array.isArray(data) ? data : []
}

export function setRecruiters(data, accountKey = DEFAULT_ACCOUNT) {
  const state = getAccountState(accountKey)
  state.recruiters = Array.isArray(data) ? data : []
  state._allPeopleDirty = true
}

export function setJazzhrJobs(data, accountKey = DEFAULT_ACCOUNT) {
  const state = getAccountState(accountKey)
  state.jazzhrJobs = Array.isArray(data) ? data : []
  rebuildOpenRoles(accountKey)
}

export function setApplicantDetail(id, data, accountKey = DEFAULT_ACCOUNT) {
  if (id && data) {
    getAccountState(accountKey).applicantDetails.set(id, data)
  }
}

// ── Global getters (unchanged signatures) ──

export function getHiringManagers() {
  return hiringManagers
}

export function getTalentRecruiters() {
  return talentRecruiters
}

export function getRecruitmentSheetPeople() {
  return recruitmentSheetPeople
}

export function getSlackUsers() {
  return slackUsers
}

export function getSlackRecruiters() {
  return slackRecruiters
}

export function getRoleAssignments() {
  return roleAssignments
}

let googleAccounts = []

export function getGoogleAccounts() {
  return googleAccounts
}

export function setGoogleAccounts(data) {
  googleAccounts = Array.isArray(data) ? data : []
}

export function getAllPeople(accountKey = DEFAULT_ACCOUNT) {
  const state = getAccountState(accountKey)
  if (state._allPeopleDirty) {
    state._allPeopleCache = [...slackUsers, ...talentRecruiters, ...state.recruiters, ...hiringManagers]
    state._allPeopleDirty = false
  }
  return state._allPeopleCache
}

// ── Global setters (mostly unchanged) ──

export function setHiringManagers(data) {
  hiringManagers = Array.isArray(data) ? data : []
  markAllPeopleDirty()
}

export function setTalentRecruiters(data) {
  talentRecruiters = Array.isArray(data) ? data : []
  markAllPeopleDirty()
}

export function setRecruitmentSheetPeople(data) {
  recruitmentSheetPeople = Array.isArray(data) ? data : []
}

export function setSlackUsers(data) {
  slackUsers = Array.isArray(data) ? data : []
  markAllPeopleDirty()
}

export function setSlackRecruiters(data) {
  slackRecruiters = Array.isArray(data) ? data : []
}

export function setRoleAssignments(data) {
  roleAssignments = Array.isArray(data) ? data : []
  // Rebuild openRoles for all known accounts (roleAssignments is the fallback source)
  if (accounts.size > 0) {
    for (const accountKey of accounts.keys()) {
      rebuildOpenRoles(accountKey)
    }
  } else {
    rebuildOpenRoles(DEFAULT_ACCOUNT)
  }
}

// ── Internal helpers ──

function markAllPeopleDirty() {
  for (const state of accounts.values()) {
    state._allPeopleDirty = true
  }
  // Also dirty the default state if it exists or will be lazily created
  if (accounts.has(DEFAULT_ACCOUNT)) {
    accounts.get(DEFAULT_ACCOUNT)._allPeopleDirty = true
  }
}

function rebuildOpenRoles(accountKey = DEFAULT_ACCOUNT) {
  const state = getAccountState(accountKey)

  if (state.jazzhrJobs.length > 0) {
    state.openRoles = state.jazzhrJobs
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

  // Fall back to global roleAssignments
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
  state.openRoles = [...byId.values()]
}

function isOpenJazzhrJob(job) {
  const status = String(job?.status || '').trim().toLowerCase()
  return status === 'open' || status === 'active' || status === 'published'
}

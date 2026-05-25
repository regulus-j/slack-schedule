let applicants = [];
let recruiters = [];
let hiringManagers = [];
let slackUsers = [];
let slackRecruiters = [];
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

export function getSlackUsers() {
  return slackUsers;
}

export function getSlackRecruiters() {
  return slackRecruiters;
}

export function getAllPeople() {
  return [...slackUsers, ...recruiters, ...hiringManagers];
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

export function setSlackUsers(data) {
  slackUsers = Array.isArray(data) ? data : [];
}

export function setSlackRecruiters(data) {
  slackRecruiters = Array.isArray(data) ? data : [];
}

export function getApplicantDetail(id) {
  return applicantDetails.get(id) || null;
}

export function setApplicantDetail(id, data) {
  if (id && data) {
    applicantDetails.set(id, data);
  }
}

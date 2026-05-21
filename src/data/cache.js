let applicants = [];
let recruiters = [];
let hiringManagers = [];

export function getApplicants() {
  return applicants;
}

export function getRecruiters() {
  return recruiters;
}

export function getHiringManagers() {
  return hiringManagers;
}

export function getAllPeople() {
  return [...recruiters, ...hiringManagers];
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

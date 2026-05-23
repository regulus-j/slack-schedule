let applicants = [];
let recruiters = [];
let hiringManagers = [];
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

export function getApplicantDetail(id) {
  return applicantDetails.get(id) || null;
}

export function setApplicantDetail(id, data) {
  if (id && data) {
    applicantDetails.set(id, data);
  }
}

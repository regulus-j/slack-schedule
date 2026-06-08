import { getApplicants, getAllPeople } from './cache.js';

export function personLabel(person) {
  return formatPersonLabel(person, 'display');
}

export function personPickerLabel(person) {
  return formatPersonLabel(person, 'picker');
}

export function applicantLabel(applicant) {
  return formatApplicantLabel(applicant, 'display');
}

export function applicantPickerLabel(applicant) {
  return formatApplicantLabel(applicant, 'picker');
}

export function toSlackOption(text, value) {
  return {
    text: {
      type: 'plain_text',
      text: trimForSlack(text, 75),
    },
    value,
  };
}

export function trimForSlack(value, max = 75) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function searchApplicants(query, applicants = getApplicants()) {
  return searchRecords(query, applicants, (item) =>
    [item.firstName, item.lastName, item.email, item.jobTitle, item.jazzhrApplicationId].join(' '),
  );
}

export function filterApplicants(applicants = [], filters = {}) {
  const roleId = String(filters.roleId || '').trim()
  const roleTitle = normalizeSearchText(filters.roleTitle)
  const recruiterIds = new Set((filters.recruiterIds || []).map(normalizeRecruiterId).filter(Boolean))

  return (Array.isArray(applicants) ? applicants : []).filter((applicant) => {
    if (roleId) {
      const applicantRoleId = String(applicant?.jazzhrJobId || applicant?.jobId || applicant?.job_id || '').trim()
      if (applicantRoleId !== roleId) return false
    } else if (roleTitle) {
      const applicantRoleTitle = normalizeSearchText(applicant?.jobTitle || applicant?.job_title)
      if (applicantRoleTitle !== roleTitle) return false
    }

    if (recruiterIds.size > 0) {
      const recruiterId = normalizeRecruiterId(applicant?.recruiterId || applicant?.recruiter_id)
      if (!recruiterIds.has(recruiterId)) return false
    }

    return true
  })
}

export function searchApplicantsWithFilters(query, applicants = getApplicants(), filters = {}) {
  return searchApplicants(query, filterApplicants(applicants, filters))
}

export function searchPeople(query, people = getAllPeople()) {
  return searchRecords(query, people, (item) => [item.name, item.email, item.role, item.positionTitle].join(' '));
}

export function searchRecords(query, records, toHaystack) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return records.slice(0, 20);
  return records
    .filter((record) => toHaystack(record).toLowerCase().includes(normalized))
    .slice(0, 20);
}

export function findApplicant(id, applicants = getApplicants()) {
  return applicants.find((applicant) => applicant.id === id);
}

export function findPerson(id, people = getAllPeople()) {
  return people.find((person) => person.id === id);
}

export function personOptions(query, people = getAllPeople()) {
  return searchPeople(query, people).map((person) => toSlackOption(personPickerLabel(person), person.id));
}

export function applicantOptions(query, applicants = getApplicants()) {
  return searchApplicants(query, applicants).map((applicant) =>
    toSlackOption(applicantPickerLabel(applicant), applicant.id),
  );
}

function formatPersonLabel(person, mode) {
  const name = person?.name || 'Unknown';
  const email = person?.email ? (mode === 'display' ? ` (${person.email})` : ` - ${person.email}`) : '';
  return `${name}${email}`;
}

function formatApplicantLabel(applicant, mode) {
  const name = applicant?.fullName || [applicant?.firstName, applicant?.lastName].filter(Boolean).join(' ') || 'Unknown';
  const email = applicant?.email || '';
  const job = applicant?.jobTitle || '';
  if (mode === 'picker') {
    return [name, email].filter(Boolean).join(' - ');
  }
  const emailPart = email ? ` (${email})` : '';
  const jobPart = job ? ` - ${job}` : '';
  return `${name}${emailPart}${jobPart}`;
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeRecruiterId(value) {
  const id = String(value || '').trim()
  if (!id) return ''
  return id.startsWith('rec-') ? id : `rec-${id}`
}

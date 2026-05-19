import { SAMPLE_APPLICANTS, SAMPLE_PEOPLE } from './sample-data.js';

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
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function searchApplicants(query, applicants = SAMPLE_APPLICANTS) {
  return searchRecords(query, applicants, (item) =>
    [item.firstName, item.lastName, item.email, item.jobTitle, item.jazzhrApplicationId].join(' '),
  );
}

export function searchPeople(query, people = SAMPLE_PEOPLE) {
  return searchRecords(query, people, (item) => [item.name, item.email, item.role].join(' '));
}

export function searchRecords(query, records, toHaystack) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return records.slice(0, 20);
  return records
    .filter((record) => toHaystack(record).toLowerCase().includes(normalized))
    .slice(0, 20);
}

export function findApplicant(id, applicants = SAMPLE_APPLICANTS) {
  return applicants.find((applicant) => applicant.id === id);
}

export function findPerson(id, people = SAMPLE_PEOPLE) {
  return people.find((person) => person.id === id);
}

export function personOptions(query, people = SAMPLE_PEOPLE) {
  return searchPeople(query, people).map((person) => toSlackOption(personPickerLabel(person), person.id));
}

export function applicantOptions(query, applicants = SAMPLE_APPLICANTS) {
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
  const name = [applicant?.firstName, applicant?.lastName].filter(Boolean).join(' ') || 'Unknown';
  const email = applicant?.email ? (mode === 'display' ? ` (${applicant.email})` : ` - ${applicant.email}`) : '';
  const job = applicant?.jobTitle ? ` - ${applicant.jobTitle}` : '';
  return `${name}${email}${job}`;
}

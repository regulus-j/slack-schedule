import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicantLabel,
  applicantPickerLabel,
  filterApplicants,
  personLabel,
  personPickerLabel,
  searchRecords,
  trimForSlack,
} from '../src/data/search.js';

test('formats display and picker labels differently', () => {
  assert.equal(personLabel({ name: 'Ana Cruz', email: 'ana@example.com' }), 'Ana Cruz (ana@example.com)');
  assert.equal(personPickerLabel({ name: 'Ana Cruz', email: 'ana@example.com' }), 'Ana Cruz - ana@example.com');
  assert.equal(
    applicantLabel({
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support',
    }),
    'Alex Reyes (alex@example.com) - Support',
  );
  assert.equal(
    applicantPickerLabel({
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support',
    }),
    'Alex Reyes - alex@example.com',
  );
});

test('searches records case-insensitively', () => {
  const results = searchRecords(
    'support',
    [
      { name: 'A', job: 'Support' },
      { name: 'B', job: 'Finance' },
    ],
    (item) => `${item.name} ${item.job}`,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'A');
});

test('trims Slack option text to the requested maximum length', () => {
  const text = 'A'.repeat(90);
  assert.equal(trimForSlack(text).length, 75);
  assert.equal(trimForSlack(text), `${'A'.repeat(72)}...`);
});

test('filters applicants by JazzHR role and recruiter context', () => {
  const results = filterApplicants([
    { fullName: 'Alex One', jazzhrJobId: 'job-1', jobTitle: 'Support', recruiterId: 'rec-123' },
    { fullName: 'Alex Two', jazzhrJobId: 'job-2', jobTitle: 'Sales', recruiterId: 'rec-123' },
    { fullName: 'Alex Three', jazzhrJobId: 'job-1', jobTitle: 'Support', recruiterId: 'rec-999' },
  ], {
    roleId: 'job-1',
    recruiterIds: ['123'],
  })

  assert.deepEqual(results.map((item) => item.fullName), ['Alex One'])
})

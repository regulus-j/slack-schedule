import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicantLabel,
  applicantPickerLabel,
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
    'Alex Reyes - Support - alex@example.com',
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

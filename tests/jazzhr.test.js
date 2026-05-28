import test from 'node:test';
import assert from 'node:assert/strict';
import { filterActiveApplicants, inactiveApplicantReason } from '../src/services/jazzhr.js';

function applicant(overrides = {}) {
  return {
    id: overrides.id || `id-${Math.random()}`,
    first_name: overrides.first_name || 'Alex',
    last_name: overrides.last_name || 'Reyes',
    email: overrides.email || 'alex@example.com',
    job_title: overrides.job_title || 'Support Specialist',
    ...overrides,
  };
}

test('inactiveApplicantReason detects rejected and inactive applicant fields', () => {
  assert.equal(inactiveApplicantReason(applicant({ applicant_progress: 'Rejected' })), 'rejected');
  assert.equal(inactiveApplicantReason(applicant({ status: 'Withdrawn' })), 'withdrawn');
  assert.equal(inactiveApplicantReason(applicant({ disposition: 'Declined' })), 'declined');
  assert.equal(inactiveApplicantReason(applicant({ jobs: { applicant_progress: 'Rejected' } })), 'rejected');
});

test('inactiveApplicantReason keeps active and custom stages', () => {
  for (const stage of ['New', 'Phone Screen', '1st Interview', '2nd Interview', 'Final Interview']) {
    assert.equal(inactiveApplicantReason(applicant({ applicant_progress: stage })), '');
  }
  assert.equal(inactiveApplicantReason(applicant({ workflow_step: 'Hiring Manager Review' })), '');
});

test('inactiveApplicantReason keeps records with missing status fields', () => {
  assert.equal(inactiveApplicantReason(applicant()), '');
});

test('filterActiveApplicants excludes inactive applicants and reports reason counts', () => {
  const result = filterActiveApplicants([
    applicant({ id: '1', applicant_progress: 'New', email: 'new@example.com' }),
    applicant({ id: '2', applicant_progress: 'Rejected', email: 'reject@example.com' }),
    applicant({ id: '3', status: 'Withdrawn', email: 'withdraw@example.com' }),
    applicant({ id: '4', disposition: 'Declined', email: 'decline@example.com' }),
    applicant({ id: '5', jobs: { applicant_progress: 'Rejected' }, email: 'nested@example.com' }),
  ]);

  assert.equal(result.total, 5);
  assert.equal(result.excluded, 4);
  assert.deepEqual(result.applicants.map((item) => item.email), ['new@example.com']);
  assert.deepEqual(result.excludedReasons, [
    { reason: 'rejected', count: 2 },
    { reason: 'declined', count: 1 },
    { reason: 'withdrawn', count: 1 },
  ]);
});

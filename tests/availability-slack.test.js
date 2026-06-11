import test from 'node:test'
import assert from 'node:assert/strict'

import {
  availabilityCheckErrorModal,
  checkingAvailabilityModal,
} from '../src/slack/views.js'

test('availability loading view shows an ongoing request indicator', () => {
  const view = checkingAvailabilityModal({
    applicant: { firstName: 'Test', lastName: 'Candidate' },
  })
  assert.match(JSON.stringify(view.blocks), /hourglass_flowing_sand/)
})

test('availability error view points to Google Calendar access', () => {
  const view = availabilityCheckErrorModal(
    { applicant: { firstName: 'Test', lastName: 'Candidate' } },
    'Could not check calendar availability.'
  )
  assert.equal(view.submit, undefined)
  assert.match(JSON.stringify(view.blocks), /No scheduling slots were shown/)
  assert.match(JSON.stringify(view.blocks), /Google Calendar access/)
})

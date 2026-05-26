import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeRecruiterPhones,
  normalizeRecruiterPhoneRow,
  recruiterPhoneLine,
} from '../src/services/recruiter-phone-export.js'

test('normalizeRecruiterPhoneRow uses exact Apps Script export headers', () => {
  const row = normalizeRecruiterPhoneRow({
    'First Name': 'Christiana',
    'Last Name': 'Dela Cruz',
    'Preferred Name': 'Tin',
    Designation: 'Recruitment Specialist',
    'Aircall ': '+63 900 111 2222',
    'Work Email': 'CHRISTIANA@example.com',
    'Personal Zoom Link': 'https://zoom.us/j/123',
  })

  assert.equal(row.name, 'Tin Dela Cruz')
  assert.equal(row.legalName, 'Christiana Dela Cruz')
  assert.equal(row.email, 'christiana@example.com')
  assert.equal(row.phone, '+63 900 111 2222')
  assert.equal(row.zoomLink, 'https://zoom.us/j/123')
})

test('mergeRecruiterPhones matches by work email first', () => {
  const recruiters = [
    {
      name: 'Different Name',
      email: 'christiana@example.com',
      role: 'recruiter',
    },
  ]
  const merged = mergeRecruiterPhones(recruiters, [
    {
      name: 'Tin Dela Cruz',
      legalName: 'Christiana Dela Cruz',
      email: 'christiana@example.com',
      phone: '+63 900 111 2222',
      zoomLink: 'https://zoom.us/j/from-sheet',
    },
  ])

  assert.equal(merged[0].phone, '+63 900 111 2222')
  assert.equal(merged[0].zoomLink, 'https://zoom.us/j/from-sheet')
})

test('mergeRecruiterPhones falls back to normalized full name', () => {
  const recruiters = [
    {
      name: 'Christiana Dela Cruz',
      email: 'missing@example.com',
      role: 'recruiter',
    },
  ]
  const merged = mergeRecruiterPhones(recruiters, [
    {
      name: 'Tin Dela Cruz',
      legalName: 'Christiana Dela Cruz',
      email: 'christiana@example.com',
      phone: '+63 900 111 2222',
    },
  ])

  assert.equal(merged[0].phone, '+63 900 111 2222')
})

test('recruiterPhoneLine renders exact email format', () => {
  assert.equal(
    recruiterPhoneLine({ name: 'Christiana Dela Cruz', phone: '+63 900 111 2222' }),
    'Christiana Dela Cruz: +63 900 111 2222',
  )
  assert.equal(recruiterPhoneLine({ name: 'Christiana Dela Cruz' }), '')
})

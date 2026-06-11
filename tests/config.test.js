import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('role assignment export reuses recruiter export endpoint credentials by default', () => {
  const config = loadConfig({
    RECRUITER_PHONE_EXPORT_URL: 'https://script.google.com/macros/s/demo/exec',
    RECRUITER_PHONE_EXPORT_TOKEN: 'shared-token',
    ROLE_ASSIGNMENT_EXPORT_URL: '',
    ROLE_ASSIGNMENT_EXPORT_TOKEN: '',
    ROLE_ASSIGNMENT_EXPORT_FILE_ID: 'role-file-id',
    ROLE_ASSIGNMENT_EXPORT_SHEET_GID: '664392081',
  })

  assert.equal(config.roleAssignmentExport.url, 'https://script.google.com/macros/s/demo/exec')
  assert.equal(config.roleAssignmentExport.token, 'shared-token')
  assert.equal(config.roleAssignmentExport.fileId, 'role-file-id')
  assert.equal(config.roleAssignmentExport.sheetGid, '664392081')
  assert.equal(config.hiringManagerAvailability.url, 'https://script.google.com/macros/s/demo/exec')
  assert.equal(config.hiringManagerAvailability.token, 'shared-token')
})

test('hiring manager availability supports dedicated Apps Script credentials', () => {
  const config = loadConfig({
    RECRUITER_PHONE_EXPORT_URL: 'https://script.google.com/macros/s/shared/exec',
    RECRUITER_PHONE_EXPORT_TOKEN: 'shared-token',
    HM_AVAILABILITY_SCRIPT_URL: 'https://script.google.com/macros/s/freebusy/exec',
    HM_AVAILABILITY_SCRIPT_TOKEN: 'freebusy-token',
  })

  assert.equal(config.hiringManagerAvailability.url, 'https://script.google.com/macros/s/freebusy/exec')
  assert.equal(config.hiringManagerAvailability.token, 'freebusy-token')
})

test('hiring manager availability prefers the role assignment deployment fallback', () => {
  const config = loadConfig({
    RECRUITER_PHONE_EXPORT_URL: 'https://script.google.com/macros/s/recruiter/exec',
    RECRUITER_PHONE_EXPORT_TOKEN: 'recruiter-token',
    ROLE_ASSIGNMENT_EXPORT_URL: 'https://script.google.com/macros/s/role/exec',
    ROLE_ASSIGNMENT_EXPORT_TOKEN: 'role-token',
  })

  assert.equal(config.hiringManagerAvailability.url, 'https://script.google.com/macros/s/role/exec')
  assert.equal(config.hiringManagerAvailability.token, 'role-token')
})

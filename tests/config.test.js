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
})

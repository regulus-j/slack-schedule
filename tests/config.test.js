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

test('automated notification configuration uses safe defaults and explicit overrides', () => {
  const defaults = loadConfig({})
  assert.equal(defaults.notifications.enabled, false)
  assert.equal(defaults.notifications.pollIntervalMs, 60000)
  assert.equal(defaults.notifications.resumeAttachmentMaxBytes, 15728640)

  const configured = loadConfig({
    AUTOMATED_NOTIFICATIONS_ENABLED: 'true',
    NOTIFICATION_POLL_INTERVAL_MS: '5000',
    FEEDBACK_FORM_URL: 'https://example.com/feedback',
    RESUME_ATTACHMENT_MAX_BYTES: '1024',
  })
  assert.equal(configured.notifications.enabled, true)
  assert.equal(configured.notifications.pollIntervalMs, 5000)
  assert.equal(configured.notifications.feedbackFormUrl, 'https://example.com/feedback')
  assert.equal(configured.notifications.resumeAttachmentMaxBytes, 1024)
})

test('email test mode defaults off and supports a safe test recipient', () => {
  const defaults = loadConfig({
    EMAIL_TEST_MODE: '',
    EMAIL_TEST_RECIPIENT: '',
  })
  assert.equal(defaults.email.testMode, false)
  assert.equal(defaults.email.testRecipient, 'jamalalbadi03@gmail.com')

  const configured = loadConfig({
    EMAIL_TEST_MODE: 'true',
    EMAIL_TEST_RECIPIENT: ' test-recipient@example.com ',
  })
  assert.equal(configured.email.testMode, true)
  assert.equal(configured.email.testRecipient, 'test-recipient@example.com')

  const fallbackRecipient = loadConfig({
    EMAIL_TEST_MODE: 'true',
    EMAIL_TEST_RECIPIENT: '',
  })
  assert.equal(fallbackRecipient.email.testRecipient, 'jamalalbadi03@gmail.com')
})

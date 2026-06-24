import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, validateStartupConfig } from '../src/config.js'

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

test('email test mode defaults off and requires an explicit test recipient', () => {
  const defaults = loadConfig({
    EMAIL_TEST_MODE: '',
    EMAIL_TEST_RECIPIENT: '',
  })
  assert.equal(defaults.email.testMode, false)
  assert.equal(defaults.email.testRecipient, '')

  const configured = loadConfig({
    EMAIL_TEST_MODE: 'true',
    EMAIL_TEST_RECIPIENT: ' test-recipient@example.com ',
  })
  assert.equal(configured.email.testMode, true)
  assert.equal(configured.email.testRecipient, 'test-recipient@example.com')

})

test('security configuration parses Slack user allow-lists and secret file paths', async () => {
  const config = loadConfig({
    SLACK_RECRUITMENT_USER_IDS: 'UONE, UTWO UONE invalid',
    SLACK_ADMIN_USER_IDS: 'UADMIN',
    SLACK_ALERT_USER_IDS: 'UALERT',
    ACCESS_CONTROL_ENFORCED: 'true',
  })
  assert.deepEqual(config.security.recruitmentUserIds, ['UONE', 'UTWO'])
  assert.deepEqual(config.security.adminUserIds, ['UADMIN'])
  assert.deepEqual(config.security.alertUserIds, ['UALERT'])
  assert.equal(config.security.accessControlEnforced, true)
})

test('production validation requires Cloud SQL, KMS, and access-control lists', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SLACK_BOT_TOKEN: 'bot',
    SLACK_APP_TOKEN: 'app',
    JAZZHR_API_KEY: 'jazz',
    ACCESS_CONTROL_ENFORCED: 'true',
  })
  assert.throws(
    () => validateStartupConfig(config),
    /SLACK_RECRUITMENT_USER_IDS.*SLACK_ADMIN_USER_IDS.*SLACK_ALERT_USER_IDS.*DATABASE_BACKEND=cloudsql/,
  )
})

test('google redirectUri falls back to PUBLIC_BASE_URL when GOOGLE_REDIRECT_URI is unset', () => {
  const withExplicit = loadConfig({
    GOOGLE_REDIRECT_URI: 'https://example.com/custom/callback',
    PUBLIC_BASE_URL: 'https://app.example.com',
  })
  assert.equal(withExplicit.google.redirectUri, 'https://example.com/custom/callback')

  const withoutExplicit = loadConfig({
    PUBLIC_BASE_URL: 'https://app.example.com',
  })
  assert.equal(withoutExplicit.google.redirectUri, 'https://app.example.com/oauth/google/callback')

  const fallbackLocalhost = loadConfig({
    PORT: '4000',
  })
  assert.equal(fallbackLocalhost.google.redirectUri, 'http://localhost:4000/oauth/google/callback')
})

test('google redirectUri strips trailing slashes from PUBLIC_BASE_URL', () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://app.example.com/',
  })
  assert.equal(config.google.redirectUri, 'https://app.example.com/oauth/google/callback')
})

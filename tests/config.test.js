import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, normalizeJazzhrAccountKey, resolveGoogleAccountId, validateStartupConfig } from '../src/config.js'

test('Google account routing parses and normalizes JazzHR account keys', () => {
  const config = loadConfig({
    GOOGLE_ACCOUNT_BY_JAZZHR_ACCOUNT: '{"DEFAULT":"shared@example.com"," Offshore ":"offshore@example.com","invalid": ""}',
  })

  assert.deepEqual(config.google.accountByJazzhrAccount, {
    default: 'shared@example.com',
    offshore: 'offshore@example.com',
  })
  assert.equal(resolveGoogleAccountId(config, 'OFFSHORE'), 'offshore@example.com')
  assert.equal(resolveGoogleAccountId(config, 'unknown'), null)
  assert.equal(normalizeJazzhrAccountKey('  OFFSHORE '), 'offshore')
  assert.equal(normalizeJazzhrAccountKey(''), 'default')
})

test('Google account routing falls back to the shared OAuth owner', () => {
  const config = loadConfig({
    GOOGLE_AUTH_SLACK_USER_ID: 'U-SHARED',
  })

  assert.equal(resolveGoogleAccountId(config, 'default'), 'U-SHARED')
  assert.equal(resolveGoogleAccountId(config, 'unmapped-account'), 'U-SHARED')
})

test('invalid Google account routing JSON fails closed', () => {
  const config = loadConfig({ GOOGLE_ACCOUNT_BY_JAZZHR_ACCOUNT: '{not-json' })
  assert.deepEqual(config.google.accountByJazzhrAccount, {})
  assert.equal(resolveGoogleAccountId(config, 'default'), null)
})

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

test('production validation requires PostgreSQL, KMS, and access-control lists', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SLACK_BOT_TOKEN: 'bot',
    SLACK_APP_TOKEN: 'app',
    JAZZHR_API_KEY: 'jazz',
    ACCESS_CONTROL_ENFORCED: 'true',
  })
  assert.throws(
    () => validateStartupConfig(config),
    /SLACK_RECRUITMENT_USER_IDS.*SLACK_ADMIN_USER_IDS.*SLACK_ALERT_USER_IDS.*DATABASE_BACKEND=postgres/,
  )
})

test('production PostgreSQL validation accepts a database URL', () => {
  const config = loadConfig({
    NODE_ENV: 'production', DATABASE_BACKEND: 'postgres', DATABASE_URL: 'postgresql://app@10.0.0.2/scheduler',
    SLACK_BOT_TOKEN: 'bot', SLACK_APP_TOKEN: 'app', JAZZHR_API_KEY: 'jazz',
    GOOGLE_KMS_KEY_NAME: 'projects/p/locations/a/keyRings/r/cryptoKeys/k',
    SLACK_RECRUITMENT_USER_IDS: 'U1', SLACK_ADMIN_USER_IDS: 'U2', SLACK_ALERT_USER_IDS: 'U3',
  })
  assert.doesNotThrow(() => validateStartupConfig(config))
})

test('production Google validation requires the shared OAuth owner', () => {
  const config = loadConfig({
    NODE_ENV: 'production', DATABASE_BACKEND: 'postgres', DATABASE_URL: 'postgresql://app@10.0.0.2/scheduler',
    SLACK_BOT_TOKEN: 'bot', SLACK_APP_TOKEN: 'app', JAZZHR_API_KEY: 'jazz',
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_SHARED_CALENDAR_ID: 'primary',
    GOOGLE_KMS_KEY_NAME: 'projects/p/locations/a/keyRings/r/cryptoKeys/k',
    SLACK_RECRUITMENT_USER_IDS: 'U1', SLACK_ADMIN_USER_IDS: 'U2', SLACK_ALERT_USER_IDS: 'U3',
  })
  assert.throws(() => validateStartupConfig(config), /GOOGLE_AUTH_SLACK_USER_ID/)
})

test('OAuth callback validation does not require Socket Mode or JazzHR configuration', () => {
  const config = loadConfig({
    NODE_ENV: 'production', DATABASE_BACKEND: 'postgres', DATABASE_URL: 'postgresql://app@10.0.0.2/scheduler',
    SLACK_BOT_TOKEN: 'bot', GOOGLE_KMS_KEY_NAME: 'projects/p/locations/a/keyRings/r/cryptoKeys/k',
  })
  assert.doesNotThrow(() => validateStartupConfig(config, { role: 'oauth-callback' }))
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

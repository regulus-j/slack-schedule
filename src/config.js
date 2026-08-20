import path from 'node:path';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  OPERATING_WINDOW_END,
  OPERATING_WINDOW_START,
  SYDNEY_TIME_ZONE,
} from './time.js'

const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), 'data', 'runtime');
const DEFAULT_TIME_ZONES = [
  'Australia/Sydney',
  'Asia/Manila',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
];
export function loadConfig(env = process.env) {
  const value = (name) => secretValue(env, name)
  const nodeEnv = value('NODE_ENV') || 'development'
  const port = Number(value('PORT') || 3000)
  const publicBaseUrl = cleanString(value('PUBLIC_BASE_URL')).replace(/\/+$/, '')
  const googleRedirectUri = value('GOOGLE_REDIRECT_URI') || buildDefaultGoogleRedirectUri(publicBaseUrl, port)
  return {
    env: nodeEnv,
    port,
    publicBaseUrl,
    runtimeDir: value('RUNTIME_DIR') || DEFAULT_RUNTIME_DIR,
    databaseUrl: value('DATABASE_URL'),
    database: {
      backend: value('DATABASE_BACKEND') || (value('CLOUD_SQL_INSTANCE') ? 'cloudsql' : (value('DATABASE_URL') ? 'postgres' : 'json')),
      instanceConnectionName: cleanString(value('CLOUD_SQL_INSTANCE')),
      name: cleanString(value('CLOUD_SQL_DATABASE')),
      user: cleanString(value('CLOUD_SQL_IAM_USER')),
      ipType: cleanString(value('CLOUD_SQL_IP_TYPE')) || 'PRIVATE',
      maxConnections: positiveInteger(value('DATABASE_MAX_CONNECTIONS'), 5),
      sslMode: value('DATABASE_SSL_MODE') || 'require',
    },
    slack: {
      botToken: value('SLACK_BOT_TOKEN'),
      appToken: value('SLACK_APP_TOKEN'),
      postingChannelId: value('SLACK_POSTING_CHANNEL_ID') || null,
      teamId: value('SLACK_TEAM_ID') || null,
    },
    jazzhr: {
      accounts: buildJazzhrAccounts(env, value),
      get isMultiAccount() { return this.accounts.length > 1 },
      applicantMaxPages: positiveInteger(value('JAZZHR_APPLICANT_MAX_PAGES'), 500),
      applicantFetchConcurrency: positiveInteger(value('JAZZHR_APPLICANT_FETCH_CONCURRENCY'), 2),
      refreshOnStartup: parseBoolean(value('JAZZHR_REFRESH_ON_STARTUP'), false),
      liveSearch: {
        pageSize: positiveInteger(value('JAZZHR_LIVE_SEARCH_RESULT_PAGE_SIZE'), 20),
        concurrency: positiveInteger(value('JAZZHR_LIVE_SEARCH_CONCURRENCY'), 2),
        maxPages: positiveInteger(value('JAZZHR_LIVE_SEARCH_MAX_PAGES'), 10),
        sessionTtlMs: positiveInteger(value('JAZZHR_LIVE_SEARCH_SESSION_TTL_MS'), 900000),
      },
    },
    google: {
      clientId: value('GOOGLE_CLIENT_ID'),
      clientSecret: value('GOOGLE_CLIENT_SECRET'),
      redirectUri: googleRedirectUri,
      sharedCalendarId: value('GOOGLE_SHARED_CALENDAR_ID'),
      authSlackUserId: value('GOOGLE_AUTH_SLACK_USER_ID') || '',
      accountByJazzhrAccount: parseGoogleAccountMap(value('GOOGLE_ACCOUNT_BY_JAZZHR_ACCOUNT')),
    },
    email: {
      testMode: parseBoolean(value('EMAIL_TEST_MODE'), false),
      testRecipient: cleanString(value('EMAIL_TEST_RECIPIENT')),
    },
    recruiterPhoneExport: {
      url: value('RECRUITER_PHONE_EXPORT_URL') || null,
      token: value('RECRUITER_PHONE_EXPORT_TOKEN') || null,
      fileId: value('RECRUITER_PHONE_EXPORT_FILE_ID') || null,
      sheetName: value('RECRUITER_PHONE_EXPORT_SHEET_NAME') || null,
    },
    roleAssignmentExport: {
      url: value('ROLE_ASSIGNMENT_EXPORT_URL') || value('RECRUITER_PHONE_EXPORT_URL') || null,
      token: value('ROLE_ASSIGNMENT_EXPORT_TOKEN') || value('RECRUITER_PHONE_EXPORT_TOKEN') || null,
      fileId: value('ROLE_ASSIGNMENT_EXPORT_FILE_ID') || null,
      sheetName: value('ROLE_ASSIGNMENT_EXPORT_SHEET_NAME') || null,
      sheetGid: value('ROLE_ASSIGNMENT_EXPORT_SHEET_GID') || null,
    },
    security: {
      encryptionKey: value('APP_ENCRYPTION_KEY'),
      kmsKeyName: cleanString(value('GOOGLE_KMS_KEY_NAME')),
      recruitmentUserIds: parseSlackUserIds(value('SLACK_RECRUITMENT_USER_IDS')),
      adminUserIds: parseSlackUserIds(value('SLACK_ADMIN_USER_IDS')),
      alertUserIds: parseSlackUserIds(value('SLACK_ALERT_USER_IDS')),
      accessControlEnforced: parseBoolean(value('ACCESS_CONTROL_ENFORCED'), nodeEnv === 'production'),
    },
    scheduling: {
      timeZones: resolveTimeZoneList(value('SCHEDULING_TIME_ZONES')),
    },
    operatingWindow: {
      timeZone: SYDNEY_TIME_ZONE,
      startTime: OPERATING_WINDOW_START,
      endTime: OPERATING_WINDOW_END,
    },
    notifications: {
      enabled: parseBoolean(value('AUTOMATED_NOTIFICATIONS_ENABLED'), false),
      pollIntervalMs: positiveInteger(value('NOTIFICATION_POLL_INTERVAL_MS'), 60000),
      feedbackFormUrl: value('FEEDBACK_FORM_URL') || '',
      resumeAttachmentMaxBytes: positiveInteger(
        value('RESUME_ATTACHMENT_MAX_BYTES'),
        15 * 1024 * 1024,
      ),
    },
    alerting: {
      warningThreshold: positiveInteger(value('ALERT_WARNING_THRESHOLD'), 3),
      warningWindowMs: positiveInteger(value('ALERT_WARNING_WINDOW_MS'), 5 * 60 * 1000),
      cooldownMs: positiveInteger(value('ALERT_COOLDOWN_MS'), 15 * 60 * 1000),
    },
    retention: {
      completedCaseDays: positiveInteger(value('RETENTION_COMPLETED_CASE_DAYS'), 365),
      candidateCacheDays: positiveInteger(value('RETENTION_CANDIDATE_CACHE_DAYS'), 30),
      googleTokenInactiveDays: positiveInteger(value('RETENTION_GOOGLE_TOKEN_INACTIVE_DAYS'), 90),
      oauthStateCleanupHours: positiveInteger(value('RETENTION_OAUTH_STATE_HOURS'), 24),
    },
  };
}

function secretValue(env, name) {
  const filePath = cleanString(env?.[`${name}_FILE`])
  if (filePath) return readFileSync(filePath, 'utf8').trim()
  return env?.[name]
}

function buildJazzhrAccounts(env, value) {
  const accountKeysRaw = value('JAZZHR_ACCOUNT_KEYS')
  if (accountKeysRaw) {
    const keys = String(accountKeysRaw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    return keys.map((key) => ({
      key,
      apiKey: value(`JAZZHR_API_KEY_${key.toUpperCase()}`) || '',
      displayName: value(`JAZZHR_COMPANY_NAME_${key.toUpperCase()}`) || key.toUpperCase(),
    }))
  }
  // Legacy single-account mode
  const apiKey = value('JAZZHR_API_KEY')
  if (apiKey) {
    return [{ key: 'default', apiKey, displayName: 'OPG' }]
  }
  return []
}

function resolveTimeZoneList(value) {
  if (!value) return DEFAULT_TIME_ZONES;
  const list = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_TIME_ZONES;
}

function cleanString(value) {
  return String(value || '').trim()
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function parseGoogleAccountMap(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(String(value))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, accountId]) => [normalizeAccountKey(key), cleanString(accountId)])
        .filter(([key, accountId]) => key && accountId),
    )
  } catch {
    return {}
  }
}

export function normalizeJazzhrAccountKey(value) {
  return cleanString(value).toLowerCase() || 'default'
}

export function resolveGoogleAccountId(config, accountKey = 'default') {
  const mapping = config?.google?.accountByJazzhrAccount || {}
  return mapping[normalizeJazzhrAccountKey(accountKey)] || cleanString(config?.google?.authSlackUserId) || null
}

function normalizeAccountKey(value) {
  return cleanString(value).toLowerCase()
}

export function validateStartupConfig(config, { role = 'app' } = {}) {
  const missing = [];
  const isOAuthCallback = role === 'oauth-callback';

  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!isOAuthCallback && !config.slack.appToken) missing.push('SLACK_APP_TOKEN');
  if (!isOAuthCallback) {
    if (config.jazzhr.accounts.length === 0) {
      missing.push('JAZZHR_API_KEY (or JAZZHR_ACCOUNT_KEYS + JAZZHR_API_KEY_*)');
    } else {
      for (const account of config.jazzhr.accounts) {
        if (!account.apiKey) {
          const suffix = account.key === 'default' ? 'JAZZHR_API_KEY' : `JAZZHR_API_KEY_${account.key.toUpperCase()}`
          missing.push(suffix)
        }
      }
    }
    if (config.notifications?.enabled && !config.notifications.feedbackFormUrl) {
      missing.push('FEEDBACK_FORM_URL')
    }
    if (config.email?.testMode && !config.email.testRecipient) {
      missing.push('EMAIL_TEST_RECIPIENT')
    }
  }
  if (!isOAuthCallback && config.env === 'production' && config.security?.accessControlEnforced) {
    if (config.security.recruitmentUserIds.length === 0) missing.push('SLACK_RECRUITMENT_USER_IDS')
    if (config.security.adminUserIds.length === 0) missing.push('SLACK_ADMIN_USER_IDS')
    if (config.security.alertUserIds.length === 0) missing.push('SLACK_ALERT_USER_IDS')
  }
  if (config.database?.backend === 'cloudsql') {
    if (!config.database.instanceConnectionName) missing.push('CLOUD_SQL_INSTANCE')
    if (!config.database.name) missing.push('CLOUD_SQL_DATABASE')
    if (!config.database.user) missing.push('CLOUD_SQL_IAM_USER')
    if (!config.security?.kmsKeyName) missing.push('GOOGLE_KMS_KEY_NAME')
  }
  if (config.env === 'production' && !['cloudsql', 'postgres'].includes(config.database?.backend)) {
    missing.push('DATABASE_BACKEND=postgres')
  }
  if (config.env === 'production' && config.database?.backend === 'postgres' && !config.databaseUrl) {
    missing.push('DATABASE_URL')
  }
  if (
    config.env === 'production' &&
    config.google?.clientId &&
    config.google?.clientSecret &&
    config.google?.sharedCalendarId &&
    !isOAuthCallback &&
    !config.google?.authSlackUserId
  ) {
    missing.push('GOOGLE_AUTH_SLACK_USER_ID')
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function parseSlackUserIds(value) {
  return [...new Set(
    String(value || '')
      .split(/[\s,]+/)
      .map((item) => item.trim().toUpperCase())
      .filter((item) => /^U[A-Z0-9]+$/.test(item)),
  )]
}

function buildDefaultGoogleRedirectUri(publicBaseUrl, port) {
  const base = publicBaseUrl || `http://localhost:${port}`
  return `${base.replace(/\/+$/, '')}/oauth/google/callback`
}

export function googleRedirectUriDerived(config) {
  return !config.google.redirectUri || config.google.redirectUri === buildDefaultGoogleRedirectUri(config.publicBaseUrl, config.port)
}

export function googleReady(config) {
  return Boolean(
    config?.google?.clientId &&
      config?.google?.clientSecret &&
      config?.google?.redirectUri &&
      config?.google?.sharedCalendarId,
  );
}

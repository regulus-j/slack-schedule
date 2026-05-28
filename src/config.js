import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), 'data', 'runtime');
const DEFAULT_TIME_ZONES = [
  'Australia/Sydney',
  'Asia/Manila',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
];

export function loadConfig(env = process.env) {
  const mergedEnv = { ...loadLocalEnvFile(), ...env };
  return {
    env: mergedEnv.NODE_ENV || 'development',
    port: Number(mergedEnv.PORT || 3000),
    runtimeDir: mergedEnv.RUNTIME_DIR || DEFAULT_RUNTIME_DIR,
    databaseUrl: mergedEnv.DATABASE_URL,
    slack: {
      botToken: mergedEnv.SLACK_BOT_TOKEN,
      appToken: mergedEnv.SLACK_APP_TOKEN,
      postingChannelId: mergedEnv.SLACK_POSTING_CHANNEL_ID || null,
    },
    jazzhr: {
      apiKey: mergedEnv.JAZZHR_API_KEY,
    },
    google: {
      clientId: mergedEnv.GOOGLE_CLIENT_ID,
      clientSecret: mergedEnv.GOOGLE_CLIENT_SECRET,
      redirectUri: mergedEnv.GOOGLE_REDIRECT_URI,
      sharedCalendarId: mergedEnv.GOOGLE_SHARED_CALENDAR_ID,
      authSlackUserId: mergedEnv.GOOGLE_AUTH_SLACK_USER_ID || '',
    },
    recruiterPhoneExport: {
      url: mergedEnv.RECRUITER_PHONE_EXPORT_URL || null,
      token: mergedEnv.RECRUITER_PHONE_EXPORT_TOKEN || null,
    },
    security: {
      encryptionKey: mergedEnv.APP_ENCRYPTION_KEY,
    },
    scheduling: {
      timeZones: resolveTimeZoneList(mergedEnv.SCHEDULING_TIME_ZONES),
    },
  };
}

function loadLocalEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) return {};

  return readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .reduce((acc, line) => {
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      acc[key] = value;
      return acc;
    }, {});
}

function resolveTimeZoneList(value) {
  if (!value) return DEFAULT_TIME_ZONES;
  const list = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_TIME_ZONES;
}

export function validateStartupConfig(config) {
  const missing = [];

  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.slack.appToken) missing.push('SLACK_APP_TOKEN');
  if (!config.jazzhr.apiKey) missing.push('JAZZHR_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing required Slack environment variables: ${missing.join(', ')}`);
  }
}

export function googleReady(config) {
  return Boolean(
    config.google.clientId &&
      config.google.clientSecret &&
      config.google.redirectUri &&
      config.google.sharedCalendarId,
  );
}

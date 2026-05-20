import { googleReady } from '../config.js';
import { buildCalendarEventDraft } from '../time.js';
import { logoAttachment } from '../signature.js';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';

export function buildGoogleOAuthUrl(config, state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.google.clientId || '');
  url.searchParams.set('redirect_uri', config.google.redirectUri || '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set(
    'scope',
    [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/gmail.send',
    ].join(' '),
  );
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeGoogleOAuthCode({ config, code }) {
  if (!googleReady(config)) {
    throw new Error('Google OAuth is not configured');
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google OAuth token exchange failed');
  }

  return normalizeTokenPayload(payload);
}

export async function checkFreeBusy({ config, logger, attendees, windows, store, recruiterId }) {
  if (!googleReady(config)) {
    logger.warn('calendar_freebusy_mocked', { attendeeCount: attendees.length, windowCount: windows.length });
    return { mocked: true, busy: [] };
  }

  const accessToken = await resolveAccessToken({ config, store, recruiterId });
  if (!accessToken) {
    logger.warn('calendar_freebusy_skipped', { reason: 'missing_google_token', recruiterId });
    return { mocked: true, busy: [] };
  }

  const response = await fetch(`${GOOGLE_CALENDAR_BASE_URL}/freeBusy`, {
    method: 'POST',
    headers: buildAuthHeaders(accessToken),
    body: JSON.stringify({
      timeMin: windows[0]?.timeMin || windows[0]?.start || new Date().toISOString(),
      timeMax: windows[0]?.timeMax || windows[0]?.end || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      items: attendees.map((attendee) => ({
        id: typeof attendee === 'string' ? attendee : attendee.id,
      })),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || 'Google free/busy request failed');
  }

  return { mocked: false, busy: payload.calendars || {} };
}

export async function createCalendarEvent({ config, logger, caseRecord, eventInput, store }) {
  const eventDraft = buildCalendarEventDraft(eventInput);
  if (!googleReady(config)) {
    logger.warn('calendar_event_mocked', { caseId: caseRecord.id });
    return { mocked: true, eventId: `mock-${caseRecord.id}`, eventDraft };
  }

  const recruiterId = getRecruiterId(caseRecord);
  const accessToken = await resolveAccessToken({ config, store, recruiterId });
  if (!accessToken) {
    logger.warn('calendar_event_skipped', { caseId: caseRecord.id, reason: 'missing_google_token' });
    return { mocked: true, eventId: `pending-google-${caseRecord.id}`, eventDraft };
  }

  const response = await fetch(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(config.google.sharedCalendarId)}/events`, {
    method: 'POST',
    headers: buildAuthHeaders(accessToken),
    body: JSON.stringify({
      ...eventDraft,
      sendUpdates: 'all',
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || 'Google Calendar event creation failed');
  }

  return { mocked: false, eventId: payload.id, eventDraft, googleEvent: payload };
}

export async function updateCalendarEvent({ config, logger, caseRecord, eventInput, store }) {
  const eventDraft = buildCalendarEventDraft(eventInput);
  const eventId = caseRecord.calendarEventId || eventInput.eventId;

  if (!eventId) {
    return createCalendarEvent({ config, logger, caseRecord, eventInput, store });
  }

  if (!googleReady(config)) {
    logger.warn('calendar_event_update_mocked', { caseId: caseRecord.id, eventId });
    return { mocked: true, eventId, eventDraft };
  }

  const recruiterId = getRecruiterId(caseRecord);
  const accessToken = await resolveAccessToken({ config, store, recruiterId });
  if (!accessToken) {
    logger.warn('calendar_event_update_skipped', { caseId: caseRecord.id, eventId, reason: 'missing_google_token' });
    return { mocked: true, eventId: `pending-google-${caseRecord.id}`, eventDraft };
  }

  const response = await fetch(
    `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(config.google.sharedCalendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: buildAuthHeaders(accessToken),
      body: JSON.stringify({
        ...eventDraft,
        sendUpdates: 'all',
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || 'Google Calendar event update failed');
  }

  return { mocked: false, eventId: payload.id || eventId, eventDraft, googleEvent: payload };
}

export async function sendRecruiterEmail({ config, logger, caseRecord, email, store }) {
  if (!googleReady(config)) {
    logger.warn('gmail_send_mocked', { caseId: caseRecord.id });
    return { mocked: true, messageId: `mock-email-${caseRecord.id}`, email };
  }

  const recruiterId = getRecruiterId(caseRecord);
  const accessToken = await resolveAccessToken({ config, store, recruiterId });
  if (!accessToken) {
    logger.warn('gmail_send_skipped', { caseId: caseRecord.id, reason: 'missing_google_token' });
    return { mocked: true, messageId: `pending-gmail-${caseRecord.id}`, email };
  }

  const raw = buildGmailRawMessage(email);
  const response = await fetch(`${GOOGLE_GMAIL_BASE_URL}/users/me/messages/send`, {
    method: 'POST',
    headers: buildAuthHeaders(accessToken),
    body: JSON.stringify({ raw }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || 'Gmail send failed');
  }

  return { mocked: false, messageId: payload.id, email };
}

async function resolveAccessToken({ config, store, recruiterId }) {
  if (!store || !recruiterId) return null;
  const tokenData = await store.getGoogleToken(recruiterId);
  if (!tokenData) return null;

  if (!tokenData.expiry_date || Date.now() < tokenData.expiry_date - 60 * 1000) {
    return tokenData.access_token;
  }

  if (!tokenData.refresh_token) return tokenData.access_token || null;

  const refreshed = await refreshGoogleToken({ config, refreshToken: tokenData.refresh_token });
  const merged = {
    ...tokenData,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokenData.refresh_token,
    expiry_date: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
  };
  await store.saveGoogleToken(recruiterId, merged);
  return merged.access_token;
}

async function refreshGoogleToken({ config, refreshToken }) {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google token refresh failed');
  }

  return normalizeTokenPayload(payload);
}

function normalizeTokenPayload(payload) {
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: payload.expires_in,
    expiry_date: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : undefined,
    scope: payload.scope,
    token_type: payload.token_type,
  };
}

function buildAuthHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

function buildGmailRawMessage(email) {
  const htmlBody = email.htmlBody || email.body || ''
  const plainBody = email.plainBody || stripHtml(htmlBody)
  const logo = logoAttachment()
  const hasLogo = logo && htmlBody.includes('cid:opg-logo')

  const subject = email.subject || ''
  const to = email.to || ''
  const from = email.from || ''

  const mixedBoundary = `mixed-${crypto.randomUUID()}`
  const altBoundary = `alt-${crypto.randomUUID()}`

  const headers = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ]

  const altPart = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    plainBody,
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    htmlBody,
    '',
    `--${altBoundary}--`,
  ]

  const parts = [headers.join('\r\n'), '', altPart.join('\r\n')]

  if (hasLogo && logo) {
    parts.push('', `--${mixedBoundary}`, logo.mimePart, '', `--${mixedBoundary}--`)
  } else {
    parts.push('', `--${mixedBoundary}--`)
  }

  return Buffer.from(parts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function getRecruiterId(caseRecord) {
  return caseRecord.ownerSlackUserId || caseRecord.recruiter?.slackUserId || caseRecord.recruiter?.id || null;
}

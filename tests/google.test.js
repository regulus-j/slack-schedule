import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailRawMessage, buildGoogleOAuthUrl, checkFreeBusy, getRecruiterId } from '../src/services/google.js';
import { homeView } from '../src/slack/views.js';

test('builds a recruiter-scoped google oauth url', () => {
  const url = buildGoogleOAuthUrl(
    {
      google: {
        clientId: 'client-id',
        redirectUri: 'https://example.com/oauth/google/callback',
      },
    },
    JSON.stringify({ recruiterId: 'U123', source: 'slack_home' }),
  );

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_id'), 'client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://example.com/oauth/google/callback');
  assert.equal(parsed.searchParams.get('state'), JSON.stringify({ recruiterId: 'U123', source: 'slack_home' }));
  assert.match(parsed.searchParams.get('scope') || '', /calendar\.events/);
  assert.match(parsed.searchParams.get('scope') || '', /gmail\.send/);
});

test('home view includes a connect google action', () => {
  const view = homeView({ myCases: [], teamCases: [] });
  const actionButtons = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button');

  assert.ok(actionButtons.some((button) => button.action_id === 'open_google_oauth'));
});

test('home view shows when google is not connected', () => {
  const view = homeView({ myCases: [], teamCases: [], googleConnected: false });
  assert.ok(view.blocks.some((block) => block.type === 'section' && block.text?.text?.includes('Google is not connected yet')));
});

test('prefers the case owner slack id for google token lookup', () => {
  assert.equal(
    getRecruiterId({
      ownerSlackUserId: 'U-owner',
      recruiter: { id: 'rec-jam', slackUserId: 'U-recruiter' },
    }),
    'U-owner',
  );
});

test('checkFreeBusy sends explicit timeMin and timeMax windows', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { calendars: {} };
      },
    };
  };

  try {
    const result = await checkFreeBusy({
      config: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://example.com/oauth',
          sharedCalendarId: 'primary',
        },
      },
      logger: { warn() {} },
      attendees: [{ id: 'alex@example.com' }],
      windows: [{
        timeMin: '2026-06-01T00:00:00.000Z',
        timeMax: '2026-06-02T00:00:00.000Z',
      }],
      recruiterId: 'U123',
      store: {
        async getGoogleToken() {
          return { access_token: 'token' };
        },
      },
    });

    assert.equal(result.mocked, false);
    assert.equal(requestBody.timeMin, '2026-06-01T00:00:00.000Z');
    assert.equal(requestBody.timeMax, '2026-06-02T00:00:00.000Z');
    assert.deepEqual(requestBody.items, [{ id: 'alex@example.com' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildGmailRawMessage includes cc recipients', () => {
  const raw = buildGmailRawMessage({
    to: 'candidate@example.com',
    cc: ['interviewer@example.com', 'hm@example.com'],
    from: 'recruiter@example.com',
    subject: 'Interview',
    body: '<p>Hello</p>',
    plainBody: 'Hello',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  assert.match(decoded, /^To: candidate@example\.com/m);
  assert.match(decoded, /^Cc: interviewer@example\.com, hm@example\.com/m);
  assert.match(decoded, /^From: recruiter@example\.com/m);
});

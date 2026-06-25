import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGmailRawMessage,
  buildGoogleOAuthUrl,
  checkFreeBusy,
  createCalendarEvent,
  getGoogleTokenOwner,
  getRecruiterId,
  sendRecruiterEmail,
  updateCalendarEvent,
} from '../src/services/google.js';
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

test('home view includes a disconnect google action when connected', () => {
  const view = homeView({ myCases: [], teamCases: [], googleConnected: true });
  const actionButtons = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button');

  assert.ok(actionButtons.some((button) => button.action_id === 'disconnect_google_oauth'));
  assert.ok(!actionButtons.some((button) => button.action_id === 'open_google_oauth'));
});

test('home view keeps connect google action when disconnected', () => {
  const view = homeView({ myCases: [], teamCases: [], googleConnected: false });
  const actionButtons = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button');

  assert.ok(actionButtons.some((button) => button.action_id === 'open_google_oauth'));
  assert.ok(!actionButtons.some((button) => button.action_id === 'disconnect_google_oauth'));
});

test('home view hides google connect action for shared connected account users', () => {
  const view = homeView({ myCases: [], teamCases: [], googleConnected: true, googleShared: true, googleCanManage: false });
  const actionButtons = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button');

  assert.ok(!actionButtons.some((button) => button.action_id === 'open_google_oauth'));
  assert.ok(!actionButtons.some((button) => button.action_id === 'disconnect_google_oauth'));
  assert.ok(view.blocks.some((block) => block.type === 'section' && block.text?.text?.includes('shared scheduling account')));
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

test('shared google token owner overrides case owner token lookup', () => {
  assert.equal(getGoogleTokenOwner({ google: { authSlackUserId: 'U-shared' } }, 'U-owner'), 'U-shared');
  assert.equal(getGoogleTokenOwner({ google: {} }, 'U-owner'), 'U-owner');
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
          authSlackUserId: 'U-shared',
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
        async getGoogleToken(recruiterId) {
          assert.equal(recruiterId, 'U-shared');
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

test('createCalendarEvent explains missing shared calendar access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() {
      return { error: { message: 'Not Found' } };
    },
  });

  try {
    await assert.rejects(
      createCalendarEvent({
        config: {
          google: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            redirectUri: 'https://example.com/oauth',
            sharedCalendarId: 'bad-calendar@example.com',
          },
        },
        logger: { warn() {} },
        caseRecord: { id: 'case-1', ownerSlackUserId: 'U123' },
        eventInput: {
          candidateName: 'Alex Reyes',
          jobTitle: 'Support Specialist',
          startDate: '2026-06-01',
          startTime: '09:00',
          durationMinutes: 30,
          attendees: ['alex@example.com'],
          timeZone: 'Asia/Manila',
        },
        store: {
          async getGoogleToken() {
            return { access_token: 'token' };
          },
        },
      }),
      /Calendar ID "bad-calendar@example\.com" was not found or is not shared/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createCalendarEvent uses sendUpdates all normally and none in email test mode', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        return { id: `event-${requestBodies.length}` };
      },
    };
  };

  const baseArgs = {
    logger: { warn() {} },
    caseRecord: { id: 'case-1', ownerSlackUserId: 'U123' },
    eventInput: {
      candidateName: 'Alex Reyes',
      jobTitle: 'Support Specialist',
      startDate: '2026-06-01',
      startTime: '09:00',
      durationMinutes: 30,
      attendees: ['alex@example.com'],
      timeZone: 'Asia/Manila',
    },
    store: {
      async getGoogleToken() {
        return { access_token: 'token' };
      },
    },
  };
  const baseConfig = {
    google: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/oauth',
      sharedCalendarId: 'primary',
    },
  };

  try {
    await createCalendarEvent({
      ...baseArgs,
      config: { ...baseConfig, email: { testMode: false } },
    });
    await createCalendarEvent({
      ...baseArgs,
      config: { ...baseConfig, email: { testMode: true } },
    });

    assert.equal(requestBodies[0].sendUpdates, 'all');
    assert.equal(requestBodies[1].sendUpdates, 'none');
    assert.deepEqual(requestBodies[1].attendees.map((attendee) => attendee.email), ['alex@example.com']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('updateCalendarEvent disables attendee emails in email test mode', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { id: 'event-1' };
      },
    };
  };

  try {
    await updateCalendarEvent({
      config: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://example.com/oauth',
          sharedCalendarId: 'primary',
        },
        email: { testMode: true },
      },
      logger: { warn() {} },
      caseRecord: { id: 'case-1', ownerSlackUserId: 'U123', calendarEventId: 'event-1' },
      eventInput: {
        candidateName: 'Alex Reyes',
        jobTitle: 'Support Specialist',
        startDate: '2026-06-01',
        startTime: '09:00',
        durationMinutes: 30,
        attendees: ['alex@example.com'],
        timeZone: 'Asia/Manila',
      },
      store: {
        async getGoogleToken() {
          return { access_token: 'token' };
        },
      },
    });

    assert.equal(requestBody.sendUpdates, 'none');
    assert.deepEqual(requestBody.attendees.map((attendee) => attendee.email), ['alex@example.com']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendRecruiterEmail redirects recipients in email test mode', async () => {
  const originalFetch = globalThis.fetch;
  let sentRaw;
  globalThis.fetch = async (_url, options) => {
    sentRaw = JSON.parse(options.body).raw;
    return {
      ok: true,
      async json() {
        return { id: 'message-1' };
      },
    };
  };
  const infos = [];

  try {
    const result = await sendRecruiterEmail({
      config: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://example.com/oauth',
          sharedCalendarId: 'primary',
        },
        email: {
          testMode: true,
          testRecipient: 'test-recipient@example.com',
        },
      },
      logger: {
        warn() {},
        info(event, payload) {
          infos.push({ event, payload });
        },
      },
      caseRecord: { id: 'case-1', ownerSlackUserId: 'U123' },
      email: {
        to: 'candidate@example.com',
        cc: ['recruiter@example.com'],
        bcc: ['hidden@example.com'],
        from: 'sender@example.com',
        subject: 'Interview',
        htmlBody: '<p>Hello</p>',
        plainBody: 'Hello',
      },
      store: {
        async getGoogleToken() {
          return { access_token: 'token' };
        },
      },
    });

    const decoded = Buffer.from(sentRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(decoded, /^To: test-recipient@example\.com/m);
    assert.doesNotMatch(decoded, /candidate@example\.com/);
    assert.doesNotMatch(decoded, /^Cc:/m);
    assert.equal(result.email.to, 'test-recipient@example.com');
    assert.deepEqual(result.email.cc, []);
    assert.deepEqual(result.email.bcc, []);
    assert.deepEqual(result.email.testMode.originalRecipients, {
      to: 'candidate@example.com',
      cc: 'recruiter@example.com',
      bcc: 'hidden@example.com',
    });
    assert.equal(infos[0].event, 'gmail_send_test_redirected');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendRecruiterEmail keeps recipients unchanged when email test mode is off', async () => {
  const originalFetch = globalThis.fetch;
  let sentRaw;
  globalThis.fetch = async (_url, options) => {
    sentRaw = JSON.parse(options.body).raw;
    return {
      ok: true,
      async json() {
        return { id: 'message-1' };
      },
    };
  };

  try {
    const result = await sendRecruiterEmail({
      config: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://example.com/oauth',
          sharedCalendarId: 'primary',
        },
        email: { testMode: false },
      },
      logger: { warn() {} },
      caseRecord: { id: 'case-1', ownerSlackUserId: 'U123' },
      email: {
        to: 'candidate@example.com',
        cc: ['recruiter@example.com'],
        from: 'sender@example.com',
        subject: 'Interview',
        htmlBody: '<p>Hello</p>',
        plainBody: 'Hello',
      },
      store: {
        async getGoogleToken() {
          return { access_token: 'token' };
        },
      },
    });

    const decoded = Buffer.from(sentRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(decoded, /^To: candidate@example\.com/m);
    assert.match(decoded, /^Cc: recruiter@example\.com/m);
    assert.equal(result.email.to, 'candidate@example.com');
    assert.deepEqual(result.email.cc, ['recruiter@example.com']);
    assert.equal(result.email.testMode, undefined);
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

test('buildGmailRawMessage includes binary attachments', () => {
  const raw = buildGmailRawMessage({
    to: 'candidate@example.com',
    from: 'recruiter@example.com',
    subject: 'Resume',
    htmlBody: '<p>Attached</p>',
    plainBody: 'Attached',
    attachments: [{
      filename: 'candidate.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('resume bytes'),
    }],
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  assert.match(decoded, /Content-Type: application\/pdf; name="candidate\.pdf"/);
  assert.match(decoded, /Content-Disposition: attachment; filename="candidate\.pdf"/);
  assert.match(decoded, /cmVzdW1lIGJ5dGVz/);
});

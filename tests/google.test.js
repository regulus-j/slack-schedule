import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleOAuthUrl, getRecruiterId } from '../src/services/google.js';
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
const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const env = {};
for (const line of content.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  const key = trimmed.substring(0, eq).trim();
  const val = trimmed.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  if (key) env[key] = val;
}

const token = env.SLACK_BOT_TOKEN;
const client = new WebClient(token);

(async () => {
  // 1. Try users.list without team_id
  console.log('=== users.list (no team_id) ===');
  const r1 = await client.users.list({ limit: 1 }).catch(e => ({ _err: e }));
  if (r1._err) {
    console.log('Error:', r1._err.data?.error);
    console.log('Needed:', r1._err.data?.needed);
    console.log('Provided:', r1._err.data?.provided);
  } else {
    console.log('OK,', r1.members?.length, 'users');
    console.log('Team:', r1.response_metadata?.team_id || 'not in response');
  }

  // 2. Try auth.test to resolve team_id
  console.log('\n=== auth.test ===');
  const auth = await client.auth.test().catch(e => ({ _err: e }));
  if (auth._err) {
    console.log('Error:', auth._err.data?.error);
  } else {
    console.log('OK, team_id:', auth.team_id, 'team:', auth.team);
  }

  // 3. If we have team_id, try users.list with it
  const teamId = auth.team_id || '';
  if (teamId) {
    console.log('\n=== users.list (with team_id=' + teamId + ') ===');
    const r2 = await client.users.list({ limit: 3, team_id: teamId }).catch(e => ({ _err: e }));
    if (r2._err) {
      console.log('Error:', r2._err.data?.error);
    } else {
      console.log('OK,', r2.members?.length, 'users returned');
      console.log('Sample names:', r2.members?.map(m => m.real_name || m.name).slice(0, 3).join(', '));
    }
  }

  // 4. Try conversations.list to see what channels the bot can see
  console.log('\n=== conversations.list (public) ===');
  const pub = await client.conversations.list({ types: 'public_channel', limit: 5 }).catch(e => ({ _err: e }));
  if (pub._err) {
    console.log('Error:', pub._err.data?.error);
  } else {
    console.log(pub.channels?.length, 'channels:', pub.channels?.map(c => '#' + c.name).join(', '));
  }

  // 5. Try conversations.list for private channels
  console.log('\n=== conversations.list (private) ===');
  const priv = await client.conversations.list({ types: 'private_channel', limit: 5 }).catch(e => ({ _err: e }));
  if (priv._err) {
    console.log('Error:', priv._err.data?.error);
  } else {
    console.log(priv.channels?.length, 'channels:', priv.channels?.map(c => '🔒' + c.name).join(', '));
  }
})();

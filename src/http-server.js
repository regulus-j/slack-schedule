import { createServer } from 'node:http';
import { URL } from 'node:url';
import { googleReady } from './config.js';
import { exchangeGoogleOAuthCode } from './services/google.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createHttpServer({ config, store, logger }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      try {
        const stats = await store.stats();
        sendJson(res, 200, {
          ok: true,
          env: config.env,
          googleConfigured: googleReady(config),
          cases: stats.cases,
        });
      } catch (error) {
        logger.error('health_check_failed', { error: error.message });
        sendJson(res, 500, { ok: false });
      }
      return;
    }

    if (url.pathname === '/oauth/google/callback') {
      const code = url.searchParams.get('code');
      const state = parseOAuthState(url.searchParams.get('state'));

      logger.info('google_oauth_callback_received', {
        hasCode: Boolean(code),
        hasState: Boolean(state?.recruiterId),
      });

      if (!code) {
        sendJson(res, 400, { ok: false, error: 'missing_code' });
        return;
      }

      if (!state?.recruiterId) {
        sendJson(res, 400, { ok: false, error: 'missing_recruiter_state' });
        return;
      }

      try {
        const tokenData = await exchangeGoogleOAuthCode({ config, code });
        await store.saveGoogleToken(state.recruiterId, tokenData);
        sendJson(res, 200, {
          ok: true,
          message: 'Google OAuth completed and token saved.',
        });
      } catch (error) {
        logger.error('google_oauth_callback_failed', { error: error.message });
        sendJson(res, 500, { ok: false, error: 'oauth_exchange_failed' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  function parseOAuthState(value) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return { recruiterId: value };
    }

    return null;
  }
}

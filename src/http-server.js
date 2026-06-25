import { createServer } from 'node:http'
import { URL } from 'node:url'
import { exchangeGoogleOAuthCode } from './services/google.js'
import { consumeOAuthState } from './security/oauth-state.js'
import crypto from 'node:crypto'

function sendJson(res, status, body, { noStore = false } = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    ...(noStore ? { 'cache-control': 'no-store' } : {}),
  })
  res.end(JSON.stringify(body))
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'cache-control': 'no-store',
  })
  res.end(html)
}

function oauthSuccessPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Connected</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f0fdf4; }
  .card { background: #fff; border-radius: 12px; padding: 40px; max-width: 420px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 20px; color: #166534; margin: 0 0 8px 0; }
  p { font-size: 14px; color: #4b5563; margin: 0; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#9989;</div>
  <h1>Google account connected</h1>
  <p>Your Google Calendar and Gmail are now linked. You can close this tab and return to Slack.</p>
</div>
</body>
</html>`
}

function oauthErrorPage(title, detail) {
  const escapedTitle = String(title || 'Connection failed').replace(/&/g, '&amp;').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '&quot;')
  const escapedDetail = String(detail || 'Something went wrong. Please try again from Slack.').replace(/&/g, '&amp;').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '&quot;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connection Failed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fef2f2; }
  .card { background: #fff; border-radius: 12px; padding: 40px; max-width: 460px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 20px; color: #991b1b; margin: 0 0 8px 0; }
  p { font-size: 14px; color: #4b5563; margin: 0 0 4px 0; }
  .detail { font-size: 12px; color: #9ca3af; margin-top: 12px; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#9888;&#65039;</div>
  <h1>${escapedTitle}</h1>
  <p>${escapedDetail}</p>
  <p class="detail">Return to Slack and try clicking &ldquo;Connect Google&rdquo; again.</p>
</div>
</body>
</html>`
}

async function sendSlackDm({ slackClient, slackUserId, text }) {
  if (!slackClient || !slackUserId) return
  try {
    await slackClient.chat.postMessage({ channel: slackUserId, text })
  } catch (_) {
    // best-effort: a DM failure must not mask the original OAuth error
  }
}

export function createHttpServer({ config, store, logger, slackClient }) {
  return createServer(async (req, res) => {
    const correlationId = crypto.randomUUID()
    const baseUrl = config.publicBaseUrl || `http://localhost:${config.port || 3000}`
    const url = new URL(req.url, baseUrl)

    if (url.pathname === '/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      try {
        await store.stats()
        sendJson(res, 200, { ok: true })
      } catch (error) {
        logger.error('health_check_failed', { error, correlationId })
        sendJson(res, 503, { ok: false, correlationId })
      }
      return
    }

    if (url.pathname === '/oauth/google/callback') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { noStore: true })
        return
      }
      const code = url.searchParams.get('code')
      const stateToken = url.searchParams.get('state')
      const googleError = url.searchParams.get('error')
      const googleErrorDescription = url.searchParams.get('error_description') || ''

      logger.info('google_oauth_callback_received', {
        hasCode: Boolean(code),
        hasState: Boolean(stateToken),
        hasGoogleError: Boolean(googleError),
        googleError: googleError || undefined,
        googleErrorDescription: googleErrorDescription || undefined,
        correlationId,
      })

      // Google returned an error (e.g., access_denied, redirect_uri_mismatch)
      if (googleError) {
        const userMessage = googleError === 'access_denied'
          ? 'You declined the Google authorization request.'
          : `Google returned an error: ${googleError}${googleErrorDescription ? ` — ${googleErrorDescription}` : ''}. Check that the redirect URI (${config.google.redirectUri}) is authorized in Google Cloud Console.`

        let slackUserId = ''
        if (stateToken) {
          try {
            const state = await consumeOAuthState({
              store,
              token: stateToken,
              expectedTeamId: config.slack.teamId || '',
            })
            slackUserId = state?.slackUserId || ''
          } catch (_) {
            // state lookup may fail if already consumed or expired
          }
        }

        logger.warn('google_oauth_callback_google_error', {
          googleError,
          googleErrorDescription: googleErrorDescription || undefined,
          correlationId,
          hasSlackUser: Boolean(slackUserId),
        })

        await sendSlackDm({
          slackClient,
          slackUserId,
          text: `:warning: Google OAuth connection failed: *${googleError}*. ${userMessage}`,
        })

        sendHtml(res, 400, oauthErrorPage('Google authorization failed', userMessage))
        return
      }

      if (!code) {
        // No code and no error from Google — likely a direct visit to the callback URL
        sendHtml(res, 400, oauthErrorPage('Missing authorization code', 'No authorization code was received from Google. Please start from the Connect Google button in Slack.'))
        return
      }

      let state
      try {
        state = await consumeOAuthState({
          store,
          token: stateToken,
          expectedTeamId: config.slack.teamId || '',
        })
      } catch (error) {
        logger.error('google_oauth_state_lookup_failed', { error, correlationId })
        sendHtml(res, 500, oauthErrorPage('Internal error', 'Failed to verify the OAuth request. Please try again.'))
        return
      }
      if (!state?.tokenOwnerId) {
        logger.warn('google_oauth_state_rejected', { correlationId })

        let slackUserId = ''
        if (state?.slackUserId) slackUserId = state.slackUserId
        await sendSlackDm({
          slackClient,
          slackUserId,
          text: ':warning: Your Google OAuth link has expired or was already used. Click *Connect Google* in the Slack home tab to get a fresh link.',
        })

        sendHtml(res, 400, oauthErrorPage('Link expired or already used', 'This OAuth link has expired or was already consumed. Please request a new one from Slack.'))
        return
      }

      try {
        const tokenData = await exchangeGoogleOAuthCode({ config, code })
        await store.saveGoogleToken(state.tokenOwnerId, tokenData)

        logger.info('google_oauth_callback_succeeded', {
          correlationId,
          tokenOwnerId: state.tokenOwnerId,
        })

        await sendSlackDm({
          slackClient,
          slackUserId: state.slackUserId,
          text: ':white_check_mark: Google Calendar and Gmail are now connected. You can start scheduling interviews with live calendar availability.',
        })

        sendHtml(res, 200, oauthSuccessPage())
      } catch (error) {
        logger.error('google_oauth_callback_failed', {
          error,
          correlationId,
          redirectUri: config.google.redirectUri,
        })

        await sendSlackDm({
          slackClient,
          slackUserId: state.slackUserId,
          text: `:warning: Google OAuth connection failed while exchanging the authorization code: ${error.message}. Please try again or contact an admin.`,
        })

        sendHtml(res, 500, oauthErrorPage('Token exchange failed', 'Google rejected the authorization code. This can happen if the redirect URI does not match exactly what is registered in Google Cloud Console, or if the code was already used.'))
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found', correlationId })
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHttpServer } from '../src/http-server.js'
import { issueOAuthState } from '../src/security/oauth-state.js'
import { createJsonStore } from '../src/store/json-store.js'

test('health response exposes readiness only and sends security headers', async () => {
  const server = createHttpServer({
    config: { port: 0, publicBaseUrl: 'http://localhost' },
    store: { async stats() { return { cases: 99 } } },
    logger: silentLogger(),
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('OAuth callback consumes opaque state once and rejects replay with HTML', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'http-oauth-'))
  const store = createJsonStore(runtimeDir)
  await store.init()
  const state = await issueOAuthState({
    store,
    slackUserId: 'UONE',
    teamId: 'TONE',
    tokenOwnerId: 'USHARED',
  })
  const server = createHttpServer({
    config: {
      port: 0,
      publicBaseUrl: 'http://localhost',
      slack: { teamId: 'TONE' },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/oauth/google/callback',
        sharedCalendarId: 'primary',
      },
    },
    store,
    logger: silentLogger(),
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { access_token: 'token', refresh_token: 'refresh', expires_in: 3600 }
    },
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}/oauth/google/callback?code=test&state=${state}`
    const first = await originalFetch(base)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.headers.get('content-type'), 'text/html; charset=utf-8')
    const firstBody = await first.text()
    assert.ok(firstBody.includes('Google account connected'))

    const second = await originalFetch(base)
    assert.equal(second.status, 400)
    assert.equal(second.headers.get('content-type'), 'text/html; charset=utf-8')
    const secondBody = await second.text()
    assert.ok(secondBody.includes('expired or already used'))
  } finally {
    globalThis.fetch = originalFetch
    server.close()
    await once(server, 'close')
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test('OAuth callback returns HTML error when Google sends an error query parameter', async () => {
  const server = createHttpServer({
    config: {
      port: 0,
      publicBaseUrl: 'http://localhost',
      slack: { teamId: 'TONE' },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/oauth/google/callback',
        sharedCalendarId: 'primary',
      },
    },
    store: {
      async consumeOAuthState() { return null },
    },
    logger: silentLogger(),
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/oauth/google/callback?error=redirect_uri_mismatch&error_description=Bad+URI&state=sometoken`,
    )
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    const body = await response.text()
    assert.ok(body.includes('redirect_uri_mismatch'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('OAuth callback returns HTML error when authorization code is missing', async () => {
  const server = createHttpServer({
    config: {
      port: 0,
      publicBaseUrl: 'http://localhost',
      slack: { teamId: '' },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/oauth/google/callback',
        sharedCalendarId: 'primary',
      },
    },
    store: {
      async consumeOAuthState() { return null },
    },
    logger: silentLogger(),
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/oauth/google/callback`,
    )
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    const body = await response.text()
    assert.ok(body.includes('Missing authorization code'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('OAuth callback dispatches Slack DM on success and failure', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'http-oauth-dm-'))
  const store = createJsonStore(runtimeDir)
  await store.init()
  const state = await issueOAuthState({
    store,
    slackUserId: 'UONE',
    teamId: 'TONE',
    tokenOwnerId: 'USHARED',
  })

  const dmMessages = []
  const slackClient = {
    chat: {
      async postMessage(args) {
        dmMessages.push(args)
      },
    },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { access_token: 'token', refresh_token: 'refresh', expires_in: 3600 }
    },
  })

  const server = createHttpServer({
    config: {
      port: 0,
      publicBaseUrl: 'http://localhost',
      slack: { teamId: 'TONE' },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/oauth/google/callback',
        sharedCalendarId: 'primary',
      },
    },
    store,
    logger: silentLogger(),
    slackClient,
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}/oauth/google/callback?code=test&state=${state}`

    // Success: should receive a success DM
    const first = await originalFetch(base)
    assert.equal(first.status, 200)

    assert.equal(dmMessages.length, 1)
    assert.equal(dmMessages[0].channel, 'UONE')
    assert.ok(dmMessages[0].text.includes('connected'))

    // Replay: state is consumed, user can't be identified, no DM possible
    const second = await originalFetch(base)
    assert.equal(second.status, 400)
    const secondBody = await second.text()
    assert.ok(secondBody.includes('expired or already used'))
  } finally {
    globalThis.fetch = originalFetch
    server.close()
    await once(server, 'close')
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test('OAuth callback handles Google error with DM when state is valid', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'http-oauth-gerr-'))
  const store = createJsonStore(runtimeDir)
  await store.init()
  const state = await issueOAuthState({
    store,
    slackUserId: 'UONE',
    teamId: 'TONE',
    tokenOwnerId: 'USHARED',
  })

  const dmMessages = []
  const slackClient = {
    chat: {
      async postMessage(args) {
        dmMessages.push(args)
      },
    },
  }

  const server = createHttpServer({
    config: {
      port: 0,
      publicBaseUrl: 'http://localhost',
      slack: { teamId: 'TONE' },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/oauth/google/callback',
        sharedCalendarId: 'primary',
      },
    },
    store,
    logger: silentLogger(),
    slackClient,
  })
  server.listen(0)
  await once(server, 'listening')
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/oauth/google/callback?error=access_denied&state=${state}`,
    )
    assert.equal(response.status, 400)
    const body = await response.text()
    assert.ok(body.includes('Google authorization failed'))

    assert.equal(dmMessages.length, 1)
    assert.equal(dmMessages[0].channel, 'UONE')
    assert.ok(dmMessages[0].text.includes('access_denied'))
  } finally {
    server.close()
    await once(server, 'close')
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  }
}

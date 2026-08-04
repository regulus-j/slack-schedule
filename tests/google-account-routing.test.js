import assert from 'node:assert/strict'
import test from 'node:test'
import { googleAccountRoutingError, requireGoogleAccount } from '../src/services/google-account-routing.js'

test('requireGoogleAccount resolves a mapped JazzHR account with a shared token', async () => {
  const accountId = await requireGoogleAccount({
    config: { google: { accountByJazzhrAccount: { offshore: 'offshore@example.com' } } },
    accountKey: ' OFFSHORE ',
    store: { async hasGoogleToken(id) { return id === 'offshore@example.com' } },
  })
  assert.equal(accountId, 'offshore@example.com')
})

test('requireGoogleAccount uses the shared OAuth owner when no account map is configured', async () => {
  const accountId = await requireGoogleAccount({
    config: { google: { authSlackUserId: 'U-SHARED', accountByJazzhrAccount: {} } },
    accountKey: 'default',
    store: { async hasGoogleToken(id) { return id === 'U-SHARED' } },
  })

  assert.equal(accountId, 'U-SHARED')
})

test('requireGoogleAccount rejects an unmapped JazzHR account', async () => {
  await assert.rejects(
    requireGoogleAccount({
      config: { google: { accountByJazzhrAccount: {} } },
      accountKey: 'offshore',
      store: { async hasGoogleToken() { return true } },
    }),
    (error) => error.code === 'google_account_routing' && /offshore/.test(error.message),
  )
})

test('requireGoogleAccount rejects a mapped account without a token', async () => {
  await assert.rejects(
    requireGoogleAccount({
      config: { google: { accountByJazzhrAccount: { default: 'shared@example.com' } } },
      store: { async hasGoogleToken() { return false } },
    }),
    (error) => error.code === 'google_account_routing' && /not connected/.test(error.message),
  )
})

test('googleAccountRoutingError identifies the required configuration', () => {
  const error = googleAccountRoutingError('Offshore')
  assert.equal(error.code, 'google_account_routing')
  assert.match(error.message, /GOOGLE_ACCOUNT_BY_JAZZHR_ACCOUNT/)
})

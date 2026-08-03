import { normalizeJazzhrAccountKey, resolveGoogleAccountId } from '../config.js'

export function googleAccountRoutingError(accountKey, reason = 'mapping') {
  const normalizedKey = normalizeJazzhrAccountKey(accountKey)
  const error = reason === 'token'
    ? new Error(`The Google account mapped to JazzHR account "${normalizedKey}" is not connected. Ask an admin to connect it before scheduling.`)
    : new Error(`No Google account is mapped to JazzHR account "${normalizedKey}". Ask an admin to configure GOOGLE_ACCOUNT_BY_JAZZHR_ACCOUNT before scheduling.`)
  error.code = 'google_account_routing'
  return error
}

export async function requireGoogleAccount({ config, store, accountKey = 'default', existingAccountId = '' }) {
  const googleAccountId = String(existingAccountId || resolveGoogleAccountId(config, accountKey) || '').trim()
  if (!googleAccountId) throw googleAccountRoutingError(accountKey)

  if (typeof store?.hasGoogleToken === 'function') {
    if (!(await store.hasGoogleToken(googleAccountId))) throw googleAccountRoutingError(accountKey, 'token')
  } else if (typeof store?.getGoogleToken === 'function') {
    if (!(await store.getGoogleToken(googleAccountId))) throw googleAccountRoutingError(accountKey, 'token')
  } else {
    throw googleAccountRoutingError(accountKey, 'token')
  }

  return googleAccountId
}

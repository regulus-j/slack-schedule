import crypto from 'node:crypto'

const DEFAULT_TTL_MS = 10 * 60 * 1000

export async function issueOAuthState({
  store,
  slackUserId,
  teamId,
  tokenOwnerId,
  source = 'slack',
  now = new Date(),
  ttlMs = DEFAULT_TTL_MS,
}) {
  if (!store?.createOAuthState) throw new Error('OAuth state storage is unavailable')
  const token = crypto.randomBytes(32).toString('base64url')
  await store.createOAuthState({
    stateHash: hashOAuthState(token),
    slackUserId,
    teamId,
    tokenOwnerId,
    source,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  })
  return token
}

export async function consumeOAuthState({
  store,
  token,
  expectedTeamId = '',
  now = new Date(),
}) {
  if (!token || !store?.consumeOAuthState) return null
  return store.consumeOAuthState(hashOAuthState(token), {
    expectedTeamId,
    now: now.toISOString(),
  })
}

export function hashOAuthState(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

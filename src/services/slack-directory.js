import { getSlackRecruiters, getSlackUsers, setSlackRecruiters, setSlackUsers } from '../data/cache.js'

let directoryLoaded = false
let directoryLoadPromise = null

export async function ensureSlackDirectory({ client, config, logger, force = false }) {
  if (!force && directoryLoaded) {
    return {
      users: getSlackUsers(),
      recruiters: getSlackRecruiters(),
    }
  }

  if (!force && directoryLoadPromise) return directoryLoadPromise

  directoryLoadPromise = loadSlackDirectory({ client, config, logger })
  try {
    return await directoryLoadPromise
  } finally {
    directoryLoadPromise = null
  }
}

async function loadSlackDirectory({ client, config, logger }) {
  const users = await fetchAllSlackUsers({ client, logger })
  setSlackUsers(users)

  let recruiters = []
  const channelId = config?.slack?.recruitmentChannelId
  if (channelId) {
    try {
      recruiters = await fetchRecruitmentChannelUsers({ client, channelId, users, logger })
    } catch (error) {
      if (error?.data?.error !== 'missing_scope') throw error
      logger.warn('slack_recruitment_channel_missing_scope', {
        channelId,
        error: error.message,
        recruiters: 0,
      })
      recruiters = []
    }
  }
  setSlackRecruiters(recruiters)
  directoryLoaded = true

  logger.info('slack_directory_refreshed', {
    users: users.length,
    recruiters: recruiters.length,
    channelId,
  })

  return { users, recruiters }
}

export async function resolveSlackUser({ client, userId, logger }) {
  const existing = getSlackUsers().find((user) => user.slackUserId === userId || user.id === userId)
  if (existing) return existing

  try {
    const result = await client.users.info({ user: userId })
    const normalized = normalizeSlackUser(result.user)
    if (!normalized) return null
    const merged = upsertBySlackId(getSlackUsers(), normalized)
    setSlackUsers(merged)
    return normalized
  } catch (error) {
    logger.warn('slack_user_resolve_failed', { userId, error: error.message })
    return null
  }
}

export function normalizeSlackUser(user) {
  if (!user || user.deleted || user.is_bot || user.is_app_user) return null
  const profile = user.profile || {}
  const name =
    profile.real_name_normalized ||
    profile.display_name_normalized ||
    profile.real_name ||
    profile.display_name ||
    user.real_name ||
    user.name ||
    user.id

  return {
    id: user.id,
    slackUserId: user.id,
    name,
    email: profile.email || '',
    role: 'slack_user',
    positionTitle: profile.title || '',
    avatarUrl: profile.image_192 || profile.image_72 || profile.image_48 || '',
    source: 'slack',
  }
}

async function fetchAllSlackUsers({ client, logger }) {
  const users = []
  let cursor

  do {
    const result = await client.users.list({
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    users.push(...(result.members || []).map(normalizeSlackUser).filter(Boolean))
    cursor = result.response_metadata?.next_cursor || ''
  } while (cursor)

  logger.info('slack_users_loaded', { count: users.length })
  return users
}

async function fetchRecruitmentChannelUsers({ client, channelId, users, logger }) {
  const memberIds = []
  let cursor

  do {
    const result = await client.conversations.members({
      channel: channelId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    memberIds.push(...(result.members || []))
    cursor = result.response_metadata?.next_cursor || ''
  } while (cursor)

  const bySlackId = new Map(users.map((user) => [user.slackUserId, user]))
  const recruiters = memberIds
    .map((id) => bySlackId.get(id))
    .filter(Boolean)
    .map((user) => ({
      ...user,
      role: 'recruiter',
    }))

  logger.info('slack_recruitment_channel_loaded', {
    channelId,
    members: memberIds.length,
    recruiters: recruiters.length,
  })

  return recruiters
}

function upsertBySlackId(users, user) {
  const withoutExisting = users.filter((item) => item.slackUserId !== user.slackUserId)
  return [user, ...withoutExisting]
}

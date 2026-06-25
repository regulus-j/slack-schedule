import {
  getRecruitmentSheetPeople,
  getSlackRecruiters,
  getSlackUsers,
  setSlackRecruiters,
  setSlackUsers,
} from '../data/cache.js'
import { personIdentityMatches } from './recruiter-phone-export.js'

let directoryLoaded = false
let directoryLoadPromise = null
let recruitmentDirectoryLoadedAt = 0
let recruitmentDirectoryLoadPromise = null
const RECRUITMENT_DIRECTORY_TTL_MS = 5 * 60 * 1000

export async function ensureSlackDirectory({ client, config, logger, force = false }) {
  if (!force && directoryLoaded) {
    return {
      users: getSlackUsers(),
      recruiters: [],
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
  const users = await fetchAllSlackUsers({ client, config, logger })
  setSlackUsers(users)

  directoryLoaded = true

  logger.info('slack_directory_refreshed', {
    users: users.length,
  })

  return { users, recruiters: [] }
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

export async function ensureRecruitmentSlackDirectory({
  client,
  config,
  logger,
  force = false,
}) {
  if (
    !force &&
    recruitmentDirectoryLoadedAt > 0 &&
    Date.now() - recruitmentDirectoryLoadedAt < RECRUITMENT_DIRECTORY_TTL_MS
  ) {
    return { users: getSlackRecruiters() }
  }

  if (!force && recruitmentDirectoryLoadPromise) return recruitmentDirectoryLoadPromise

  recruitmentDirectoryLoadPromise = loadRecruitmentSlackDirectory({
    client,
    config,
    logger,
    force,
  })
  try {
    return await recruitmentDirectoryLoadPromise
  } finally {
    recruitmentDirectoryLoadPromise = null
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

export function slackApiErrorDetails(error) {
  return {
    error: error?.message || String(error || 'Unknown Slack API error'),
    slackError: error?.data?.error,
    needed: error?.data?.needed,
    provided: error?.data?.provided,
  }
}

async function fetchAllSlackUsers({ client, config, logger }) {
  const users = []
  let cursor
  let teamId = config?.slack?.teamId || ''

  do {
    let result
    try {
      result = await client.users.list(buildSlackUsersListArgs({ cursor, teamId }))
    } catch (error) {
      if (!teamId && isMissingTeamIdError(error)) {
        teamId = await resolveSlackTeamId({ client, logger })
        if (teamId) {
          logger.info('slack_directory_team_id_resolved')
          result = await client.users.list(buildSlackUsersListArgs({ cursor, teamId }))
        }
      }
      if (!result) throw error
    }
    users.push(...(result.members || []).map(normalizeSlackUser).filter(Boolean))
    cursor = result.response_metadata?.next_cursor || ''
  } while (cursor)

  logger.info('slack_users_loaded', { count: users.length })
  return users
}

async function loadRecruitmentSlackDirectory({ client, config, logger, force }) {
  const { users } = await ensureSlackDirectory({ client, config, logger, force })
  const sheetPeople = getRecruitmentSheetPeople()
  const matchedUsers = users
    .filter((user) => user?.email)
    .filter((user) => sheetPeople.some((person) => personIdentityMatches(person, user)))
  setSlackRecruiters(matchedUsers)
  recruitmentDirectoryLoadedAt = Date.now()

  logger.info('slack_recruitment_sheet_matches_loaded', {
    slackUsers: users.length,
    sheetPeople: sheetPeople.length,
    selectableUsers: matchedUsers.length,
  })

  return { users: matchedUsers }
}

function buildSlackUsersListArgs({ cursor, teamId }) {
  return {
    limit: 200,
    ...(cursor ? { cursor } : {}),
    ...(teamId ? { team_id: teamId } : {}),
  }
}

async function resolveSlackTeamId({ client, logger }) {
  if (typeof client?.auth?.test !== 'function') return ''

  try {
    const result = await client.auth.test()
    return result.team_id || result.team?.id || ''
  } catch (error) {
    logger.warn('slack_directory_team_id_resolve_failed', {
      error: error.message,
      slackError: error.data?.error,
      needed: error.data?.needed,
      provided: error.data?.provided,
    })
    return ''
  }
}

function isMissingTeamIdError(error) {
  const slackError = error?.data?.error
  const needed = error?.data?.needed
  return slackError === 'missing_argument' && (!needed || String(needed).includes('team_id'))
}

function upsertBySlackId(users, user) {
  const withoutExisting = users.filter((item) => item.slackUserId !== user.slackUserId)
  return [user, ...withoutExisting]
}

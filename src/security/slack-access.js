import crypto from 'node:crypto'

const RATE_LIMITS = {
  read: { limit: 60, windowMs: 60 * 1000 },
  mutation: { limit: 20, windowMs: 5 * 60 * 1000 },
  sideEffect: { limit: 10, windowMs: 10 * 60 * 1000 },
  admin: { limit: 3, windowMs: 10 * 60 * 1000 },
}

const SIDE_EFFECT_ACTIONS = new Set([
  'cancel_interview',
  'mark_event_complete',
  'retry_custom_invites',
])

const SIDE_EFFECT_VIEWS = new Set([
  'scheduling_phase_two',
  'finalize_email_preview_submit',
  'reschedule_approval_submit',
])

export function installSlackSecurityMiddleware(app, { config, store, logger }) {
  if (typeof app?.use !== 'function') return
  app.use(async (args) => {
    const userId = slackUserIdFromArgs(args)
    const requestName = slackRequestName(args)
    const correlationId = crypto.randomUUID()
    if (args.context) args.context.correlationId = correlationId

    if (!userId && isTrustedWorkflowLauncher(args, config)) {
      await args.next()
      return
    }

    if (!isRecruitmentUser(config, userId)) {
      logger.warn('slack_access_denied', { userId, requestName, correlationId })
      await denySlackRequest(args, `You are not authorized to use this scheduling app. Reference: ${correlationId}`)
      return
    }

    const rateClass = classifyRateLimit(args)
    if (store?.consumeRateLimit && userId) {
      const policy = RATE_LIMITS[rateClass]
      const result = await store.consumeRateLimit({
        userId,
        bucket: rateClass,
        limit: policy.limit,
        windowMs: policy.windowMs,
      })
      if (!result.allowed) {
        logger.warn('slack_rate_limit_exceeded', {
          userId,
          requestName,
          rateClass,
          retryAfterMs: result.retryAfterMs,
          correlationId,
        })
        await denySlackRequest(args, `Too many requests. Try again in ${Math.max(1, Math.ceil(result.retryAfterMs / 60000))} minute(s). Reference: ${correlationId}`)
        return
      }
    }

    await args.next()
  })
}

function isTrustedWorkflowLauncher(args, config) {
  const event = args.event || args.body?.event
  if (event?.type !== 'message' || event.user) return false
  const text = String(event.text || '').trim().toLowerCase()
  if (!['/schedule-interview', '/schedule-interview button'].includes(text)) return false
  const restrictedChannel = config?.slack?.postingChannelId
  return !restrictedChannel || event.channel === restrictedChannel
}

export function isRecruitmentUser(config, userId) {
  const enforced = Boolean(config?.security?.accessControlEnforced)
  const allowed = new Set([
    ...(config?.security?.recruitmentUserIds || []),
    ...(config?.security?.adminUserIds || []),
  ])
  if (!enforced && allowed.size === 0) return true
  return Boolean(userId && allowed.has(String(userId).toUpperCase()))
}

export function isAdminUser(config, userId) {
  const admins = config?.security?.adminUserIds || []
  if (!config?.security?.accessControlEnforced && admins.length === 0) return true
  return Boolean(userId && admins.includes(String(userId).toUpperCase()))
}

export async function requireAdminSlackUser({ config, userId, client, channelId, logger, action }) {
  if (isAdminUser(config, userId)) return true
  const correlationId = crypto.randomUUID()
  logger.warn('slack_admin_access_denied', { userId, action, correlationId })
  if (client && userId) {
    try {
      const channel = channelId || (await client.conversations.open({ users: userId })).channel.id
      if (channelId) {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          text: `This operation is restricted to scheduler administrators. Reference: ${correlationId}`,
        })
      } else {
        await client.chat.postMessage({
          channel,
          text: `This operation is restricted to scheduler administrators. Reference: ${correlationId}`,
        })
      }
    } catch (error) {
      logger.warn('slack_admin_denial_message_failed', { userId, action, error: error.message, correlationId })
    }
  }
  return false
}

export function classifyRateLimit(args) {
  const name = slackRequestName(args)
  if (name === '/slack-scheduler') return 'admin'
  if (SIDE_EFFECT_ACTIONS.has(name) || SIDE_EFFECT_VIEWS.has(name)) return 'sideEffect'
  if (args.view || args.command || args.action || args.body?.view || args.body?.actions) return 'mutation'
  return 'read'
}

export function slackRequestName(args) {
  return String(
    args.command?.command ||
    args.action?.action_id ||
    args.payload?.action_id ||
    args.view?.callback_id ||
    args.body?.view?.callback_id ||
    args.event?.type ||
    args.body?.event?.type ||
    'unknown',
  )
}

export function slackUserIdFromArgs(args) {
  return String(
    args.command?.user_id ||
    args.body?.user?.id ||
    args.body?.user_id ||
    args.event?.user ||
    args.body?.event?.user ||
    args.options?.user?.id ||
    '',
  ).toUpperCase()
}

async function denySlackRequest(args, text) {
  try {
    if (typeof args.ack === 'function') await args.ack()
  } catch {
    // The request may already have been acknowledged by an earlier middleware.
  }

  const userId = slackUserIdFromArgs(args)
  if (!args.client || !userId) return
  try {
    const channelId = args.command?.channel_id || args.body?.channel?.id
    if (channelId) {
      await args.client.chat.postEphemeral({ channel: channelId, user: userId, text })
      return
    }
    const opened = await args.client.conversations.open({ users: userId })
    await args.client.chat.postMessage({ channel: opened.channel.id, text })
  } catch {
    // Denial notification is best effort and must not reopen the protected handler.
  }
}

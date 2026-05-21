export function resolvePostingChannel(config, requestedChannel) {
  const restricted = config?.slack?.postingChannelId
  return restricted || requestedChannel
}

export async function verifyChannel({ config, body, command, client }) {
  const restricted = config?.slack?.postingChannelId
  if (!restricted) return true

  const incomingChannel = command?.channel_id || body?.channel?.id

  if (!incomingChannel) return true

  if (incomingChannel === restricted) return true

  const user = body?.user?.id || command?.user_id
  if (user) {
    await client.chat.postEphemeral({
      channel: incomingChannel,
      user,
      text: `⚠️ This app only works in <#${restricted}>. Please use \`/schedule-interview\` there.`,
    })
  }

  return false
}

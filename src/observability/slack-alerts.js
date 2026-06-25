export function createSlackAlertDispatcher({ client, config }) {
  const warningState = new Map()
  const lastSentAt = new Map()
  const warningThreshold = config.alerting?.warningThreshold || 3
  const warningWindowMs = config.alerting?.warningWindowMs || 5 * 60 * 1000
  const cooldownMs = config.alerting?.cooldownMs || 15 * 60 * 1000
  const recipients = config.security?.alertUserIds || []
  let dispatching = false

  return async ({ level, event, details }) => {
    if (dispatching || recipients.length === 0) return
    const now = Date.now()
    const fingerprint = `${level}:${event}`
    if (level === 'warn') {
      const state = warningState.get(event) || []
      const recent = state.filter((time) => now - time <= warningWindowMs)
      recent.push(now)
      warningState.set(event, recent)
      if (recent.length < warningThreshold) return
      details.warningCount = recent.length
    }
    const last = lastSentAt.get(fingerprint) || 0
    if (now - last < cooldownMs) return
    lastSentAt.set(fingerprint, now)

    dispatching = true
    try {
      const text = [
        `*Scheduler ${String(level).toUpperCase()}*`,
        `Event: \`${event}\``,
        details.correlationId ? `Reference: \`${details.correlationId}\`` : '',
        details.caseId ? `Case: \`${details.caseId}\`` : '',
        details.error ? `Error: ${details.error}` : '',
        details.warningCount ? `Repeated warnings: ${details.warningCount}` : '',
      ].filter(Boolean).join('\n')
      for (const userId of recipients) {
        const opened = await client.conversations.open({ users: userId })
        await client.chat.postMessage({ channel: opened.channel.id, text })
      }
    } finally {
      dispatching = false
    }
  }
}

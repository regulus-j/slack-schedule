import { LogLevel } from '@slack/bolt'

const PONG_TIMEOUT_RE = /pong wasn't received|pong was not received/i

export function createSlackSdkLogger({ logger }) {
  let level = LogLevel.INFO
  let name = 'slack-sdk'

  const formatMessage = (items) => items.map(formatItem).join(' ')
  const logDetails = (items) => ({
    source: name,
    message: formatMessage(items),
  })

  return {
    debug(...items) {
      if (!isEnabled(level, LogLevel.DEBUG)) return
      logger.debug?.('slack_sdk_debug', logDetails(items))
    },
    info(...items) {
      if (!isEnabled(level, LogLevel.INFO)) return
      logger.info?.('slack_sdk_info', logDetails(items))
    },
    warn(...items) {
      if (!isEnabled(level, LogLevel.WARN)) return
      const details = logDetails(items)
      const event = PONG_TIMEOUT_RE.test(details.message)
        ? 'slack_socket_pong_timeout'
        : 'slack_sdk_warning'
      logger.warn?.(event, details)
    },
    error(...items) {
      if (!isEnabled(level, LogLevel.ERROR)) return
      logger.error?.('slack_sdk_error', logDetails(items))
    },
    setLevel(nextLevel) {
      level = nextLevel
    },
    getLevel() {
      return level
    },
    setName(nextName) {
      name = String(nextName || 'slack-sdk')
    },
  }
}

function formatItem(item) {
  if (item instanceof Error) return item.message
  if (typeof item === 'string') return item
  if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  if (item == null) return ''
  try {
    return JSON.stringify(item)
  } catch {
    return String(item)
  }
}

function isEnabled(currentLevel, messageLevel) {
  return severity(messageLevel) <= severity(currentLevel)
}

function severity(level) {
  return {
    [LogLevel.ERROR]: 0,
    [LogLevel.WARN]: 1,
    [LogLevel.INFO]: 2,
    [LogLevel.DEBUG]: 3,
  }[level] ?? 2
}

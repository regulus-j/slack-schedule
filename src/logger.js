const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g
const TOKEN_RE = /\b(?:xox[baprs]-|xapp-|AIza|ya29\.|gh[pousr]_)[A-Za-z0-9._-]+\b/gi
const CREDENTIAL_URL_RE = /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|resume|emailbody|htmlbody|plainbody|payload|candidate(name)?|address)/i
const SAFE_DETAIL_KEYS = new Set([
  'action',
  'attempt',
  'attempts',
  'caseId',
  'code',
  'configured',
  'correlationId',
  'count',
  'durationMs',
  'env',
  'error',
  'eventId',
  'filePath',
  'hasCode',
  'hasState',
  'jobId',
  'lagMs',
  'limit',
  'matchType',
  'mocked',
  'needed',
  'port',
  'provided',
  'rateClass',
  'reason',
  'records',
  'requestName',
  'retryAfterMs',
  'roleAssignments',
  'roleId',
  'sheetRecruiters',
  'slackError',
  'source',
  'stageKey',
  'status',
  'teamId',
  'type',
  'userId',
  'warningCount',
])

let alertDispatcher = null

export function redact(value, key = '') {
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (value instanceof Error) return sanitizeText(value.message)
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => SAFE_DETAIL_KEYS.has(childKey))
        .map(([childKey, item]) => [childKey, redact(item, childKey)]),
    )
  }
  return value
}

function sanitizeText(value) {
  return String(value || '')
    .replace(CONTROL_RE, '')
    .replace(/\r?\n/g, ' ')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(PHONE_RE, '[redacted-phone]')
    .replace(TOKEN_RE, '[redacted-token]')
    .replace(CREDENTIAL_URL_RE, '$1[redacted]@')
    .slice(0, 2000)
}

function write(level, event, details = {}) {
  const error = details?.error instanceof Error ? details.error : null
  const payload = {
    severity: level.toUpperCase(),
    level,
    event: sanitizeText(event),
    timestamp: new Date().toISOString(),
    ...redact(details),
    ...(error?.stack ? { stack: sanitizeText(error.stack) } : {}),
  }
  const line = JSON.stringify(payload)
  if (level === 'error' || level === 'fatal') {
    console.error(line)
  } else {
    console.log(line)
  }
  if (alertDispatcher && ['warn', 'error', 'fatal'].includes(level)) {
    Promise.resolve(alertDispatcher({ level, event: payload.event, details: payload }))
      .catch((dispatchError) => {
        console.error(JSON.stringify({
          severity: 'ERROR',
          event: 'slack_alert_dispatch_failed',
          timestamp: new Date().toISOString(),
          error: sanitizeText(dispatchError.message),
        }))
      })
  }
  return payload
}

export const logger = {
  info: (event, details) => write('info', event, details),
  warn: (event, details) => write('warn', event, details),
  error: (event, details) => write('error', event, details),
  fatal: (event, details) => write('fatal', event, details),
  setAlertDispatcher(dispatcher) {
    alertDispatcher = typeof dispatcher === 'function' ? dispatcher : null
  },
}

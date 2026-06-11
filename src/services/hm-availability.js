const DEFAULT_TIMEOUT_MS = 15000

export class HiringManagerAvailabilityError extends Error {
  constructor(message, { managerNames = [], code = 'hm_availability_failed' } = {}) {
    super(message)
    this.name = 'HiringManagerAvailabilityError'
    this.code = code
    this.managerNames = managerNames
  }
}

export async function checkHiringManagerAvailability({
  config,
  logger,
  attendees,
  windows,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const managers = normalizeManagers(attendees)
  if (managers.length === 0) {
    return { busyByEmail: {}, checkedAt: new Date().toISOString(), source: 'apps_script_hm' }
  }

  const url = config?.hiringManagerAvailability?.url
  const token = config?.hiringManagerAvailability?.token
  if (!url || !token) {
    throw availabilityError(managers, 'Hiring manager availability service is not configured.', 'hm_availability_not_configured')
  }

  const window = windows?.[0]
  if (!window?.timeMin || !window?.timeMax) {
    throw availabilityError(managers, 'Hiring manager availability window is missing.', 'hm_availability_window_missing')
  }

  let requestUrl
  try {
    requestUrl = new URL(url)
  } catch {
    throw availabilityError(managers, 'Hiring manager availability service URL is invalid.', 'hm_availability_not_configured')
  }
  requestUrl.searchParams.set('token', token)

  logger.info('hm_availability_check_started', {
    managerCount: managers.length,
    timeMin: window.timeMin,
    timeMax: window.timeMax,
  })

  let response
  try {
    response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'freeBusy',
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        attendees: managers.map(({ email }) => ({ email })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'Hiring manager availability check timed out.'
      : 'Hiring manager availability service could not be reached.'
    logger.warn('hm_availability_request_failed', { managerCount: managers.length, error: error.message })
    throw availabilityError(managers, message, 'hm_availability_request_failed')
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    logger.warn('hm_availability_invalid_json', { status: response.status, managerCount: managers.length })
    throw availabilityError(managers, 'Hiring manager availability service returned an invalid response.', 'hm_availability_invalid_response')
  }

  if (
    !response.ok ||
    payload?.ok !== true ||
    !payload?.calendars ||
    typeof payload.calendars !== 'object' ||
    Array.isArray(payload.calendars)
  ) {
    logger.warn('hm_availability_http_error', {
      status: response.status,
      managerCount: managers.length,
      serviceError: cleanServiceError(payload?.error),
    })
    throw availabilityError(managers, 'Hiring manager availability service rejected the request.', 'hm_availability_service_error')
  }

  const calendars = normalizeCalendarKeys(payload.calendars)
  const errors = normalizeCalendarKeys(payload.errors)
  const failedManagers = managers.filter(({ email }) => {
    const calendar = calendars[email]
    return errors[email] || !calendar || !Array.isArray(calendar.busy)
  })

  if (failedManagers.length > 0) {
    logger.warn('hm_availability_incomplete', {
      requestedCount: managers.length,
      failedCount: failedManagers.length,
    })
    throw availabilityError(failedManagers, managerFailureMessage(failedManagers), 'hm_availability_incomplete')
  }

  const busyByEmail = {}
  for (const manager of managers) {
    busyByEmail[manager.email] = calendars[manager.email].busy.map((period) => normalizeBusyPeriod(period, managers))
  }

  const checkedAt = new Date().toISOString()
  logger.info('hm_availability_check_completed', {
    managerCount: managers.length,
    checkedAt,
  })
  return { busyByEmail, checkedAt, source: 'apps_script_hm' }
}

function normalizeManagers(attendees) {
  const managers = []
  const seen = new Set()
  for (const attendee of Array.isArray(attendees) ? attendees : []) {
    const email = String(attendee?.email || '').trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    managers.push({
      email,
      name: String(attendee?.name || '').trim() || email,
    })
  }
  return managers
}

function normalizeCalendarKeys(value) {
  const normalized = {}
  if (!value || typeof value !== 'object') return normalized
  for (const [email, calendar] of Object.entries(value)) {
    normalized[String(email).trim().toLowerCase()] = calendar
  }
  return normalized
}

function normalizeBusyPeriod(period, managers) {
  const start = new Date(period?.start)
  const end = new Date(period?.end)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw availabilityError(managers, 'Hiring manager availability service returned an invalid busy period.', 'hm_availability_invalid_response')
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

function availabilityError(managers, message, code) {
  return new HiringManagerAvailabilityError(message, {
    code,
    managerNames: managers.map((manager) => manager.name || manager.email),
  })
}

function managerFailureMessage(managers) {
  return `Could not verify availability for ${managers.map((manager) => manager.name || manager.email).join(', ')}.`
}

function cleanServiceError(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

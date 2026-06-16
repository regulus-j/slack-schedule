import { readAppsScriptJson } from './apps-script-response.js'

export async function fetchRecruiterPhoneRows({ config, logger }) {
  const url = config?.recruiterPhoneExport?.url
  const token = config?.recruiterPhoneExport?.token
  if (!url || !token) {
    logger.info('recruiter_phone_export_skipped', { configured: false })
    return []
  }

  const requestUrl = new URL(url)
  requestUrl.searchParams.set('token', token)
  if (config.recruiterPhoneExport.fileId) requestUrl.searchParams.set('fileId', config.recruiterPhoneExport.fileId)
  if (config.recruiterPhoneExport.sheetName) requestUrl.searchParams.set('sheetName', config.recruiterPhoneExport.sheetName)

  try {
    const response = await fetch(requestUrl)
    if (!response.ok) {
      logger.warn('recruiter_phone_export_http_error', { status: response.status })
      return []
    }

    const parsed = await readAppsScriptJson(response)
    if (parsed.error) {
      logger.warn('recruiter_phone_export_invalid_response', {
        contentType: parsed.contentType,
        error: parsed.error,
      })
      return []
    }
    const payload = parsed.payload
    const rowsPayload = extractRowsPayload(payload)
    if (!Array.isArray(rowsPayload)) {
      logger.warn('recruiter_phone_export_invalid_payload', {
        ok: payload?.ok,
        hasRows: Array.isArray(payload?.rows),
        hasArrayPayload: Array.isArray(payload),
        error: payload?.error || '',
      })
      return []
    }

    const rows = rowsPayload.map(normalizeRecruiterPhoneRow).filter(Boolean)
    logger.info('recruiter_phone_export_loaded', { count: rows.length })
    return rows
  } catch (error) {
    logger.warn('recruiter_phone_export_failed', { error: error.message })
    return []
  }
}

function extractRowsPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.rows)) return payload.rows
  return null
}

export function normalizeRecruiterPhoneRow(row) {
  const firstName = firstClean(row, ['First Name', 'Given Name'])
  const lastName = firstClean(row, ['Last Name', 'Surname', 'Family Name'])
  const preferredName = firstClean(row, ['Preferred Name', 'PreferredName', 'Nickname'])
  const designation = firstClean(row, ['Designation', 'Position Title', 'Job Title', 'Title'])
  const phone = firstClean(row, [
    'Aircall',
    'Aircall Number',
    'Aircall/Mobile',
    'Mobile',
    'Mobile Number',
    'Phone',
    'Phone Number',
  ])
  const email = normalizeEmail(firstClean(row, [
    'Work Email',
    'Work Email Address',
    'Email',
    'Email Address',
  ]))
  const zoomLink = firstClean(row, [
    'Personal Zoom Link',
    'Zoom Link',
    'Personal Zoom',
    'Zoom URL',
  ])
  const legalName = [firstName, lastName].filter(Boolean).join(' ').trim()
  const displayName = [preferredName || firstName, lastName].filter(Boolean).join(' ').trim() || legalName

  if (!legalName && !email) return null
  return {
    firstName,
    lastName,
    preferredName,
    name: displayName,
    legalName,
    designation,
    phone,
    email,
    zoomLink,
  }
}

export function mergeRecruiterPhones(recruiters, phoneRows) {
  return recruiters.map((recruiter) => {
    const match = phoneRows.find((row) => personIdentityMatches(row, recruiter))
    if (!match) return recruiter
    return {
      ...recruiter,
      legalName: recruiter.legalName || match.legalName || '',
      preferredName: recruiter.preferredName || match.preferredName || '',
      phone: match.phone || recruiter.phone || '',
      zoomLink: match.zoomLink || recruiter.zoomLink || '',
      positionTitle: recruiter.positionTitle || match.designation || '',
    }
  })
}

export function recruiterRowsToPeople(phoneRows) {
  return phoneRows.map((row) => ({
    id: `sheet-rec-${stableId(row.email || row.legalName || row.name)}`,
    name: row.name || row.legalName || row.email,
    legalName: row.legalName || '',
    preferredName: row.preferredName || '',
    email: row.email || '',
    role: 'recruiter',
    slackUserId: '',
    positionTitle: row.designation || '',
    department: 'Recruitment',
    phone: row.phone || '',
    zoomLink: row.zoomLink || '',
    source: 'google_apps_script',
  }))
}

export function recruiterPhoneLine(recruiter) {
  const name = clean(recruiter?.name)
  const phone = cleanPhone(recruiter?.phone)
  return name && phone ? `${name}: ${phone}` : ''
}

export function personIdentityMatches(person, identity = {}) {
  const expectedEmail = normalizeEmail(identity.email)
  const personEmails = uniqueNormalized([
    person?.email,
    ...(Array.isArray(person?.emailAliases) ? person.emailAliases : []),
  ], normalizeEmail)
  if (expectedEmail && personEmails.includes(expectedEmail)) return true

  const expectedNames = identityNames(identity)
  const personNames = identityNames(person)
  if (expectedNames.some((name) => personNames.includes(name))) return true

  const expectedMailbox = emailMailbox(expectedEmail)
  return Boolean(
    expectedMailbox &&
    expectedMailbox.length >= 10 &&
    !GENERIC_MAILBOXES.has(expectedMailbox) &&
    personEmails.some((email) => emailMailbox(email) === expectedMailbox),
  )
}

function normalizeName(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function firstClean(row, keys) {
  const aliases = new Set(keys.map(normalizeHeader))
  for (const [key, rawValue] of Object.entries(row || {})) {
    if (!aliases.has(normalizeHeader(key))) continue
    const value = clean(rawValue)
    if (value) return value
  }
  return ''
}

function normalizeHeader(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function normalizeEmail(value) {
  const text = clean(value).toLowerCase()
  const match = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/)
  return match?.[0] || text
}

function identityNames(person) {
  return uniqueNormalized([
    person?.name,
    person?.legalName,
    person?.preferredName,
    ...(Array.isArray(person?.nameAliases) ? person.nameAliases : []),
  ], normalizeName)
}

function uniqueNormalized(values, normalize) {
  return [...new Set(values.map(normalize).filter(Boolean))]
}

function emailMailbox(value) {
  return normalizeEmail(value).split('@')[0] || ''
}

function cleanPhone(value) {
  const cleaned = clean(value)
  return cleaned === '-' ? '' : cleaned
}

const GENERIC_MAILBOXES = new Set([
  'admin',
  'careers',
  'hello',
  'hr',
  'info',
  'recruitment',
  'support',
  'talent',
])

function stableId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

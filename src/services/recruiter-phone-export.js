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
  const byEmail = new Map()
  const byName = new Map()

  for (const row of phoneRows) {
    if (row.email) byEmail.set(normalizeEmail(row.email), row)
    if (row.legalName) byName.set(normalizeName(row.legalName), row)
    if (row.name) byName.set(normalizeName(row.name), row)
  }

  return recruiters.map((recruiter) => {
    const match = byEmail.get(normalizeEmail(recruiter.email)) || byName.get(normalizeName(recruiter.name))
    if (!match) return recruiter
    return {
      ...recruiter,
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

function normalizeName(value) {
  return clean(value).toLowerCase()
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

function cleanPhone(value) {
  const cleaned = clean(value)
  return cleaned === '-' ? '' : cleaned
}

function stableId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

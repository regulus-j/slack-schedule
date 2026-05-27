export async function fetchRecruiterPhoneRows({ config, logger }) {
  const url = config?.recruiterPhoneExport?.url
  const token = config?.recruiterPhoneExport?.token
  if (!url || !token) {
    logger.info('recruiter_phone_export_skipped', { configured: false })
    return []
  }

  const requestUrl = new URL(url)
  requestUrl.searchParams.set('token', token)

  try {
    const response = await fetch(requestUrl)
    if (!response.ok) {
      logger.warn('recruiter_phone_export_http_error', { status: response.status })
      return []
    }

    const payload = await response.json()
    if (!payload?.ok || !Array.isArray(payload.rows)) {
      logger.warn('recruiter_phone_export_invalid_payload', { ok: payload?.ok, hasRows: Array.isArray(payload?.rows) })
      return []
    }

    const rows = payload.rows.map(normalizeRecruiterPhoneRow).filter(Boolean)
    logger.info('recruiter_phone_export_loaded', { count: rows.length })
    return rows
  } catch (error) {
    logger.warn('recruiter_phone_export_failed', { error: error.message })
    return []
  }
}

export function normalizeRecruiterPhoneRow(row) {
  const firstName = clean(row['First Name'])
  const lastName = clean(row['Last Name'])
  const preferredName = clean(row['Preferred Name'])
  const designation = clean(row.Designation)
  const phone = clean(row['Aircall '])
  const email = clean(row['Work Email']).toLowerCase()
  const zoomLink = clean(row['Personal Zoom Link'])
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
    if (row.email) byEmail.set(row.email, row)
    if (row.legalName) byName.set(normalizeName(row.legalName), row)
    if (row.name) byName.set(normalizeName(row.name), row)
  }

  return recruiters.map((recruiter) => {
    const match = byEmail.get(clean(recruiter.email).toLowerCase()) || byName.get(normalizeName(recruiter.name))
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

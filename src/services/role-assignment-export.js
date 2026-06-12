import { readAppsScriptJson } from './apps-script-response.js'

export async function fetchRoleAssignmentRows({ config, logger }) {
  const url = config?.roleAssignmentExport?.url
  const token = config?.roleAssignmentExport?.token
  if (!url || !token) {
    logger.info('role_assignment_export_skipped', { configured: false })
    return []
  }

  const requestUrl = new URL(url)
  requestUrl.searchParams.set('token', token)
  if (config.roleAssignmentExport.fileId) requestUrl.searchParams.set('fileId', config.roleAssignmentExport.fileId)
  if (config.roleAssignmentExport.sheetName) requestUrl.searchParams.set('sheetName', config.roleAssignmentExport.sheetName)
  if (config.roleAssignmentExport.sheetGid) requestUrl.searchParams.set('gid', config.roleAssignmentExport.sheetGid)

  try {
    const response = await fetch(requestUrl)
    if (!response.ok) {
      logger.warn('role_assignment_export_http_error', { status: response.status })
      return []
    }

    const parsed = await readAppsScriptJson(response)
    if (parsed.error) {
      logger.warn('role_assignment_export_invalid_response', {
        contentType: parsed.contentType,
        error: parsed.error,
      })
      return []
    }
    const payload = parsed.payload
    const rowsPayload = extractRowsPayload(payload)
    if (!Array.isArray(rowsPayload)) {
      logger.warn('role_assignment_export_invalid_payload', {
        ok: payload?.ok,
        hasRows: Array.isArray(payload?.rows),
        hasArrayPayload: Array.isArray(payload),
        error: payload?.error || '',
      })
      return []
    }

    const rows = normalizeRoleAssignmentRows(rowsPayload)
    logger.info('role_assignment_export_loaded', { count: rows.length })
    return rows
  } catch (error) {
    logger.warn('role_assignment_export_failed', { error: error.message })
    return []
  }
}

export function normalizeRoleAssignmentRow(row) {
  const roleId = firstClean(row, [
    'JazzHR Job ID',
    'JazzHR Role ID',
    'Job ID',
    'Job Id',
    'Role ID',
    'Role Id',
    'Position ID',
    'Posting ID',
  ])
  const roleTitle = firstClean(row, [
    '4',
    'JazzHR Job Title',
    'Job Title',
    'Role Title',
    'Role',
    'Position',
    'Position Title',
    'Open Role',
  ])
  const status = firstClean(row, ['Status', 'Job Status', 'Role Status', 'Opening Status', 'Recruiters  to manage', 'Recruiters to manage'])
  const recruiterName = firstClean(row, [
    'Recruiter',
    'Recruiter Name',
    'Assigned Recruiter',
    'Talent Recruiter',
  ])
  const recruiterEmail = firstClean(row, [
    'Recruiter Email',
    'Recruiter Work Email',
    'Recruiter Email Address',
    'Talent Recruiter Email',
  ]).toLowerCase()
  const hiringManagerName = firstClean(row, [
    'For Automation',
    'Hiring Manager',
    'Hiring Manager Name',
    'HM',
    'HM Name',
    'Manager',
  ])
  const hiringManagerEmail = firstClean(row, [
    'Hiring Manager Email',
    'HM Email',
    'HM Work Email',
    'Manager Email',
  ]).toLowerCase()

  if (!roleId && !roleTitle) return null

  return {
    roleId,
    roleTitle,
    roleKey: stableId(roleId || roleTitle),
    status,
    recruiterName,
    recruiterEmail,
    hiringManagerName,
    hiringManagerEmail,
  }
}

export function normalizeRoleAssignmentRows(rows) {
  const normalized = []
  let sectionStatus = ''

  for (const row of Array.isArray(rows) ? rows : []) {
    const base = normalizeRoleAssignmentRow(row)
    if (!base) continue

    const titleKey = clean(base.roleTitle).toLowerCase()
    if (isSectionLabel(titleKey)) {
      sectionStatus = titleKey
      continue
    }

    if (sectionStatus && CLOSED_SECTION_TERMS.some((term) => sectionStatus.includes(term))) {
      base.status = [base.status, sectionStatus].filter(Boolean).join(' ')
    }

    const hiringManagerNames = splitPeople(base.hiringManagerName).filter(isLikelyPersonName)
    if (hiringManagerNames.length === 0) {
      normalized.push({
        ...base,
        hiringManagerName: '',
      })
      continue
    }

    for (const name of hiringManagerNames) {
      normalized.push({
        ...base,
        hiringManagerName: name,
        hiringManagerEmail: '',
      })
    }
  }

  return normalized.filter((row) => row.roleTitle)
}

export function resolveRoleAssignments(rows, { recruiters = [], hiringManagers = [] } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const normalized = row?.roleKey ? row : normalizeRoleAssignmentRow(row)
      if (!normalized || !isOpenRoleStatus(normalized.status)) return null
      return {
        ...normalized,
        recruiter: resolvePerson({
          name: normalized.recruiterName,
          email: normalized.recruiterEmail,
          role: 'recruiter',
          prefix: 'sheet-role-rec',
          people: recruiters,
        }),
        hiringManager: resolvePerson({
          name: normalized.hiringManagerName,
          email: normalized.hiringManagerEmail,
          role: 'hiring_manager',
          prefix: 'sheet-role-hm',
          people: hiringManagers,
        }),
      }
    })
    .filter(Boolean)
}

export function isOpenRoleStatus(status) {
  const value = clean(status).toLowerCase()
  if (!value) return true
  return !CLOSED_STATUS_TERMS.some((term) => value.includes(term))
}

function resolvePerson({ name, email, role, prefix, people }) {
  const normalizedEmail = clean(email).toLowerCase()
  const normalizedName = normalizeName(name)
  const matched = people.find((person) =>
    normalizedEmail
      ? clean(person.email).toLowerCase() === normalizedEmail
      : normalizeName(person.name) === normalizedName
  )
  if (matched) return { ...matched, role }
  if (!normalizedEmail && !normalizedName) return null

  return {
    id: `${prefix}-${stableId(normalizedEmail || normalizedName)}`,
    name: clean(name) || normalizedEmail,
    email: normalizedEmail,
    role,
    slackUserId: '',
    source: 'role_assignment_sheet',
  }
}

function extractRowsPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.rows)) return payload.rows
  return null
}

function firstClean(row, keys) {
  for (const key of keys) {
    const value = clean(row?.[key])
    if (value) return value
  }
  return ''
}

function normalizeName(value) {
  return clean(value).toLowerCase()
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function splitPeople(value) {
  return clean(value)
    .split(/[,;\n]+/)
    .map(clean)
    .filter(Boolean)
}

function isSectionLabel(value) {
  return value === 'open roles' ||
    value.includes('closed') ||
    value.includes('hold') ||
    value.includes('cancelled') ||
    value.includes('canceled')
}

function isLikelyPersonName(value) {
  const text = clean(value)
  if (!text) return false
  const lower = text.toLowerCase()
  if (['second/final interviewer', 'cancelled', 'canceled'].includes(lower)) return false
  if (lower.includes('job letter') || lower.includes('replacement') || lower.includes('replcement')) return false
  if (/\d/.test(text)) return false
  return text.split(/\s+/).length >= 2
}

function stableId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

const CLOSED_STATUS_TERMS = [
  'closed',
  'hold',
  'filled',
  'cancelled',
  'canceled',
  'inactive',
  'archived',
  'deleted',
]

const CLOSED_SECTION_TERMS = [
  'closed',
  'hold',
  'cancelled',
  'canceled',
]

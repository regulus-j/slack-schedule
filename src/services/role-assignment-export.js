import { readAppsScriptJson } from './apps-script-response.js'
import { personIdentityMatches } from './recruiter-phone-export.js'

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
  const recruiterName = allClean(row, [
    'Recruiter',
    'Recruiters',
    'Recruiter(s)',
    'Recruiter Name',
    'Recruiter Names',
    'Assigned Recruiter',
    'Assigned Recruiters',
    'Talent Recruiter',
  ]).join('\n')
  const recruiterEmail = normalizeEmailList(allClean(row, [
    'Recruiter Email',
    'Recruiter Emails',
    'Recruiter Email(s)',
    'Recruiter Work Email',
    'Recruiter Work Emails',
    'Recruiter Email Address',
    'Recruiter Email Addresses',
    'Talent Recruiter Email',
  ]).join('\n'))
  const hiringManagerName = allClean(row, [
    'For Automation',
    'Hiring Manager',
    'Hiring Managers',
    'Hiring Manager(s)',
    'Hiring Manager Name',
    'Hiring Manager Names',
    'HM',
    'HM Name',
    'HM Names',
    'Manager',
    'Second/Final Interviewer',
    'Second/Final Interviewers',
  ]).join('\n')
  const hiringManagerEmail = normalizeEmailList(allClean(row, [
    'Hiring Manager Email',
    'Hiring Manager Emails',
    'Hiring Manager Email(s)',
    'HM Email',
    'HM Emails',
    'HM Work Email',
    'HM Work Emails',
    'Manager Email',
    'Manager Emails',
  ]).join('\n'))

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

    const recruiters = splitPersonReferences(base.recruiterName, base.recruiterEmail)
    const hiringManagers = splitPersonReferences(
      base.hiringManagerName,
      base.hiringManagerEmail,
      { filterName: isLikelyPersonName },
    )
    const count = Math.max(recruiters.length, hiringManagers.length, 1)

    for (let index = 0; index < count; index += 1) {
      const recruiter = recruiters[index] || {}
      const hiringManager = hiringManagers[index] || {}
      normalized.push({
        ...base,
        recruiterName: recruiter.name || '',
        recruiterEmail: recruiter.email || '',
        hiringManagerName: hiringManager.name || '',
        hiringManagerEmail: hiringManager.email || '',
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
  const normalizedEmail = normalizeEmail(email)
  const normalizedName = normalizeName(name)
  const matched = people.find((person) => personIdentityMatches(person, {
    name: normalizedName,
    email: normalizedEmail,
  }))
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
  const values = allClean(row, keys)
  return values[0] || ''
}

function allClean(row, keys) {
  const aliases = new Set(keys.map(normalizeHeader))
  const values = []

  for (const [key, rawValue] of Object.entries(row || {})) {
    const normalizedKey = normalizeHeader(key)
    const matches = aliases.has(normalizedKey) ||
      [...aliases].some((alias) => normalizedKey.startsWith(alias) && /^\d+$/.test(normalizedKey.slice(alias.length)))
    if (!matches) continue
    const value = clean(rawValue)
    if (value && !values.includes(value)) values.push(value)
  }

  return values
}

function normalizeHeader(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function splitPersonReferences(nameValue, emailValue, { filterName = Boolean } = {}) {
  const names = splitPeople(nameValue)
    .map(stripEmailFromName)
    .filter(filterName)
  const emails = uniqueValues([
    ...extractEmails(emailValue),
    ...extractEmails(nameValue),
  ])
  const count = Math.max(names.length, emails.length)

  return Array.from({ length: count }, (_, index) => ({
    name: names[index] || '',
    email: emails[index] || '',
  }))
}

function stripEmailFromName(value) {
  return clean(value)
    .replace(EMAIL_PATTERN, ' ')
    .replace(/[<>()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[-,:;]+$/g, '')
    .trim()
}

function normalizeEmailList(value) {
  return extractEmails(value).join('\n')
}

function extractEmails(value) {
  const matches = String(value || '').match(EMAIL_PATTERN) || []
  return uniqueValues(matches.map(normalizeEmail).filter(Boolean))
}

function normalizeEmail(value) {
  const text = clean(value).toLowerCase()
  const match = text.match(EMAIL_PATTERN)
  return match?.[0] || text
}

function uniqueValues(values) {
  return [...new Set(values)]
}

function normalizeName(value) {
  return clean(value).toLowerCase()
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function splitPeople(value) {
  return clean(value)
    .split(/[,;\n|]+|\s+(?:&|and|\/)\s+/i)
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
  if ([
    'second/final interviewer',
    'cancelled',
    'canceled',
    'tba',
    'tbc',
    'n/a',
    'na',
    'none',
    'to be confirmed',
  ].includes(lower)) return false
  if (lower.includes('job letter') || lower.includes('replacement') || lower.includes('replcement')) return false
  if (/\d/.test(text)) return false
  return /[a-z]/i.test(text)
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

const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi

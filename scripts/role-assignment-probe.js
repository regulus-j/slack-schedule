// Probe script: fetch and trace role assignment data through the full pipeline.
// Run: node scripts/role-assignment-probe.js

import { fetchRoleAssignmentRows, normalizeRoleAssignmentRows, resolveRoleAssignments } from '../src/services/role-assignment-export.js'
import { matchRoleAssignments, normalizeRoleTitle } from '../src/workflow/role-assignment-matcher.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

function envValue(name) {
  // Check direct env var first, then *_FILE secret mount
  const direct = process.env[name]
  if (direct) return direct
  try {
    // Synchronous fallback for file-based secrets (not used in probe, but documented)
  } catch {}
  return null
}

async function loadConfig() {
  // Try reading from .env file for local dev
  let envVars = {}
  try {
    const envPath = path.join(process.cwd(), '.env')
    const content = await readFile(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (!envVars[key]) envVars[key] = value
    }
  } catch {}

  // Override with actual process.env
  for (const [k, v] of Object.entries(process.env)) {
    if (v) envVars[k] = v
  }

  return {
    roleAssignmentExport: {
      url: envVars['ROLE_ASSIGNMENT_EXPORT_URL'] || envVars['RECRUITER_PHONE_EXPORT_URL'] || null,
      token: envVars['ROLE_ASSIGNMENT_EXPORT_TOKEN'] || envVars['RECRUITER_PHONE_EXPORT_TOKEN'] || null,
      fileId: envVars['ROLE_ASSIGNMENT_EXPORT_FILE_ID'] || null,
      sheetName: envVars['ROLE_ASSIGNMENT_EXPORT_SHEET_NAME'] || null,
      sheetGid: envVars['ROLE_ASSIGNMENT_EXPORT_SHEET_GID'] || null,
    },
  }
}

const logger = {
  info(event, details) {
    console.log(JSON.stringify({ level: 'info', event, ...(details || {}) }, null, 2))
  },
  warn(event, details) {
    console.log(JSON.stringify({ level: 'warn', event, ...(details || {}) }, null, 2))
  },
}

const config = await loadConfig()

console.log('=== Config ===')
console.log('URL:', config.roleAssignmentExport.url ? 'configured' : 'MISSING')
console.log('Token:', config.roleAssignmentExport.token ? 'configured' : 'MISSING')
console.log('File ID:', config.roleAssignmentExport.fileId || 'MISSING')
console.log('Sheet GID:', config.roleAssignmentExport.sheetGid || 'MISSING')

if (!config.roleAssignmentExport.url || !config.roleAssignmentExport.token) {
  console.log('\nERROR: ROLE_ASSIGNMENT_EXPORT_URL and TOKEN must be set in .env or environment.')
  process.exit(1)
}

// ── Stage 1: Fetch raw rows ──
console.log('\n=== Stage 1: Raw rows from Apps Script ===')

// First, make a direct HTTP call to see the raw response
const url = new URL(config.roleAssignmentExport.url)
url.searchParams.set('token', config.roleAssignmentExport.token)
if (config.roleAssignmentExport.fileId) url.searchParams.set('fileId', config.roleAssignmentExport.fileId)
if (config.roleAssignmentExport.sheetName) url.searchParams.set('sheetName', config.roleAssignmentExport.sheetName)
if (config.roleAssignmentExport.sheetGid) url.searchParams.set('gid', config.roleAssignmentExport.sheetGid)

console.log('Request URL:', url.toString().replace(config.roleAssignmentExport.token, '[REDACTED]'))
const response = await fetch(url)
console.log('HTTP status:', response.status)
console.log('Content-Type:', response.headers.get('content-type'))

const rawText = await response.text()
console.log('Response length:', rawText.length, 'chars')
console.log('First 500 chars:', rawText.slice(0, 500))

let parsed
try {
  parsed = JSON.parse(rawText)
  console.log('\nParsed JSON keys:', Object.keys(parsed))
  console.log('ok:', parsed.ok)
  console.log('count:', parsed.count)
  console.log('rows type:', typeof parsed.rows, Array.isArray(parsed.rows) ? `array(${parsed.rows.length})` : 'not array')
  if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
    console.log('First row keys:', Object.keys(parsed.rows[0]))
    console.log('First row:', JSON.stringify(parsed.rows[0]).slice(0, 300))
  }
} catch (e) {
  console.log('JSON parse error:', e.message)
}

const rawRows = await fetchRoleAssignmentRows({ config, logger })
console.log('\nfetchRoleAssignmentRows count:', rawRows.length)

// Show what normalizeRoleAssignmentRow does with first few rows
console.log('\n=== Testing normalizeRoleAssignmentRow on first 5 rows ===')
for (let i = 0; i < Math.min(5, parsed.rows.length); i++) {
  const row = parsed.rows[i]
  const normalized = (await import('../src/services/role-assignment-export.js')).normalizeRoleAssignmentRow(row)
  console.log(`\nRow ${i + 1}:`)
  console.log(`  Keys: ${Object.keys(row).filter(k => row[k])}`)
  console.log(`  "Column A" value: "${row['Column A'] || ''}"`)
  console.log(`  "Column B" value: "${row['Column B'] || ''}"`)
  console.log(`  normalizeRoleAssignmentRow result: ${normalized ? JSON.stringify({roleId: normalized.roleId, roleTitle: normalized.roleTitle, status: normalized.status, recruiterName: normalized.recruiterName, hiringManagerName: normalized.hiringManagerName}) : 'NULL (skipped)'}`)
}

// Now test: what if we treat "Column A" as the role title column?
console.log('\n=== Manual role title extraction from "Column A" ===')
const mockRows = parsed.rows.map(r => ({ ...r, '4': r['Column A'] }))
const mockNormalized = normalizeRoleAssignmentRows(mockRows)
console.log('With "Column A" → "4" mapping, normalized count:', mockNormalized.length)
const hrMock = mockNormalized.filter(r => {
  const t = (r.roleTitle || '').toLowerCase()
  return t.includes('hr') || t.includes('engagement') || t.includes('intern')
})
console.log('HR/Engagement/Intern rows:', hrMock.length)
hrMock.forEach(r => {
  console.log(`  title: "${r.roleTitle}"`)
  console.log(`  recruiter: "${r.recruiterName}"`)
  console.log(`  HM: "${r.hiringManagerName}"`)
})

if (rawRows.length === 0) {
  console.log('No rows returned. Check URL, token, and fileId.')
  process.exit(1)
}

// Show all unique role titles from the raw data
const rawTitles = rawRows.map(r => r.roleTitle || r['Job Title'] || r['Role Title'] || r['Role'] || r['4'] || '').filter(Boolean)
console.log('\nAll raw role titles:')
rawTitles.forEach((t, i) => console.log(`  ${i + 1}. "${t}"`))

// Find HR Engagement Intern specifically
console.log('\nSearching for "HR" or "Engagement" or "Intern" in raw rows:')
const hrRows = rawRows.filter(r => {
  const haystack = JSON.stringify(r).toLowerCase()
  return haystack.includes('hr') || haystack.includes('engagement') || haystack.includes('intern')
})
if (hrRows.length === 0) {
  console.log('  NONE FOUND — the role does not exist in the sheet at all')
} else {
  hrRows.forEach((r, i) => {
    console.log(`\n  Row ${i + 1}:`)
    // Show all non-empty keys for this row
    for (const [k, v] of Object.entries(r)) {
      if (v) console.log(`    ${k}: ${String(v).slice(0, 120)}`)
    }
  })
}

// ── Stage 2: Normalize ──
console.log('\n=== Stage 2: normalizeRoleAssignmentRows ===')
const normalized = normalizeRoleAssignmentRows(rawRows)
console.log('Normalized row count:', normalized.length)
console.log('Normalized titles:')
normalized.forEach((r, i) => console.log(`  ${i + 1}. "${r.roleTitle}" | status: "${r.status}" | recruiter: "${r.recruiterName}" | HM: "${r.hiringManagerName}"`))

// Check if HR Engagement Intern survived
const hrNormalized = normalized.filter(r => {
  const t = (r.roleTitle || '').toLowerCase()
  return t.includes('hr') || t.includes('engagement') || t.includes('intern')
})
console.log('\nHR/Engagement/Intern in normalized:', hrNormalized.length, 'rows')
hrNormalized.forEach(r => {
  console.log(`  title: "${r.roleTitle}"`)
  console.log(`  status: "${r.status}"`)
  console.log(`  recruiterName: "${r.recruiterName}"`)
  console.log(`  recruiterEmail: "${r.recruiterEmail}"`)
  console.log(`  hiringManagerName: "${r.hiringManagerName}"`)
  console.log(`  hiringManagerEmail: "${r.hiringManagerEmail}"`)
})

// ── Stage 3: Resolve ──
console.log('\n=== Stage 3: resolveRoleAssignments (with empty people — sheet fallback IDs) ===')
const resolved = resolveRoleAssignments(normalized, { recruiters: [], hiringManagers: [] })
console.log('Resolved count:', resolved.length)
const hrResolved = resolved.filter(r => {
  const t = (r.roleTitle || '').toLowerCase()
  return t.includes('hr') || t.includes('engagement') || t.includes('intern')
})
console.log('HR/Engagement/Intern in resolved:', hrResolved.length, 'rows')
hrResolved.forEach(r => {
  console.log(`  title: "${r.roleTitle}"`)
  console.log(`  status: "${r.status}"`)
  console.log(`  recruiter: ${r.recruiter?.name || 'null'} (${r.recruiter?.email || 'no email'}) [id: ${r.recruiter?.id || 'none'}]`)
  console.log(`  hiringManager: ${r.hiringManager?.name || 'null'} (${r.hiringManager?.email || 'no email'}) [id: ${r.hiringManager?.id || 'none'}]`)
})

// ── Stage 4: Match against a simulated JazzHR role ──
console.log('\n=== Stage 4: matchRoleAssignments ===')
// Try matching with the normalized title
const resolvedTitles = resolved.map(r => r.roleTitle).filter(Boolean)
console.log('All resolved titles for matching:')
resolvedTitles.forEach((t, i) => console.log(`  ${i + 1}. "${t}" -> normalized: "${normalizeRoleTitle(t)}"`))

// Find any title that looks like HR Engagement Intern
const candidate = resolved.find(r => {
  const n = normalizeRoleTitle(r.roleTitle || '')
  return n.includes('hr') && n.includes('engagement') && n.includes('intern')
})

if (candidate) {
  console.log('\nFound candidate matching "HR Engagement Intern":')
  console.log(`  Raw title: "${candidate.roleTitle}"`)
  console.log(`  Normalized: "${normalizeRoleTitle(candidate.roleTitle)}"`)
  console.log(`  Recruiter: ${candidate.recruiter?.name || 'NONE'}`)
  console.log(`  HM: ${candidate.hiringManager?.name || 'NONE'}`)
} else {
  console.log('\nNo resolved assignment normalizes to "hr engagement intern".')
  console.log('This means the role title in the sheet differs from the JazzHR title.')
  console.log('\nTrying fuzzy match for each resolved title against "HR - Engagement Intern":')
  const jazzhrTitle = 'HR - Engagement Intern'
  const jazzhrNormalized = normalizeRoleTitle(jazzhrTitle)
  console.log(`  JazzHR title: "${jazzhrTitle}" -> "${jazzhrNormalized}"`)
  for (const r of resolved) {
    const rn = normalizeRoleTitle(r.roleTitle)
    // Simulate what matchRoleAssignments does for fuzzy matching
    const { roleTitleSimilarity } = await import('../src/workflow/role-assignment-matcher.js')
    const conf = roleTitleSimilarity(jazzhrNormalized, rn)
    if (conf > 0.4) {
      console.log(`  "${r.roleTitle}" -> "${rn}" | confidence: ${conf} ${conf >= 0.72 ? 'WOULD MATCH' : 'BELOW THRESHOLD (0.72)'}`)
    }
  }
}

// ── Stage 5: Test with actual JazzHR role if available ──
console.log('\n=== Stage 5: Full matchRoleAssignments with simulated JazzHR role ===')
const testRole = {
  id: 'job_test_hr_intern',
  roleId: 'job_test_hr_intern',
  title: 'HR - Engagement Intern',
}

// Test various title variants
const variants = [
  'HR - Engagement Intern',
  'HR Engagement Intern',
  'Human Resources - Engagement Intern',
  'HR & Engagement Intern',
  'Engagement Intern - HR',
]
for (const variant of variants) {
  const role = { id: 'job_test', roleId: 'job_test', title: variant }
  const result = matchRoleAssignments(role, resolved)
  console.log(`  "${variant}" -> matchType: ${result.matchType}, confidence: ${result.confidence}, matchedTitle: "${result.matchedTitle}", assignments: ${result.assignments.length}`)
  if (result.assignments.length > 0) {
    for (const a of result.assignments) {
      console.log(`    recruiter: ${a.recruiter?.name || 'none'}, HM: ${a.hiringManager?.name || 'none'}`)
    }
  }
}

console.log('\n=== Done ===')

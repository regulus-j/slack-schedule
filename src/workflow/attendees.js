import crypto from 'node:crypto'
import { resolveStageRules } from './stage-rules.js'

function normalizeArray(value, label) {
  if (Array.isArray(value)) return value
  if (value) {
    console.warn('attendees_non_array', { field: label, type: typeof value })
  }
  return []
}

export function normalizeAttendees(caseRecord, stageRules) {
  const attendees = []

  const applicantName = [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName]
    .filter(Boolean)
    .join(' ')

  attendees.push({
    id: caseRecord.applicant?.id || `person-${crypto.randomUUID()}`,
    name: applicantName || 'Unknown Candidate',
    email: caseRecord.applicant?.email || '',
    role: 'candidate',
    required: true,
    included: true,
    slackUserId: null,
    source: 'case'
  })

  const recruiterId = caseRecord.recruiter?.id || caseRecord.ownerSlackUserId || `person-${crypto.randomUUID()}`
  attendees.push({
    id: recruiterId,
    name: caseRecord.recruiter?.name || 'Recruiter',
    email: caseRecord.recruiter?.email || '',
    role: 'recruiter',
    required: true,
    included: true,
    slackUserId: caseRecord.recruiter?.slackUserId || caseRecord.ownerSlackUserId || null,
    source: 'case'
  })

  const hm = caseRecord.hiringManager
  if (hm) {
    attendees.push({
      id: hm.id || `person-${crypto.randomUUID()}`,
      name: hm.name || hm.email || '',
      email: hm.email || '',
      role: 'hiring_manager',
      required: false,
      included: Boolean(caseRecord.attendanceOverrides?.hiringManagerIncluded),
      slackUserId: hm.slackUserId || null,
      source: 'case'
    })
  }

  const guests = normalizeArray(caseRecord.guests, 'guests')
  for (const guest of guests) {
    const guestObj = typeof guest === 'string' ? { email: guest, name: guest } : guest
    attendees.push({
      id: guestObj.id || `guest-${crypto.randomUUID()}`,
      name: guestObj.name || guestObj.email || '',
      email: guestObj.email || '',
      role: 'guest',
      required: false,
      included: true,
      slackUserId: guestObj.slackUserId || null,
      source: 'manual'
    })
  }

  const externalAttendees = normalizeArray(caseRecord.externalAttendees, 'externalAttendees')
  for (const ext of externalAttendees) {
    attendees.push({
      id: ext.id || `ext-${crypto.randomUUID()}`,
      name: ext.name || ext.email || '',
      email: ext.email || '',
      role: ext.role || 'external',
      required: ext.required || false,
      included: ext.included !== undefined ? Boolean(ext.included) : true,
      slackUserId: null,
      source: 'external'
    })
  }

  for (const [key, value] of Object.entries(caseRecord.attendanceOverrides || {})) {
    const target = attendees.find((a) => a.id === key || a.email === key || a.role === key)
    if (target) {
      if (typeof value === 'boolean') {
        target.included = value
      } else if (typeof value === 'object' && value !== null) {
        if (value.included !== undefined) target.included = value.included
      }
    }
  }

  const interviewerCount = attendees.filter((a) =>
    (a.role === 'recruiter' || a.role === 'hiring_manager' || a.role === 'guest') && a.included
  ).length
  if (interviewerCount === 0) {
    const hmAttendee = attendees.find((a) => a.role === 'hiring_manager')
    if (hmAttendee) {
      hmAttendee.included = true
    }
  }

  return attendees
}

export function refreshAttendees(caseRecord, stageKey, stageOverrides, attendanceOverrides) {
  const stageRules = resolveStageRules(stageKey, stageOverrides)
  const updated = {
    ...caseRecord,
    stageOverrides: stageOverrides || caseRecord.stageOverrides || {},
    attendanceOverrides: attendanceOverrides || caseRecord.attendanceOverrides || {}
  }
  return normalizeAttendees(updated, stageRules)
}

export function includedAttendees(attendees) {
  return (attendees || []).filter((a) => a.included)
}

export function attendeesForFreeBusy(attendees) {
  return (attendees || [])
    .filter((a) => a.included && a.email)
    .map((a) => ({ id: a.email }))
}

export function validateAttendees(attendees) {
  const errors = []
  const seen = new Set()

  if (!attendees || attendees.length === 0) {
    errors.push('No attendees in the list')
    return { valid: false, errors }
  }

  for (const a of attendees) {
    if (!a.email) {
      errors.push(`Attendee "${a.name || a.id}" has no email address`)
    }
    if (a.email && seen.has(a.email.toLowerCase())) {
      errors.push(`Duplicate email: ${a.email}`)
    }
    if (a.email) seen.add(a.email.toLowerCase())
  }

  const candidate = attendees.find((a) => a.role === 'candidate')
  if (!candidate) {
    errors.push('No candidate in attendee list')
  } else if (!candidate.included) {
    errors.push('Candidate must be included in the interview')
  }

  const interviewers = attendees.filter((a) =>
    (a.role === 'recruiter' || a.role === 'hiring_manager' || a.role === 'guest') && a.included
  )
  if (interviewers.length === 0) {
    errors.push('At least one interviewer (recruiter or hiring manager) must be included')
  }

  return { valid: errors.length === 0, errors }
}

import crypto from 'node:crypto'
import { BUSINESS_DAY_START, BUSINESS_DAY_END, SYDNEY_TIME_ZONE, formatDateForInput, localDateTimeToUtc } from '../time.js'
import { checkFreeBusy } from '../services/google.js'
import { normalizeStageKey, resolveStageFromTemplate, resolveStageRules } from './stage-rules.js'
import { normalizeAttendees, includedAttendees, attendeesForFreeBusy } from './attendees.js'

function parseDateToLocalMidnight(dateStr, timeZone) {
  const [year, month, day] = String(dateStr || '').split('-').map((p) => Number(p))
  if (!year || !month || !day) throw new Error(`Invalid date: ${dateStr}`)
  const localMs = Date.UTC(year, month - 1, day, 0, 0, 0)
  const offsetMs = getTimeZoneOffsetMs(new Date(localMs), timeZone)
  return new Date(localMs - offsetMs)
}

function getTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts = formatter.formatToParts(date)
  const values = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  )
  return asUtc - date.getTime()
}

function getDayOfWeek(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
  const day = formatter.format(date)
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[day] ?? -1
}

function addDays(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function formatLocalDateTime(utcDate, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
  return formatter.format(utcDate)
}

function getLocalHour(utcDate, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false
  })
  return Number(formatter.format(utcDate))
}

function parseTimeToMinutes(timeStr) {
  const [hour, minute] = String(timeStr || '').split(':').map((p) => Number(p))
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  return hour * 60 + minute
}

function buildTimeOnDate(anchorDate, timeStr, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const dateStr = fmt.format(new Date(anchorDate))
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hour, minute] = timeStr.split(':').map(Number)
  const localMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offsetMs = getTimeZoneOffsetMs(new Date(localMs), timeZone)
  return new Date(localMs - offsetMs)
}

function hasOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB
}

function isoOrDateToIso(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toISOString()
}

// ─── Step 1: Generate Candidate Slots ────────────────────────────────────────

export function generateCandidateSlots({
  startDate,
  endDate,
  durationMinutes = 30,
  timeZone = SYDNEY_TIME_ZONE,
  businessStart = BUSINESS_DAY_START,
  businessEnd = BUSINESS_DAY_END
}) {
  const slots = []
  const durationMs = durationMinutes * 60 * 1000
  const businessStartMinutes = parseTimeToMinutes(businessStart)
  const businessEndMinutes = parseTimeToMinutes(businessEnd)
  if (businessStartMinutes === null || businessEndMinutes === null) return slots

  let cursor = parseDateToLocalMidnight(startDate, timeZone)
  const endCursor = parseDateToLocalMidnight(endDate, timeZone)
  const todayStr = formatDateForInput(new Date(), timeZone)
  const todayStart = parseDateToLocalMidnight(todayStr, timeZone)

  while (cursor <= endCursor) {
    if (cursor < todayStart) { cursor = addDays(cursor, 1); continue }
    const dow = getDayOfWeek(cursor, timeZone)
    const isWeekend = dow === 0 || dow === 6

    if (!isWeekend) {
      let slotMinutes = businessStartMinutes
      while (slotMinutes + durationMinutes <= businessEndMinutes) {
        const slotHour = Math.floor(slotMinutes / 60)
        const slotMin = slotMinutes % 60
        const timeStr = `${String(slotHour).padStart(2, '0')}:${String(slotMin).padStart(2, '0')}`

        const slotStart = buildTimeOnDate(cursor, timeStr, timeZone)
        const slotEnd = new Date(slotStart.getTime() + durationMs)

        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          score: 0,
          conflicts: {},
          allAvailable: true
        })

        slotMinutes += durationMinutes
      }
    }

    cursor = addDays(cursor, 1)
  }

  return slots
}

// ─── Step 2: Check Availability ──────────────────────────────────────────────

export async function checkAvailability({ caseRecord, config, logger, store }) {
  const included = includedAttendees(caseRecord.attendees || [])
  const calendarAttendees = attendeesForFreeBusy(included)

  if (calendarAttendees.length === 0) {
    logger.warn('scheduler_no_calendar_attendees', { caseId: caseRecord.id })
    return {
      busyByEmail: {},
      mocked: false,
      checkedAt: new Date().toISOString(),
      sources: [],
    }
  }

  const windowStart = caseRecord.interviewWindowStartDate || caseRecord.interviewWindowStart
  const windowEnd = caseRecord.interviewWindowEndDate || caseRecord.interviewWindowEnd
  const timeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE

  if (!windowStart || !windowEnd) {
    logger.warn('scheduler_no_window', { caseId: caseRecord.id })
    return { slots: [], checkedAt: new Date().toISOString() }
  }

  const windows = [{
    timeMin: localDateTimeToUtc(windowStart, '00:00', timeZone).toISOString(),
    timeMax: localDateTimeToUtc(windowEnd, '23:59', timeZone).toISOString()
  }]

  try {
    const recruiterId = caseRecord.ownerSlackUserId || caseRecord.recruiter?.slackUserId || caseRecord.recruiter?.id || null
    const freeBusyResult = await checkFreeBusy({
      config,
      logger,
      attendees: calendarAttendees,
      windows,
      store,
      recruiterId
    })

    const busyByEmail = {}
    if (!freeBusyResult.mocked && freeBusyResult.busy) {
      const calendars = freeBusyResult.busy
      for (const [email, calendar] of Object.entries(calendars)) {
        busyByEmail[email.toLowerCase()] = (calendar.busy || []).map((b) => ({
          start: isoOrDateToIso(b.start),
          end: isoOrDateToIso(b.end)
        }))
      }
    }

    if (freeBusyResult.mocked) {
      logger.warn('scheduler_availability_mocked', {
        caseId: caseRecord.id,
        attendeeCount: calendarAttendees.length
      })
    }

    return {
      busyByEmail,
      mocked: freeBusyResult.mocked || false,
      checkedAt: new Date().toISOString(),
      timeMin: windows[0].timeMin,
      timeMax: windows[0].timeMax,
      sources: ['google_oauth'],
    }
  } catch (error) {
    logger.warn('scheduler_freebusy_failed', { caseId: caseRecord.id, error: error.message })
    return {
      busyByEmail: {},
      mocked: true,
      error: error.message,
      checkedAt: new Date().toISOString(),
      timeMin: windows[0].timeMin,
      timeMax: windows[0].timeMax,
      sources: ['google_oauth'],
    }
  }
}

// ─── Step 3: Intersect Slots with Busy ────────────────────────────────────────

export function intersectSlotsWithBusy(slots, busyByEmail, attendees, bufferMinutes = 0) {
  const bufferMs = bufferMinutes * 60 * 1000

  return slots.map((slot) => {
    const slotStart = new Date(slot.start).getTime()
    const slotEnd = new Date(slot.end).getTime()
    const slotWithBuffer = {
      start: slotStart - bufferMs,
      end: slotEnd + bufferMs
    }

    const conflicts = {}
    let allAvailable = true

    for (const attendee of (attendees || [])) {
      if (!attendee.email || !attendee.included) continue
      const busyPeriods = busyByEmail[attendee.email] || []

      const overlapping = busyPeriods.filter((busy) => {
        const busyStart = new Date(busy.start).getTime()
        const busyEnd = new Date(busy.end).getTime()
        return hasOverlap(slotWithBuffer.start, slotWithBuffer.end, busyStart, busyEnd)
      })

      conflicts[attendee.email] = {
        hasConflict: overlapping.length > 0,
        overlappingEvents: overlapping
      }

      if (overlapping.length > 0) allAvailable = false
    }

    return {
      ...slot,
      conflicts,
      allAvailable
    }
  })
}

// ─── Step 4: Detect Conflicts ─────────────────────────────────────────────────

export function detectConflicts({
  proposedSlot,
  attendees,
  busyPeriods,
  existingCaseSchedules,
  bufferMinutes = 15,
  logger
}) {
  const conflicts = []
  const bufferMs = bufferMinutes * 60 * 1000
  const slotStart = new Date(proposedSlot.start).getTime()
  const slotEnd = new Date(proposedSlot.end).getTime()

  // 1. Time overlap with busy periods
  for (const attendee of (attendees || [])) {
    if (!attendee.email || !attendee.included) continue
    const busy = busyPeriods[attendee.email] || []

    for (const period of busy) {
      const bStart = new Date(period.start).getTime()
      const bEnd = new Date(period.end).getTime()

      if (hasOverlap(slotStart, slotEnd, bStart, bEnd)) {
        const timeRange = formatTimeRange(period.start, period.end)
        conflicts.push({
          type: 'overlap',
          attendeeEmail: attendee.email,
          attendeeName: attendee.name,
          message: `${attendee.name} (${formatRole(attendee.role)}) has a conflict ${timeRange}`,
          severity: attendee.required ? 'error' : 'warning'
        })
      }
    }
  }

  // 2. Double-booking check against existing case schedules
  for (const otherCase of (existingCaseSchedules || [])) {
    const otherSlot = otherCase.selectedSlot || otherCase.currentSchedule
    if (!otherSlot) continue

    const otherStart = otherSlot.start
      ? new Date(otherSlot.start).getTime()
      : new Date(`${otherSlot.date}T${otherSlot.time || '00:00'}:00`).getTime()
    const otherDuration = (otherCase.stageOverrides?.durationMinutes || 30) * 60 * 1000
    const otherEnd = otherSlot.end
      ? new Date(otherSlot.end).getTime()
      : otherStart + otherDuration

    if (hasOverlap(slotStart, slotEnd, otherStart, otherEnd)) {
      const otherAttendees = otherCase.attendees || []
      for (const attendee of (attendees || [])) {
        if (!attendee.email || !attendee.included) continue
        const otherMatch = otherAttendees.find((oa) =>
          oa.email?.toLowerCase() === attendee.email.toLowerCase() && oa.included
        )
        if (otherMatch) {
          const otherName = [otherCase.applicant?.firstName, otherCase.applicant?.lastName]
            .filter(Boolean).join(' ') || otherCase.id
          conflicts.push({
            type: 'double_booking',
            attendeeEmail: attendee.email,
            attendeeName: attendee.name,
            message: `${attendee.name} (${formatRole(attendee.role)}) is double-booked: Interview with ${otherName}`,
            severity: 'error'
          })
        }
      }
    }
  }

  // 3. Buffer violation
  for (const attendee of (attendees || [])) {
    if (!attendee.email || !attendee.included) continue
    const busy = busyPeriods[attendee.email] || []

    for (const period of busy) {
      const bStart = new Date(period.start).getTime()
      const bEnd = new Date(period.end).getTime()

      // Event ends within buffer before our slot
      const gapBefore = slotStart - bEnd
      if (gapBefore > 0 && gapBefore < bufferMs) {
        conflicts.push({
          type: 'buffer',
          attendeeEmail: attendee.email,
          attendeeName: attendee.name,
          message: `Only ${Math.round(gapBefore / 60000)} min buffer before ${attendee.name}'s next meeting`,
          severity: 'warning'
        })
      }

      // Event starts within buffer after our slot
      const gapAfter = bStart - slotEnd
      if (gapAfter > 0 && gapAfter < bufferMs) {
        conflicts.push({
          type: 'buffer',
          attendeeEmail: attendee.email,
          attendeeName: attendee.name,
          message: `Only ${Math.round(gapAfter / 60000)} min buffer after ${attendee.name}'s previous meeting`,
          severity: 'warning'
        })
      }
    }
  }

  // 4. Location conflict (same zoom/room)
  if (proposedSlot.zoomLink) {
    for (const otherCase of (existingCaseSchedules || [])) {
      const otherSlot = otherCase.selectedSlot || otherCase.currentSchedule
      if (!otherSlot) continue
      const otherZoom = otherSlot.zoomLink || otherCase.autofill?.zoomLink
      if (!otherZoom || otherZoom !== proposedSlot.zoomLink) continue

      const otherStart = new Date(otherSlot.start || `${otherSlot.date}T${otherSlot.time || '00:00'}:00`).getTime()
      const otherDuration = (otherCase.stageOverrides?.durationMinutes || 30) * 60 * 1000
      const otherEnd = otherSlot.end ? new Date(otherSlot.end).getTime() : otherStart + otherDuration

      if (hasOverlap(slotStart, slotEnd, otherStart, otherEnd)) {
        conflicts.push({
          type: 'location',
          attendeeEmail: '',
          attendeeName: '',
          message: `Zoom link ${otherZoom} is in use by another interview at this time`,
          severity: 'warning'
        })
      }
    }
  }

  return conflicts
}

// ─── Step 5: Rank Slots ──────────────────────────────────────────────────────

export function rankSlots(slots, timeZone = SYDNEY_TIME_ZONE) {
  return slots
    .map((slot) => {
      let score = 100

      const conflictCount = Object.values(slot.conflicts || {}).filter((c) => c.hasConflict).length
      score -= conflictCount * 10

      const localHour = getLocalHour(new Date(slot.start), timeZone)
      if (localHour >= 9 && localHour < 12) {
        score += 5
      }

      const hoursAfter9 = Math.max(0, localHour - 9)
      score -= hoursAfter9

      return { ...slot, score: Math.max(0, score) }
    })
    .sort((a, b) => b.score - a.score)
}

// ─── Step 6: Full Scheduling Pipeline ─────────────────────────────────────────

export async function runSchedulingPipeline({ caseRecord, config, logger, store }) {
  const warnings = []

  // 1. Resolve stage rules
  const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
  const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)

  // 2. Normalize attendees
  const allAttendees = caseRecord.attendees && caseRecord.attendees.length > 0
    ? caseRecord.attendees
    : normalizeAttendees(caseRecord, stageRules)
  const included = includedAttendees(allAttendees)

  if (included.length === 0) {
    return {
      available: [],
      conflicts: [],
      warnings: ['No attendees included. Toggle at least one attendee to check availability.'],
      stageRules,
      attendees: allAttendees
    }
  }

  // 3. Generate candidate slots
  const windowStart = caseRecord.interviewWindowStartDate || caseRecord.interviewWindowStart
  const windowEnd = caseRecord.interviewWindowEndDate || caseRecord.interviewWindowEnd
  const timeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE

  if (!windowStart || !windowEnd) {
    return {
      available: [],
      conflicts: [],
      warnings: ['No interview window set. Use manual entry or set a target window first.'],
      stageRules,
      attendees: allAttendees
    }
  }

  const slots = generateCandidateSlots({
    startDate: windowStart,
    endDate: windowEnd,
    durationMinutes: stageRules.typicalDurationMinutes,
    timeZone,
    businessStart: BUSINESS_DAY_START,
    businessEnd: BUSINESS_DAY_END
  })

  if (slots.length === 0) {
    return {
      available: [],
      conflicts: [],
      warnings: ['No business-hour slots in the selected window. Expand the date range.'],
      stageRules,
      attendees: allAttendees
    }
  }

  // 4. Check availability
  const availabilityResult = await checkAvailability({
    caseRecord: { ...caseRecord, attendees: allAttendees, _candidateSlots: slots },
    config,
    logger,
    store
  })

  const busyByEmail = availabilityResult.busyByEmail || {}
  const availabilityCheck = {
    status: 'success',
    checkedAt: availabilityResult.checkedAt,
    window: { timeMin: availabilityResult.timeMin, timeMax: availabilityResult.timeMax },
    sources: availabilityResult.sources || [],
    mocked: Boolean(availabilityResult.mocked),
  }

  if (availabilityResult.mocked) {
    warnings.push('Calendar availability check is mocked — all slots shown as available.')
  }

  // 5. Intersect slots with busy periods
  const intersected = intersectSlotsWithBusy(slots, busyByEmail, allAttendees, stageRules.bufferMinutes || 15)

  // 6. Detect conflicts
  const allCases = await (store.listCases ? store.listCases() : Promise.resolve([]))
  const otherCases = allCases.filter((c) => c.id !== caseRecord.id && c.status === 'Scheduled')

  const detailedConflicts = []
  for (const slot of intersected) {
    const slotConflicts = detectConflicts({
      proposedSlot: slot,
      attendees: allAttendees,
      busyPeriods: busyByEmail,
      existingCaseSchedules: otherCases,
      bufferMinutes: stageRules.bufferMinutes || 15,
      logger
    })
    for (const conflict of slotConflicts) {
      detailedConflicts.push(conflict)
    }
  }

  // 7. Rank slots
  const ranked = rankSlots(intersected, timeZone)

  const available = ranked.filter((s) => s.allAvailable)
  const withConflicts = ranked.filter((s) => !s.allAvailable)

  return {
    available,
    conflicts: detailedConflicts,
    totalSlots: ranked.length,
    allSlots: ranked,
    warnings,
    stageRules,
    attendees: allAttendees,
    availabilityCheck,
  }
}

// ─── Format Conflict Messages ────────────────────────────────────────────────

export function formatConflictMessage(conflict) {
  const icon = conflict.severity === 'error' ? '\u274C' : '\u26A0\uFE0F'
  return `${icon} ${conflict.message}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeRange(startIso, endIso) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
  return `${fmt.format(new Date(startIso))}–${fmt.format(new Date(endIso))}`
}

function formatRole(role) {
  if (!role) return 'unknown'
  return role.replace(/_/g, ' ')
}

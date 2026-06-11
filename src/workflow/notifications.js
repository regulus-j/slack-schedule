import crypto from 'node:crypto'
import { fetchApplicantDetail } from '../services/jazzhr.js'
import { sendRecruiterEmail } from '../services/google.js'
import { localDateTimeToUtc } from '../time.js'
import {
  buildFeedbackRequestEmail,
  buildReminderEmail,
} from './messages.js'

export const NOTIFICATION_TYPES = {
  CANDIDATE_REMINDER: 'candidate-reminder',
  COMPLETION_REMINDER: 'completion-reminder',
  JAZZHR_RECHECK: 'jazzhr-recheck',
  FEEDBACK_REQUEST: 'feedback-request',
}

const INTERVIEW_STAGE_KEYS = new Set(['1st-interview', '2nd-interview', 'final-interview'])
const AUTOMATED_STAGE_KEYS = new Set([...INTERVIEW_STAGE_KEYS, 'job-offer-discussion'])

export function isAutomatedNotificationCase(caseRecord) {
  return AUTOMATED_STAGE_KEYS.has(caseRecord?.stageKey)
}

export function notificationSchedule(caseRecord, now = new Date()) {
  const schedule = caseRecord?.currentSchedule || {}
  const timeZone = caseRecord?.interviewTimezone || 'Australia/Sydney'
  if (!schedule.date || !schedule.time || !isAutomatedNotificationCase(caseRecord)) return []

  const start = localDateTimeToUtc(schedule.date, schedule.time, timeZone)
  const durationMinutes = positiveNumber(schedule.durationMinutes, 30)
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000)
  const version = Number(caseRecord.scheduleVersion || 1)
  const jobs = []

  if (INTERVIEW_STAGE_KEYS.has(caseRecord.stageKey) && start > now) {
    const previousDate = previousCalendarDate(schedule.date)
    const intendedReminder = localDateTimeToUtc(previousDate, '09:00', timeZone)
    jobs.push({
      type: NOTIFICATION_TYPES.CANDIDATE_REMINDER,
      scheduleVersion: version,
      dueAt: (intendedReminder <= now ? now : intendedReminder).toISOString(),
    })
  }

  const completionDue = new Date(end.getTime() + 15 * 60 * 1000)
  if (completionDue > now) {
    jobs.push({
      type: NOTIFICATION_TYPES.COMPLETION_REMINDER,
      scheduleVersion: version,
      dueAt: completionDue.toISOString(),
    })
  }

  return jobs
}

export async function scheduleCaseNotifications({
  store,
  caseRecord,
  now = new Date(),
  backfill = false,
}) {
  if (!store?.upsertNotificationJob || !isAutomatedNotificationCase(caseRecord)) return []

  const version = Number(caseRecord.scheduleVersion || 1)
  await store.cancelNotificationJobs(caseRecord.id, { exceptScheduleVersion: version })

  const snapshot = jazzhrSnapshot(caseRecord.applicant)
  if (!sameSnapshot(caseRecord.currentSchedule?.jazzhrSnapshot, snapshot)) {
    caseRecord = await store.updateCase(caseRecord.id, {
      currentSchedule: {
        ...(caseRecord.currentSchedule || {}),
        jazzhrSnapshot: snapshot,
      },
    })
  }

  const jobs = notificationSchedule(caseRecord, now)
    .filter((job) => !backfill || new Date(job.dueAt) > now)
  const saved = []
  for (const job of jobs) {
    saved.push(await store.upsertNotificationJob({
      id: `notification-${crypto.randomUUID()}`,
      caseId: caseRecord.id,
      ...job,
      payload: {},
    }))
  }
  return saved
}

export async function backfillNotificationJobs({ store, now = new Date(), logger }) {
  if (!store?.listNotificationEligibleCases) return { cases: 0, jobs: 0 }
  const cases = await store.listNotificationEligibleCases()
  let jobs = 0
  for (const caseRecord of cases) {
    try {
      jobs += (await scheduleCaseNotifications({ store, caseRecord, now, backfill: true })).length
    } catch (error) {
      logger?.warn?.('notification_backfill_case_failed', { caseId: caseRecord.id, error: error.message })
    }
  }
  return { cases: cases.length, jobs }
}

export function startNotificationWorker({ store, client, config, logger }) {
  if (!config?.notifications?.enabled) {
    logger?.info?.('notification_worker_disabled')
    return { stop() {}, runOnce: async () => [] }
  }

  let running = false
  const runOnce = async () => {
    if (running) return []
    running = true
    try {
      return await processDueNotificationJobs({ store, client, config, logger })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    runOnce().catch((error) => logger?.error?.('notification_worker_tick_failed', { error: error.message }))
  }, config.notifications.pollIntervalMs)
  timer.unref?.()
  runOnce().catch((error) => logger?.error?.('notification_worker_start_failed', { error: error.message }))

  return {
    runOnce,
    stop() {
      clearInterval(timer)
    },
  }
}

export async function processDueNotificationJobs({
  store,
  client,
  config,
  logger,
  now = new Date(),
  limit = 10,
}) {
  const jobs = await store.claimDueNotificationJobs({ now: now.toISOString(), limit })
  const results = []
  for (const job of jobs) {
    try {
      const result = await deliverNotification({
        type: job.type,
        job,
        store,
        client,
        config,
        logger,
        now,
      })
      await store.finishNotificationJob(job.id, result)
      results.push({ job, result })
    } catch (error) {
      const retryAt = new Date(now.getTime() + retryDelayMs(job.attempts))
      await store.retryNotificationJob(job.id, {
        dueAt: retryAt.toISOString(),
        error: error.message,
      })
      logger?.error?.('notification_job_failed', {
        jobId: job.id,
        caseId: job.caseId,
        type: job.type,
        error: error.message,
      })
      results.push({ job, error })
    }
  }
  return results
}

export async function deliverNotification({
  type,
  job = {},
  store,
  client,
  config,
  logger,
  now = new Date(),
  recipientOverrides = {},
  testMode = false,
  fetchApplicantDetailImpl = fetchApplicantDetail,
}) {
  const caseRecord = await store.getCase(job.caseId)
  if (!caseRecord) return { skipped: true, reason: 'case_not_found' }
  if (job.scheduleVersion && Number(job.scheduleVersion) !== Number(caseRecord.scheduleVersion || 0)) {
    return { skipped: true, reason: 'stale_schedule_version' }
  }

  if (type === NOTIFICATION_TYPES.CANDIDATE_REMINDER) {
    if (caseRecord.status !== 'Scheduled') return { skipped: true, reason: 'case_not_scheduled' }
    const email = buildReminderEmail(caseRecord)
    if (recipientOverrides.email) email.to = recipientOverrides.email
    if (!email.to) return { skipped: true, reason: 'missing_candidate_email' }
    if (!testMode) {
      await store.updateCase(caseRecord.id, {
        reminderEmail: { ...email, kind: 'automated_reminder' },
        reminderStatus: 'sending',
        reminderScheduleVersion: caseRecord.scheduleVersion || 1,
      })
    }
    const result = await sendRecruiterEmail({ config, logger, caseRecord, email, store })
    if (!testMode) {
      await store.updateCase(caseRecord.id, {
        reminderEmail: { ...email, kind: 'automated_reminder' },
        reminderStatus: result.mocked ? 'mocked' : 'sent',
        reminderScheduleVersion: caseRecord.scheduleVersion || 1,
      })
      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: null,
        action: 'automated_reminder_sent',
        scheduleVersion: caseRecord.scheduleVersion || 1,
      })
    }
    return { sent: true, mocked: Boolean(result.mocked), email }
  }

  if (type === NOTIFICATION_TYPES.COMPLETION_REMINDER || type === NOTIFICATION_TYPES.JAZZHR_RECHECK) {
    if (caseRecord.status === 'Completed') return { skipped: true, reason: 'case_completed' }
    const comparison = await compareJazzhrStatus({
      caseRecord,
      config,
      logger,
      fetchApplicantDetailImpl,
    })
    const shouldSend = type === NOTIFICATION_TYPES.COMPLETION_REMINDER || !comparison.updated
    if (shouldSend) {
      await sendCompletionDm({
        client,
        caseRecord,
        comparison,
        slackUserOverride: recipientOverrides.slackUser,
      })
    }
    if (
      type === NOTIFICATION_TYPES.COMPLETION_REMINDER &&
      !comparison.updated &&
      caseRecord.applicant?.jazzhrApplicationId &&
      !testMode
    ) {
      await store.upsertNotificationJob({
        id: `notification-${crypto.randomUUID()}`,
        caseId: caseRecord.id,
        type: NOTIFICATION_TYPES.JAZZHR_RECHECK,
        scheduleVersion: caseRecord.scheduleVersion || 1,
        dueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        payload: {},
      })
    }
    return { sent: shouldSend, comparison }
  }

  if (type === NOTIFICATION_TYPES.FEEDBACK_REQUEST) {
    if (!config?.notifications?.feedbackFormUrl) {
      return { skipped: true, reason: 'missing_feedback_form_url' }
    }
    if (!testMode && ['sent', 'mocked'].includes(caseRecord.feedbackEmailStatus)) {
      return { skipped: true, reason: 'feedback_already_sent' }
    }
    const email = buildFeedbackRequestEmail(caseRecord, config.notifications.feedbackFormUrl)
    if (recipientOverrides.email) email.to = recipientOverrides.email
    if (!email.to) return { skipped: true, reason: 'missing_candidate_email' }
    if (!testMode) {
      await store.updateCase(caseRecord.id, { feedbackEmail: email, feedbackEmailStatus: 'sending' })
    }
    const result = await sendRecruiterEmail({ config, logger, caseRecord, email, store })
    if (!testMode) {
      await store.updateCase(caseRecord.id, {
        feedbackEmail: email,
        feedbackEmailStatus: result.mocked ? 'mocked' : 'sent',
      })
      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: null,
        action: 'feedback_request_sent',
      })
    }
    return { sent: true, mocked: Boolean(result.mocked), email }
  }

  throw new Error(`Unsupported notification type: ${type}`)
}

export async function markCaseComplete({
  store,
  caseId,
  actorSlackUserId,
  scheduleVersion,
  now = new Date(),
}) {
  return store.completeCase(caseId, {
    actorSlackUserId,
    expectedScheduleVersion: scheduleVersion,
    completedAt: now.toISOString(),
    feedbackJob: {
      id: `notification-${crypto.randomUUID()}`,
      type: NOTIFICATION_TYPES.FEEDBACK_REQUEST,
      dueAt: now.toISOString(),
      payload: {},
    },
  })
}

export function jazzhrSnapshot(applicant) {
  return {
    stage: clean(applicant?.stage),
    workflowStepId: clean(applicant?.workflowStepId),
    workflowStep: clean(applicant?.workflowStep),
    workflowCategory: clean(applicant?.workflowCategory),
  }
}

export function hasJazzhrStatusChanged(before, after) {
  return statusFingerprint(before) !== statusFingerprint(after)
}

async function compareJazzhrStatus({ caseRecord, config, logger, fetchApplicantDetailImpl }) {
  const applicantId = caseRecord.applicant?.jazzhrApplicationId
  if (!applicantId) {
    return { available: false, updated: false, reason: 'manual_candidate' }
  }
  const current = await fetchApplicantDetailImpl(
    config?.jazzhr?.apiKey,
    applicantId,
    logger,
    { jobId: caseRecord.applicant?.jazzhrJobId || '' },
  )
  if (!current) return { available: false, updated: false, reason: 'jazzhr_unavailable' }
  const before = caseRecord.currentSchedule?.jazzhrSnapshot || jazzhrSnapshot(caseRecord.applicant)
  const after = jazzhrSnapshot(current)
  return {
    available: true,
    updated: hasJazzhrStatusChanged(before, after),
    before,
    after,
  }
}

async function sendCompletionDm({ client, caseRecord, comparison, slackUserOverride }) {
  const userIds = slackUserOverride
    ? [slackUserOverride]
    : recruiterSlackUserIds(caseRecord)
  if (userIds.length === 0) throw new Error('No recruiter Slack user is available for the completion reminder.')

  const candidateName = candidateFullName(caseRecord)
  const role = caseRecord.applicant?.jobTitle || 'the role'
  const statusText = comparison.available
    ? (comparison.updated
        ? `JazzHR changed from "${displaySnapshot(comparison.before)}" to "${displaySnapshot(comparison.after)}".`
        : `JazzHR still shows "${displaySnapshot(comparison.after || comparison.before)}". Please update it after completing the event.`)
    : (comparison.reason === 'manual_candidate'
        ? 'This candidate was entered manually, so no JazzHR status check is available.'
        : 'JazzHR status could not be checked. Please verify it manually.')

  for (const userId of userIds) {
    const opened = await client.conversations.open({ users: userId })
    await client.chat.postMessage({
      channel: opened.channel.id,
      text: `Please mark ${candidateName}'s event complete.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Event follow-up: ${candidateName}*`,
              `Role: ${role}`,
              statusText,
              '',
              'Please mark the scheduled event complete.',
            ].join('\n'),
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Mark complete' },
              action_id: 'mark_event_complete',
              style: 'primary',
              value: JSON.stringify({
                caseId: caseRecord.id,
                scheduleVersion: caseRecord.scheduleVersion || 1,
              }),
            },
          ],
        },
      ],
    })
  }
}

function recruiterSlackUserIds(caseRecord) {
  const recruiterValues = [
    caseRecord.recruiter?.slackUserId,
    caseRecord.recruiter?.id,
    ...(caseRecord.externalAttendees || [])
      .filter((attendee) => attendee.role === 'recruiter')
      .map((attendee) => attendee.slackUserId || attendee.id),
  ]
  const recruiterIds = [...new Set(
    recruiterValues.map(clean).filter((value) => /^U[A-Z0-9]+$/i.test(value)),
  )]
  if (recruiterIds.length > 0) return recruiterIds
  const ownerId = clean(caseRecord.ownerSlackUserId)
  return /^U[A-Z0-9]+$/i.test(ownerId) ? [ownerId] : []
}

function candidateFullName(caseRecord) {
  return [
    caseRecord.applicant?.firstName,
    caseRecord.applicant?.lastName,
  ].filter(Boolean).join(' ') || caseRecord.applicant?.fullName || 'the candidate'
}

function displaySnapshot(snapshot) {
  return snapshot?.workflowStep || snapshot?.stage || snapshot?.workflowCategory || 'unknown'
}

function statusFingerprint(snapshot) {
  const value = snapshot || {}
  return [
    value.stage,
    value.workflowStepId,
    value.workflowStep,
    value.workflowCategory,
  ].map((item) => clean(item).toLowerCase()).join('|')
}

function sameSnapshot(left, right) {
  return statusFingerprint(left) === statusFingerprint(right)
}

function previousCalendarDate(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function retryDelayMs(attempts) {
  return Math.min(60, Math.max(1, Number(attempts || 1))) * 60 * 1000
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function clean(value) {
  return String(value || '').trim()
}

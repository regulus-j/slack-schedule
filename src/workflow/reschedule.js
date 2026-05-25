export const RESCHEDULE_STATUSES = {
  NONE: 'none',
  REQUESTED: 'requested',
  APPROVED: 'approved',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export function normalizeCaseSchedule(caseRecord) {
  return {
    scheduleVersion: caseRecord.scheduleVersion || 0,
    rescheduleStatus: caseRecord.rescheduleStatus || RESCHEDULE_STATUSES.NONE,
    scheduleHistory: caseRecord.scheduleHistory || [],
    currentSchedule: caseRecord.currentSchedule || scheduleFromCalendarDraft(caseRecord.calendarEventDraft),
    previousSchedule: caseRecord.previousSchedule || null,
    reminderScheduleVersion: caseRecord.reminderScheduleVersion || 0,
  };
}

export function isScheduledCase(caseRecord) {
  return caseRecord.status === 'Scheduled' || Boolean(caseRecord.calendarEventId);
}

export function canFinalizeSchedule(caseRecord) {
  return !caseRecord.calendarEventId && caseRecord.status !== 'Scheduled';
}

export function canStartReschedule(caseRecord) {
  const normalized = normalizeCaseSchedule(caseRecord);
  return (
    isScheduledCase(caseRecord) &&
    normalized.rescheduleStatus !== RESCHEDULE_STATUSES.REQUESTED &&
    !caseRecord.actionLock
  );
}

export function visibleCaseActions(caseRecord) {
  if (isScheduledCase(caseRecord)) {
    const actions = [
      'open_reschedule_modal',
      'cancel_interview',
      'send_reminder',
      'view_calendar_details',
    ]

    if (caseRecord.resumeLink) {
      actions.splice(1, 0, 'view_resume')
    }

    return actions
  }

  const actions = [
    'open_candidate_message_modal',
    'scheduling_open',
    'open_finalize_modal',
  ]

  if (caseRecord.resumeLink) {
    actions.push('view_resume')
  }

  return actions
}

export function buildScheduleSnapshot({ date, time, zoomLink, attendees, eventId, htmlLink }) {
  const attendeeList = Array.isArray(attendees) ? attendees : []
  return {
    date,
    time,
    zoomLink,
    attendees: attendeeList,
    eventId: eventId || null,
    htmlLink: htmlLink || null,
  };
}

export function applyScheduledEvent(caseRecord, eventResult, scheduleInput) {
  const normalized = normalizeCaseSchedule(caseRecord);
  const nextVersion = normalized.scheduleVersion || 1;
  const htmlLink = eventResult.googleEvent?.htmlLink || null;
  const currentSchedule = buildScheduleSnapshot({
    ...scheduleInput,
    eventId: eventResult.eventId,
    htmlLink,
  });

  return {
    status: 'Scheduled',
    guests: currentSchedule.attendees,
    calendarEventId: eventResult.eventId,
    calendarEventHtmlLink: htmlLink,
    calendarEventDraft: eventResult.eventDraft,
    currentSchedule,
    scheduleVersion: nextVersion,
    rescheduleStatus: RESCHEDULE_STATUSES.NONE,
    lastCalendarUpdateAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
  };
}

export function applyRescheduleRequest(caseRecord, request) {
  const normalized = normalizeCaseSchedule(caseRecord);
  return {
    status: 'Reschedule Requested',
    rescheduleStatus: RESCHEDULE_STATUSES.REQUESTED,
    rescheduleReason: request.reason,
    pendingReschedule: request,
    actionLock: {
      name: 'reschedule_requested',
      at: new Date().toISOString(),
      by: request.actorSlackUserId,
    },
    previousSchedule: normalized.currentSchedule,
    lastActionAt: new Date().toISOString(),
    lastActionBy: request.actorSlackUserId,
  };
}

export function applyCompletedReschedule(caseRecord, eventResult, request, emailResult) {
  const normalized = normalizeCaseSchedule(caseRecord);
  const nextVersion = normalized.scheduleVersion + 1;
  const previousSchedule = normalized.currentSchedule;
  const htmlLink = eventResult.googleEvent?.htmlLink || null;
  const currentSchedule = buildScheduleSnapshot({
    date: request.date,
    time: request.time,
    zoomLink: request.zoomLink,
    attendees: request.attendees,
    eventId: eventResult.eventId,
    htmlLink,
  });
  const scheduleHistory = [
    ...normalized.scheduleHistory,
    {
      version: normalized.scheduleVersion,
      schedule: previousSchedule,
      reason: request.reason,
      changedAt: new Date().toISOString(),
    },
  ].filter((item) => item.schedule);

  return {
    status: 'Scheduled',
    guests: currentSchedule.attendees,
    calendarEventId: eventResult.eventId,
    calendarEventHtmlLink: htmlLink,
    calendarEventDraft: eventResult.eventDraft,
    currentSchedule,
    previousSchedule,
    scheduleHistory,
    scheduleVersion: nextVersion,
    rescheduleStatus: RESCHEDULE_STATUSES.COMPLETED,
    rescheduleReason: request.reason,
    rescheduleEmail: request.email,
    rescheduleEmailStatus: emailResult?.mocked ? 'mocked' : 'sent',
    reminderScheduleVersion:
      caseRecord.reminderStatus === 'sent' ? normalized.reminderScheduleVersion : nextVersion,
    lastCalendarUpdateAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
    lastActionBy: request.actorSlackUserId,
    pendingReschedule: null,
    actionLock: null,
  };
}

export function applyCancelledInterview(caseRecord, actorSlackUserId) {
  return {
    status: 'Needs Attention',
    rescheduleStatus: RESCHEDULE_STATUSES.CANCELLED,
    actionLock: null,
    lastActionAt: new Date().toISOString(),
    lastActionBy: actorSlackUserId,
  };
}

function scheduleFromCalendarDraft(calendarEventDraft) {
  if (!calendarEventDraft) return null;
  return {
    date: calendarEventDraft.start?.dateTime?.slice(0, 10) || null,
    time: calendarEventDraft.start?.dateTime?.slice(11, 16) || null,
    zoomLink: calendarEventDraft.location || null,
    attendees: calendarEventDraft.attendees?.map((attendee) => attendee.email).filter(Boolean) || [],
    eventId: null,
  };
}

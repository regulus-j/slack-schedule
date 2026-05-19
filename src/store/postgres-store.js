import crypto from 'node:crypto';
import { decryptJson, encryptJson } from '../security/crypto.js';

export function createPostgresStore(databaseUrl, encryptionKey = '') {
  let pool;

  async function getPool() {
    if (!pool) {
      const { Pool } = await import('pg');
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      });
    }
    return pool;
  }

  async function query(text, params = []) {
    const currentPool = await getPool();
    return currentPool.query(text, params);
  }

  function encodeTokenPayload(tokenData) {
    if (encryptionKey) return encryptJson(tokenData, encryptionKey);
    return JSON.stringify(tokenData);
  }

  function decodeTokenPayload(payload) {
    if (!payload) return null;
    if (encryptionKey && String(payload).includes('.')) {
      try {
        return decryptJson(payload, encryptionKey);
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  function rowToCase(row) {
    return {
      id: row.id,
      status: row.status,
      ownerSlackUserId: row.owner_slack_user_id,
      channelId: row.channel_id,
      applicant: row.applicant,
      recruiter: row.recruiter,
      hiringManager: row.hiring_manager,
      templateId: row.template_id,
      notes: row.notes,
      interviewWindowStartDate: row.interview_window_start_date,
      interviewWindowEndDate: row.interview_window_end_date,
      interviewTimezone: row.interview_timezone,
      selectedInterviewDate: row.selected_interview_date,
      selectedInterviewTime: row.selected_interview_time,
      resumeLink: row.resume_link || row.resume_file || null,
      autofill: row.autofill,
      approvals: row.approvals || [],
      guests: row.guests || [],
      candidateEmail: row.candidate_email,
      smsCopy: row.sms_copy,
      hmMessage: row.hm_message,
      hmAvailability: row.hm_availability,
      calendarEventId: row.calendar_event_id,
      calendarEventDraft: row.calendar_event_draft,
      scheduleVersion: row.schedule_version || 0,
      rescheduleStatus: row.reschedule_status || 'none',
      rescheduleReason: row.reschedule_reason,
      previousSchedule: row.previous_schedule,
      currentSchedule: row.current_schedule,
      scheduleHistory: row.schedule_history || [],
      lastCalendarUpdateAt: row.last_calendar_update_at?.toISOString?.() || row.last_calendar_update_at,
      reminderScheduleVersion: row.reminder_schedule_version || 0,
      reminderStatus: row.reminder_status,
      reminderEmail: row.reminder_email,
      pendingReschedule: row.pending_reschedule,
      rescheduleEmail: row.reschedule_email,
      rescheduleEmailStatus: row.reschedule_email_status,
      actionLock: row.action_lock,
      lastActionAt: row.last_action_at?.toISOString?.() || row.last_action_at,
      lastActionBy: row.last_action_by,
      gmailSendStatus: row.gmail_send_status,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
      attendees: row.attendees || [],
      stageKey: row.stage_key,
      stageOverrides: row.stage_overrides || {},
      attendanceOverrides: row.attendance_overrides || {},
      externalAttendees: row.external_attendees || [],
      lastAvailabilityCheck: row.last_availability_check,
      selectedSlot: row.selected_slot,
    };
  }

  return {
    async init() {
      await query('SELECT 1');
    },

    async stats() {
      const result = await query('SELECT COUNT(*)::int AS cases FROM scheduling_cases');
      return { cases: result.rows[0].cases };
    },

    async getGoogleToken(recruiterId) {
      const result = await query('SELECT encrypted_payload FROM encrypted_google_tokens WHERE recruiter_id = $1', [recruiterId]);
      return result.rows[0] ? decodeTokenPayload(result.rows[0].encrypted_payload) : null;
    },

    async hasGoogleToken(recruiterId) {
      const result = await query('SELECT 1 FROM encrypted_google_tokens WHERE recruiter_id = $1 LIMIT 1', [recruiterId]);
      return result.rowCount > 0;
    },

    async saveGoogleToken(recruiterId, tokenData) {
      const encryptedPayload = encodeTokenPayload(tokenData);
      await query(
        `INSERT INTO encrypted_google_tokens (id, recruiter_id, encrypted_payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
           recruiter_id = EXCLUDED.recruiter_id,
           encrypted_payload = EXCLUDED.encrypted_payload,
           updated_at = now()`,
        [recruiterId, recruiterId, encryptedPayload],
      );
      return tokenData;
    },

    async createCase(input) {
      const id = `case-${crypto.randomUUID()}`;
      const result = await query(
        `INSERT INTO scheduling_cases (
          id,
          status,
          owner_slack_user_id,
          channel_id,
          applicant,
          recruiter,
          hiring_manager,
          template_id,
          notes,
          interview_window_start_date,
          interview_window_end_date,
          interview_timezone,
          selected_interview_date,
          selected_interview_time,
          resume_link,
          autofill,
          approvals,
          guests,
          schedule_version,
          reschedule_status,
          schedule_history,
          attendees,
          stage_key,
          stage_overrides,
          attendance_overrides,
          external_attendees,
          last_availability_check,
          selected_slot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '[]'::jsonb, '[]'::jsonb, 0, 'none', '[]'::jsonb, '[]'::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NULL, NULL)
        RETURNING *`,
        [
          id,
          'Draft',
          input.ownerSlackUserId,
          input.channelId,
          input.applicant || {},
          input.recruiter || {},
          input.hiringManager || {},
          input.templateId || null,
          input.notes || '',
          input.interviewWindowStartDate || null,
          input.interviewWindowEndDate || null,
          input.interviewTimezone || null,
          input.selectedInterviewDate || null,
          input.selectedInterviewTime || null,
          input.resumeLink || input.resumeFile || null,
          input.autofill || {},
        ],
      );
      return rowToCase(result.rows[0]);
    },

    async listCases() {
      const result = await query('SELECT * FROM scheduling_cases ORDER BY created_at DESC LIMIT 100');
      return result.rows.map(rowToCase);
    },

    async listCasesForUser(slackUserId) {
      const result = await query(
        'SELECT * FROM scheduling_cases WHERE owner_slack_user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [slackUserId],
      );
      return result.rows.map(rowToCase);
    },

    async getCase(id) {
      const result = await query('SELECT * FROM scheduling_cases WHERE id = $1', [id]);
      return result.rows[0] ? rowToCase(result.rows[0]) : undefined;
    },

    async updateCase(id, patch) {
      const current = await this.getCase(id);
      if (!current) throw new Error(`Case not found: ${id}`);
      const merged = { ...current, ...patch };
      const result = await query(
        `UPDATE scheduling_cases SET
          status = $2,
          applicant = $3,
          recruiter = $4,
          hiring_manager = $5,
          template_id = $6,
          notes = $7,
          interview_window_start_date = $8,
          interview_window_end_date = $9,
          interview_timezone = $10,
          selected_interview_date = $11,
          selected_interview_time = $12,
          resume_link = $13,
          autofill = $14,
          guests = $15,
          candidate_email = $16,
          sms_copy = $17,
          hm_message = $18,
          hm_availability = $19,
          calendar_event_id = $20,
          calendar_event_draft = $21,
          schedule_version = $22,
          reschedule_status = $23,
          reschedule_reason = $24,
          previous_schedule = $25,
          current_schedule = $26,
          schedule_history = $27,
          last_calendar_update_at = $28,
          reminder_schedule_version = $29,
          reminder_status = $30,
          reminder_email = $31,
          pending_reschedule = $32,
          reschedule_email = $33,
          reschedule_email_status = $34,
          action_lock = $35,
          last_action_at = $36,
          last_action_by = $37,
          gmail_send_status = $38,
          attendees = $39,
          stage_key = $40,
          stage_overrides = $41,
          attendance_overrides = $42,
          external_attendees = $43,
          last_availability_check = $44,
          selected_slot = $45,
          updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [
          id,
          merged.status,
          merged.applicant || {},
          merged.recruiter || {},
          merged.hiringManager || {},
          merged.templateId || null,
          merged.notes || '',
          merged.interviewWindowStartDate || null,
          merged.interviewWindowEndDate || null,
          merged.interviewTimezone || null,
          merged.selectedInterviewDate || null,
          merged.selectedInterviewTime || null,
          merged.resumeLink || merged.resumeFile || null,
          merged.autofill || {},
          merged.guests || [],
          merged.candidateEmail || null,
          merged.smsCopy || null,
          merged.hmMessage || null,
          merged.hmAvailability || null,
          merged.calendarEventId || null,
          merged.calendarEventDraft || null,
          merged.scheduleVersion || 0,
          merged.rescheduleStatus || 'none',
          merged.rescheduleReason || null,
          merged.previousSchedule || null,
          merged.currentSchedule || null,
          merged.scheduleHistory || [],
          merged.lastCalendarUpdateAt || null,
          merged.reminderScheduleVersion || 0,
          merged.reminderStatus || null,
          merged.reminderEmail || null,
          merged.pendingReschedule || null,
          merged.rescheduleEmail || null,
          merged.rescheduleEmailStatus || null,
          merged.actionLock || null,
          merged.lastActionAt || null,
          merged.lastActionBy || null,
          merged.gmailSendStatus || null,
          merged.attendees || [],
          merged.stageKey || null,
          merged.stageOverrides || {},
          merged.attendanceOverrides || {},
          merged.externalAttendees || [],
          merged.lastAvailabilityCheck || null,
          merged.selectedSlot || null,
        ],
      );
      return rowToCase(result.rows[0]);
    },

    async addAudit(entry) {
      const id = `audit-${crypto.randomUUID()}`;
      const details = { ...entry };
      delete details.caseId;
      delete details.actorSlackUserId;
      delete details.action;
      const result = await query(
        `INSERT INTO audit_events (id, case_id, actor_slack_user_id, action, details)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, entry.caseId || null, entry.actorSlackUserId || null, entry.action, details],
      );
      return result.rows[0];
    },

    async listAudits(caseId, { limit = 5 } = {}) {
      const result = await query(
        `SELECT id, case_id, actor_slack_user_id, action, details, created_at
         FROM audit_events
         WHERE case_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [caseId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        actorSlackUserId: row.actor_slack_user_id,
        action: row.action,
        ...(row.details || {}),
        at: row.created_at?.toISOString?.() || row.created_at,
      }));
    },
  };
}

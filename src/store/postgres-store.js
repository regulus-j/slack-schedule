import crypto from 'node:crypto';
import { candidateInactiveReason, normalizeJazzhrCandidate, normalizeJazzhrCandidates } from './candidate-index.js';
import { createPostgresPool } from './postgres-connection.js';

export function createPostgresStore(config, tokenCipher) {
  let pool;
  let closePool;

  async function getPool() {
    if (!pool) {
      const connection = await createPostgresPool(config)
      pool = connection.pool
      closePool = connection.close
    }
    return pool;
  }

  async function query(text, params = []) {
    const currentPool = await getPool();
    return currentPool.query(text, params);
  }

  async function encodeTokenPayload(tokenData) {
    return tokenCipher.encrypt(tokenData)
  }

  async function decodeTokenPayload(payload) {
    if (!payload) return null;
    try {
      return await tokenCipher.decrypt(payload);
    } catch {
      return null;
    }
  }

  function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeJson(value) {
    if (!value || typeof value === 'object') return value || null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function serializeJson(value) {
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
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
      resumeLink: row.resume_link || row.resume_file?.downloadUrl || row.resume_file?.permalink || null,
      resumeFile: normalizeJson(row.resume_file),
      autofill: row.autofill,
      approvals: normalizeArray(row.approvals),
      guests: normalizeArray(row.guests),
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
      scheduleHistory: normalizeArray(row.schedule_history),
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
      attendees: normalizeArray(row.attendees),
      stageKey: row.stage_key,
      stageOverrides: row.stage_overrides || {},
      attendanceOverrides: row.attendance_overrides || {},
      externalAttendees: normalizeArray(row.external_attendees),
      customInvite: row.custom_invite || null,
      lastAvailabilityCheck: normalizeJson(row.last_availability_check),
      selectedSlot: row.selected_slot,
      completedAt: row.completed_at?.toISOString?.() || row.completed_at,
      completedBy: row.completed_by,
      feedbackEmail: normalizeJson(row.feedback_email),
      feedbackEmailStatus: row.feedback_email_status,
      legalHold: Boolean(row.legal_hold),
    };
  }

  function rowToNotificationJob(row) {
    return {
      id: row.id,
      caseId: row.case_id,
      type: row.type,
      scheduleVersion: row.schedule_version || 0,
      dueAt: row.due_at?.toISOString?.() || row.due_at,
      status: row.status,
      attempts: row.attempts || 0,
      maxAttempts: row.max_attempts || 5,
      payload: normalizeJson(row.payload) || {},
      lockedAt: row.locked_at?.toISOString?.() || row.locked_at,
      lastError: row.last_error,
      completedAt: row.completed_at?.toISOString?.() || row.completed_at,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    }
  }

  function rowToJazzhrCandidate(row) {
    return normalizeJazzhrCandidate({
      candidateKey: row.candidate_key,
      jazzhrApplicationId: row.jazzhr_application_id,
      jazzhrJobId: row.jazzhr_job_id,
      fullName: row.full_name,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      jobTitle: row.job_title,
      stage: row.stage,
      workflowStepId: row.workflow_step_id,
      workflowStep: row.workflow_step,
      workflowCategory: row.workflow_category,
      jobStatus: row.job_status,
      recruiterId: row.recruiter_id,
      recruiterEmail: row.recruiter_email,
      recruiterName: row.recruiter_name,
      source: row.source,
      appliedAt: row.applied_at?.toISOString?.() || row.applied_at || '',
      sourceOrder: row.source_order,
    });
  }

  function dateOrNull(value) {
    const time = Date.parse(value)
    return Number.isFinite(time) ? new Date(time).toISOString() : null
  }

  function normalizeRecruiterId(value) {
    const id = String(value || '').trim()
    if (!id) return ''
    return id.startsWith('rec-') ? id : `rec-${id}`
  }

  return {
    async init() {
      await query('SELECT 1');
    },

    async stats() {
      const result = await query('SELECT COUNT(*)::int AS cases FROM scheduling_cases');
      let jazzhrCandidates = 0;
      try {
        const candidateResult = await query('SELECT COUNT(*)::int AS candidates FROM jazzhr_candidates');
        jazzhrCandidates = candidateResult.rows[0].candidates;
      } catch {
        jazzhrCandidates = 0;
      }
      return { cases: result.rows[0].cases, jazzhrCandidates };
    },

    async saveJazzhrCandidates(records) {
      const candidates = normalizeJazzhrCandidates(records);
      await query('DELETE FROM jazzhr_candidates');
      for (const candidate of candidates) {
        await query(
          `INSERT INTO jazzhr_candidates (
            candidate_key,
            jazzhr_application_id,
            jazzhr_job_id,
            full_name,
            first_name,
            last_name,
            email,
            phone,
            job_title,
            stage,
            workflow_step_id,
            workflow_step,
            workflow_category,
            job_status,
            recruiter_id,
            recruiter_email,
            recruiter_name,
            source,
            applied_at,
            source_order
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (candidate_key) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            jazzhr_application_id = EXCLUDED.jazzhr_application_id,
            jazzhr_job_id = EXCLUDED.jazzhr_job_id,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            job_title = EXCLUDED.job_title,
            stage = EXCLUDED.stage,
            workflow_step_id = EXCLUDED.workflow_step_id,
            workflow_step = EXCLUDED.workflow_step,
            workflow_category = EXCLUDED.workflow_category,
            job_status = EXCLUDED.job_status,
            recruiter_id = EXCLUDED.recruiter_id,
            recruiter_email = EXCLUDED.recruiter_email,
            recruiter_name = EXCLUDED.recruiter_name,
            source = EXCLUDED.source,
            applied_at = EXCLUDED.applied_at,
            source_order = EXCLUDED.source_order,
            updated_at = now()`,
          [
            candidate.candidateKey,
            candidate.jazzhrApplicationId,
            candidate.jazzhrJobId,
            candidate.fullName,
            candidate.firstName,
            candidate.lastName,
            candidate.email,
            candidate.phone,
            candidate.jobTitle,
            candidate.stage,
            candidate.workflowStepId,
            candidate.workflowStep,
            candidate.workflowCategory,
            candidate.jobStatus,
            candidate.recruiterId,
            candidate.recruiterEmail,
            candidate.recruiterName,
            candidate.source,
            dateOrNull(candidate.appliedAt),
            candidate.sourceOrder,
          ],
        );
      }
      return candidates.length;
    },

    async upsertJazzhrCandidates(records) {
      const candidates = normalizeJazzhrCandidates(records)
      for (const candidate of candidates) {
        await query(
          `INSERT INTO jazzhr_candidates (
            candidate_key,
            jazzhr_application_id,
            jazzhr_job_id,
            full_name,
            first_name,
            last_name,
            email,
            phone,
            job_title,
            stage,
            workflow_step_id,
            workflow_step,
            workflow_category,
            job_status,
            recruiter_id,
            recruiter_email,
            recruiter_name,
            source,
            applied_at,
            source_order
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (candidate_key) DO UPDATE SET
            jazzhr_application_id = EXCLUDED.jazzhr_application_id,
            jazzhr_job_id = EXCLUDED.jazzhr_job_id,
            full_name = EXCLUDED.full_name,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            job_title = EXCLUDED.job_title,
            stage = EXCLUDED.stage,
            workflow_step_id = EXCLUDED.workflow_step_id,
            workflow_step = EXCLUDED.workflow_step,
            workflow_category = EXCLUDED.workflow_category,
            job_status = EXCLUDED.job_status,
            recruiter_id = EXCLUDED.recruiter_id,
            recruiter_email = EXCLUDED.recruiter_email,
            recruiter_name = EXCLUDED.recruiter_name,
            source = EXCLUDED.source,
            applied_at = EXCLUDED.applied_at,
            source_order = EXCLUDED.source_order,
            updated_at = now()`,
          [
            candidate.candidateKey,
            candidate.jazzhrApplicationId,
            candidate.jazzhrJobId,
            candidate.fullName,
            candidate.firstName,
            candidate.lastName,
            candidate.email,
            candidate.phone,
            candidate.jobTitle,
            candidate.stage,
            candidate.workflowStepId,
            candidate.workflowStep,
            candidate.workflowCategory,
            candidate.jobStatus,
            candidate.recruiterId,
            candidate.recruiterEmail,
            candidate.recruiterName,
            candidate.source,
            dateOrNull(candidate.appliedAt),
            candidate.sourceOrder,
          ],
        )
      }
      return candidates.length
    },

    async replaceJazzhrJobCandidates(jobId, records) {
      const normalizedJobId = String(jobId || '').trim()
      const candidates = normalizeJazzhrCandidates(records)
      await this.upsertJazzhrCandidates(candidates)
      const candidateKeys = candidates.map((candidate) => candidate.candidateKey)
      if (candidateKeys.length > 0) {
        await query(
          `DELETE FROM jazzhr_candidates
           WHERE jazzhr_job_id = $1
             AND NOT (candidate_key = ANY($2))`,
          [normalizedJobId, candidateKeys],
        )
      } else {
        await query('DELETE FROM jazzhr_candidates WHERE jazzhr_job_id = $1', [normalizedJobId])
      }
      return candidates.length
    },

    async searchJazzhrCandidates(searchQuery, {
      limit = 20,
      baseQuery = '',
      roleId = '',
      roleTitle = '',
      recruiterIds = [],
      recruiterEmails = [],
      recruiterNames = [],
    } = {}) {
      const filters = [];
      const params = [];
      for (const value of [baseQuery, searchQuery]) {
        const normalized = String(value || '').trim();
        if (!normalized) continue;
        params.push(`%${normalized}%`);
        filters.push(`(
          full_name ILIKE $${params.length} OR
          first_name ILIKE $${params.length} OR
          last_name ILIKE $${params.length} OR
          email ILIKE $${params.length} OR
          job_title ILIKE $${params.length} OR
          jazzhr_application_id ILIKE $${params.length}
          OR jazzhr_job_id ILIKE $${params.length}
          OR candidate_key ILIKE $${params.length}
        )`);
      }
      if (roleId) {
        params.push(String(roleId).trim());
        filters.push(`jazzhr_job_id = $${params.length}`);
      } else if (roleTitle) {
        params.push(String(roleTitle).trim());
        filters.push(`job_title ILIKE $${params.length}`);
      }
      const normalizedRecruiterIds = recruiterIds.map(normalizeRecruiterId).filter(Boolean)
      if (normalizedRecruiterIds.length > 0) {
        params.push(normalizedRecruiterIds);
        const recruiterIdParam = params.length
        params.push(recruiterEmails.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
        const recruiterEmailParam = params.length
        params.push(recruiterNames.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
        const recruiterNameParam = params.length
        filters.push(`(
          (recruiter_id = '' AND recruiter_email = '' AND recruiter_name = '')
          OR recruiter_id = ANY($${recruiterIdParam})
          OR lower(recruiter_email) = ANY($${recruiterEmailParam})
          OR lower(recruiter_name) = ANY($${recruiterNameParam})
        )`);
      }
      params.push(limit * 5);
      const result = await query(
        `SELECT *
         FROM jazzhr_candidates
         ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
         ORDER BY applied_at DESC NULLS LAST, source_order ASC, full_name ASC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows
        .map(rowToJazzhrCandidate)
        .filter((candidate) => !candidateInactiveReason(candidate))
        .slice(0, limit);
    },

    async listJazzhrCandidates({ limit = 50000 } = {}) {
      const result = await query(
        `SELECT *
         FROM jazzhr_candidates
         ORDER BY applied_at DESC NULLS LAST, source_order ASC, full_name ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows
        .map(rowToJazzhrCandidate)
        .filter((candidate) => !candidateInactiveReason(candidate));
    },

    async getJazzhrCandidate(jazzhrApplicationId) {
      const id = String(jazzhrApplicationId || '').replace(/^applicant-/, '');
      const result = await query(
        `SELECT *
         FROM jazzhr_candidates
         WHERE candidate_key = $1 OR jazzhr_application_id = $1
         ORDER BY applied_at DESC NULLS LAST, source_order ASC, full_name ASC
         LIMIT 1`,
        [id],
      );
      if (!result.rows[0]) return null;
      const candidate = rowToJazzhrCandidate(result.rows[0]);
      return candidateInactiveReason(candidate) ? null : candidate;
    },

    async listTalentDirectory() {
      const result = await query(
        `SELECT first_name, last_name, designation, department, work_email
         FROM talent_directory
         ORDER BY first_name, last_name`,
      );
      return result.rows
        .map((row, index) => {
          const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
          if (!name || !row.work_email) return null;
          return {
            id: `hm-${index + 1}`,
            name,
            email: row.work_email,
            role: 'hiring_manager',
            slackUserId: '',
            positionTitle: row.designation || '',
            department: row.department || '',
          };
        })
        .filter(Boolean);
    },

    async getGoogleToken(recruiterId) {
      const result = await query(
        `UPDATE encrypted_google_tokens
         SET last_used_at = now()
         WHERE recruiter_id = $1
         RETURNING encrypted_payload`,
        [recruiterId],
      );
      return result.rows[0] ? await decodeTokenPayload(result.rows[0].encrypted_payload) : null;
    },

    async hasGoogleToken(recruiterId) {
      const result = await query('SELECT 1 FROM encrypted_google_tokens WHERE recruiter_id = $1 LIMIT 1', [recruiterId]);
      return result.rowCount > 0;
    },

    async listGoogleTokenIds() {
      const result = await query('SELECT recruiter_id FROM encrypted_google_tokens ORDER BY recruiter_id')
      return result.rows.map((row) => row.recruiter_id)
    },

    async saveGoogleToken(recruiterId, tokenData) {
      const encryptedPayload = await encodeTokenPayload(tokenData);
      await query(
        `INSERT INTO encrypted_google_tokens (id, recruiter_id, encrypted_payload, last_used_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET
           recruiter_id = EXCLUDED.recruiter_id,
           encrypted_payload = EXCLUDED.encrypted_payload,
           last_used_at = now(),
           updated_at = now()`,
        [recruiterId, recruiterId, encryptedPayload],
      );
      return tokenData;
    },

    async deleteGoogleToken(recruiterId) {
      await query('DELETE FROM encrypted_google_tokens WHERE recruiter_id = $1 OR id = $1', [recruiterId]);
      return true;
    },

    async createOAuthState(record) {
      const result = await query(
        `INSERT INTO oauth_states (
          state_hash, slack_user_id, team_id, token_owner_id, source, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          record.stateHash,
          record.slackUserId,
          record.teamId || '',
          record.tokenOwnerId,
          record.source || 'slack',
          record.createdAt,
          record.expiresAt,
        ],
      )
      return oauthStateRow(result.rows[0])
    },

    async consumeOAuthState(stateHash, { expectedTeamId = '', now = new Date().toISOString() } = {}) {
      const result = await query(
        `UPDATE oauth_states SET consumed_at = $2
         WHERE state_hash = $1
           AND consumed_at IS NULL
           AND expires_at > $2
           AND ($3 = '' OR team_id = '' OR team_id = $3)
         RETURNING *`,
        [stateHash, now, expectedTeamId],
      )
      return result.rows[0] ? oauthStateRow(result.rows[0]) : null
    },

    async consumeRateLimit({ userId, bucket, limit, windowMs, now = new Date().toISOString() }) {
      const nowMs = new Date(now).getTime()
      const windowStartMs = Math.floor(nowMs / windowMs) * windowMs
      const windowStartedAt = new Date(windowStartMs).toISOString()
      const result = await query(
        `INSERT INTO rate_limit_counters (user_id, bucket, window_started_at, request_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (user_id, bucket, window_started_at)
         DO UPDATE SET request_count = rate_limit_counters.request_count + 1
         RETURNING request_count`,
        [userId, bucket, windowStartedAt],
      )
      const count = Number(result.rows[0].request_count)
      return {
        allowed: count <= limit,
        count,
        retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
      }
    },

    async purgeRetention({
      now = new Date(),
      completedCaseDays = 365,
      candidateCacheDays = 30,
      googleTokenInactiveDays = 90,
      oauthStateCleanupHours = 24,
      authorizedGoogleUserIds = [],
      dryRun = false,
    } = {}) {
      const caseCutoff = new Date(new Date(now).getTime() - completedCaseDays * 86400000)
      const candidateCutoff = new Date(new Date(now).getTime() - candidateCacheDays * 86400000)
      const tokenCutoff = new Date(new Date(now).getTime() - googleTokenInactiveDays * 86400000)
      const oauthCutoff = new Date(new Date(now).getTime() - oauthStateCleanupHours * 3600000)
      const counts = await query(
        `SELECT
          (SELECT COUNT(*)::int FROM scheduling_cases
            WHERE legal_hold = false
              AND (status IN ('Completed', 'Cancelled') OR reschedule_status = 'cancelled')
              AND COALESCE(completed_at, updated_at) < $1) AS cases,
          (SELECT COUNT(*)::int FROM jazzhr_candidates WHERE updated_at < $2) AS candidates,
          (SELECT COUNT(*)::int FROM encrypted_google_tokens
            WHERE COALESCE(last_used_at, updated_at) < $3
               OR (cardinality($5::text[]) > 0 AND NOT (recruiter_id = ANY($5::text[])))) AS google_tokens,
          (SELECT COUNT(*)::int FROM oauth_states WHERE expires_at < $4) AS oauth_states`,
        [caseCutoff, candidateCutoff, tokenCutoff, oauthCutoff, authorizedGoogleUserIds],
      )
      const result = {
        cases: counts.rows[0].cases,
        candidates: counts.rows[0].candidates,
        googleTokens: counts.rows[0].google_tokens,
        oauthStates: counts.rows[0].oauth_states,
        dryRun,
      }
      if (dryRun) return result
      await query(
        `DELETE FROM scheduling_cases
         WHERE legal_hold = false
           AND (status IN ('Completed', 'Cancelled') OR reschedule_status = 'cancelled')
           AND COALESCE(completed_at, updated_at) < $1`,
        [caseCutoff],
      )
      await query('DELETE FROM jazzhr_candidates WHERE updated_at < $1', [candidateCutoff])
      await query(
        `DELETE FROM encrypted_google_tokens
         WHERE COALESCE(last_used_at, updated_at) < $1
            OR (cardinality($2::text[]) > 0 AND NOT (recruiter_id = ANY($2::text[])))`,
        [tokenCutoff, authorizedGoogleUserIds],
      )
      await query('DELETE FROM oauth_states WHERE expires_at < $1', [oauthCutoff])
      await query('DELETE FROM rate_limit_counters WHERE window_started_at < now() - interval \'1 day\'')
      return result
    },

    async close() {
      if (closePool) await closePool()
      await tokenCipher.close?.()
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
          selected_slot,
          custom_invite,
          resume_file
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 0, 'none', $19, $20, NULL, $21, $22, $23, $24, $25, $26, $27)
        RETURNING *`,
        [
          id,                                                              // $1
          'Draft',                                                         // $2
          input.ownerSlackUserId,                                          // $3
          input.channelId,                                                 // $4
          input.applicant ? JSON.stringify(input.applicant) : JSON.stringify({}),       // $5
          input.recruiter ? JSON.stringify(input.recruiter) : JSON.stringify({}),       // $6
          input.hiringManager ? JSON.stringify(input.hiringManager) : JSON.stringify({}), // $7
          input.templateId || null,                                        // $8
          input.notes || '',                                               // $9
          input.interviewWindowStartDate || null,                          // $10
          input.interviewWindowEndDate || null,                            // $11
          input.interviewTimezone || null,                                 // $12
          input.selectedInterviewDate || null,                             // $13
          input.selectedInterviewTime || null,                             // $14
          input.resumeLink || input.resumeFile?.downloadUrl || input.resumeFile?.permalink || null, // $15
          input.autofill ? JSON.stringify(input.autofill) : JSON.stringify({}),          // $16
          input.approvals ? JSON.stringify(input.approvals) : JSON.stringify({}),        // $17
          input.guests ? JSON.stringify(input.guests) : JSON.stringify([]),              // $18
          input.scheduleHistory ? JSON.stringify(input.scheduleHistory) : JSON.stringify([]), // $19
          input.attendees ? JSON.stringify(input.attendees) : JSON.stringify([]),        // $20
          input.stageOverrides ? JSON.stringify(input.stageOverrides) : JSON.stringify({}), // $21
          input.attendanceOverrides ? JSON.stringify(input.attendanceOverrides) : JSON.stringify({}), // $22
          input.externalAttendees ? JSON.stringify(input.externalAttendees) : JSON.stringify([]),    // $23
          serializeJson(input.lastAvailabilityCheck),                      // $24
          input.selectedSlot ? JSON.stringify(input.selectedSlot) : null,  // $25
          input.customInvite ? JSON.stringify(input.customInvite) : JSON.stringify({}), // $26
          serializeJson(input.resumeFile),                                 // $27
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

    async listNotificationEligibleCases() {
      const result = await query(
        `SELECT *
         FROM scheduling_cases
         WHERE status = 'Scheduled'
           AND current_schedule IS NOT NULL
           AND stage_key = ANY($1)
         ORDER BY updated_at ASC`,
        [['1st-interview', '2nd-interview', 'final-interview', 'job-offer-discussion']],
      )
      return result.rows.map(rowToCase)
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
          custom_invite = $46,
          resume_file = $47,
          completed_at = $48,
          completed_by = $49,
          feedback_email = $50,
          feedback_email_status = $51,
          legal_hold = $52,
          updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [
          id,
          merged.status,
          merged.applicant ? JSON.stringify(merged.applicant) : JSON.stringify({}),
          merged.recruiter ? JSON.stringify(merged.recruiter) : JSON.stringify({}),
          merged.hiringManager ? JSON.stringify(merged.hiringManager) : JSON.stringify({}),
          merged.templateId || null,
          merged.notes || '',
          merged.interviewWindowStartDate || null,
          merged.interviewWindowEndDate || null,
          merged.interviewTimezone || null,
          merged.selectedInterviewDate || null,
          merged.selectedInterviewTime || null,
          merged.resumeLink || merged.resumeFile?.downloadUrl || merged.resumeFile?.permalink || null,
          merged.autofill ? JSON.stringify(merged.autofill) : JSON.stringify({}),
          merged.guests ? JSON.stringify(merged.guests) : JSON.stringify([]),
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
          merged.scheduleHistory ? JSON.stringify(merged.scheduleHistory) : JSON.stringify([]),
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
          merged.attendees ? JSON.stringify(merged.attendees) : JSON.stringify([]),
          merged.stageKey || null,
          merged.stageOverrides ? JSON.stringify(merged.stageOverrides) : JSON.stringify({}),
          merged.attendanceOverrides ? JSON.stringify(merged.attendanceOverrides) : JSON.stringify({}),
          merged.externalAttendees ? JSON.stringify(merged.externalAttendees) : JSON.stringify([]),
          serializeJson(merged.lastAvailabilityCheck),
          merged.selectedSlot || null,
          merged.customInvite ? JSON.stringify(merged.customInvite) : JSON.stringify({}),
          serializeJson(merged.resumeFile),
          merged.completedAt || null,
          merged.completedBy || null,
          serializeJson(merged.feedbackEmail),
          merged.feedbackEmailStatus || null,
          Boolean(merged.legalHold),
        ],
      );
      return rowToCase(result.rows[0]);
    },

    async upsertNotificationJob(input) {
      const result = await query(
        `INSERT INTO notification_jobs (
          id, case_id, type, schedule_version, due_at, status, attempts, max_attempts, payload
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7)
        ON CONFLICT (case_id, type, schedule_version) DO UPDATE SET
          due_at = EXCLUDED.due_at,
          payload = EXCLUDED.payload,
          status = CASE
            WHEN notification_jobs.status = 'completed' THEN notification_jobs.status
            ELSE 'pending'
          END,
          locked_at = CASE
            WHEN notification_jobs.status = 'completed' THEN notification_jobs.locked_at
            ELSE NULL
          END,
          last_error = CASE
            WHEN notification_jobs.status = 'completed' THEN notification_jobs.last_error
            ELSE NULL
          END,
          updated_at = now()
        RETURNING *`,
        [
          input.id || `notification-${crypto.randomUUID()}`,
          input.caseId,
          input.type,
          input.scheduleVersion || 0,
          input.dueAt,
          input.maxAttempts || 5,
          serializeJson(input.payload || {}),
        ],
      )
      return rowToNotificationJob(result.rows[0])
    },

    async claimDueNotificationJobs({ now = new Date().toISOString(), limit = 10, leaseMs = 300000 } = {}) {
      const leaseCutoff = new Date(new Date(now).getTime() - leaseMs).toISOString()
      const result = await query(
        `WITH claimable AS (
          SELECT id
          FROM notification_jobs
          WHERE (
            (status = 'pending' AND due_at <= $1)
            OR (status = 'running' AND locked_at < $2)
          )
          AND attempts < max_attempts
          ORDER BY due_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE notification_jobs AS jobs SET
          status = 'running',
          attempts = jobs.attempts + 1,
          locked_at = $1,
          updated_at = now()
        FROM claimable
        WHERE jobs.id = claimable.id
        RETURNING jobs.*`,
        [now, leaseCutoff, limit],
      )
      return result.rows.map(rowToNotificationJob)
    },

    async finishNotificationJob(id, result = {}) {
      const updated = await query(
        `UPDATE notification_jobs SET
          status = 'completed',
          payload = payload || $2::jsonb,
          completed_at = now(),
          locked_at = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [id, serializeJson({ result })],
      )
      return updated.rows[0] ? rowToNotificationJob(updated.rows[0]) : null
    },

    async retryNotificationJob(id, { dueAt, error } = {}) {
      const updated = await query(
        `UPDATE notification_jobs SET
          status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          due_at = COALESCE($2, due_at),
          locked_at = NULL,
          last_error = $3,
          updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [id, dueAt || null, error || null],
      )
      return updated.rows[0] ? rowToNotificationJob(updated.rows[0]) : null
    },

    async cancelNotificationJobs(caseId, { exceptScheduleVersion } = {}) {
      const params = [caseId]
      let versionClause = ''
      if (exceptScheduleVersion !== undefined) {
        params.push(exceptScheduleVersion)
        versionClause = `AND schedule_version <> $${params.length}`
      }
      const result = await query(
        `UPDATE notification_jobs SET
          status = 'cancelled',
          locked_at = NULL,
          updated_at = now()
        WHERE case_id = $1
          AND status IN ('pending', 'running', 'failed')
          ${versionClause}`,
        params,
      )
      return result.rowCount
    },

    async completeCase(caseId, {
      actorSlackUserId,
      expectedScheduleVersion,
      completedAt,
      feedbackJob,
    }) {
      const pool = await getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const currentResult = await client.query(
          'SELECT * FROM scheduling_cases WHERE id = $1 FOR UPDATE',
          [caseId],
        )
        if (!currentResult.rows[0]) throw new Error(`Case not found: ${caseId}`)
        const current = rowToCase(currentResult.rows[0])
        if (current.status === 'Completed') {
          await client.query('COMMIT')
          return { caseRecord: current, alreadyCompleted: true }
        }
        if (
          expectedScheduleVersion !== undefined &&
          Number(expectedScheduleVersion) !== Number(current.scheduleVersion || 1)
        ) {
          await client.query('COMMIT')
          return { caseRecord: current, alreadyCompleted: false, stale: true }
        }

        const completedResult = await client.query(
          `UPDATE scheduling_cases SET
            status = 'Completed',
            completed_at = $2,
            completed_by = $3,
            action_lock = NULL,
            last_action_at = $2,
            last_action_by = $3,
            updated_at = now()
          WHERE id = $1
          RETURNING *`,
          [caseId, completedAt, actorSlackUserId || null],
        )
        await client.query(
          `UPDATE notification_jobs SET
            status = 'cancelled',
            locked_at = NULL,
            updated_at = now()
          WHERE case_id = $1
            AND status IN ('pending', 'running', 'failed')
            AND type <> 'feedback-request'`,
          [caseId],
        )
        if (feedbackJob) {
          await client.query(
            `INSERT INTO notification_jobs (
              id, case_id, type, schedule_version, due_at, status, payload
            )
            VALUES ($1, $2, $3, $4, $5, 'pending', $6)
            ON CONFLICT (case_id, type, schedule_version) DO NOTHING`,
            [
              feedbackJob.id || `notification-${crypto.randomUUID()}`,
              caseId,
              feedbackJob.type,
              current.scheduleVersion || 1,
              feedbackJob.dueAt,
              serializeJson(feedbackJob.payload || {}),
            ],
          )
        }
        await client.query('COMMIT')
        return { caseRecord: rowToCase(completedResult.rows[0]), alreadyCompleted: false }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
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

function oauthStateRow(row) {
  return {
    stateHash: row.state_hash,
    slackUserId: row.slack_user_id,
    teamId: row.team_id,
    tokenOwnerId: row.token_owner_id,
    source: row.source,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at,
    consumedAt: row.consumed_at?.toISOString?.() || row.consumed_at,
  }
}

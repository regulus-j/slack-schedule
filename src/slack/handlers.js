import crypto from 'node:crypto'
import {
  getApplicants,
  getRecruiters,
  getHiringManagers,
  getApplicantDetail,
  getTalentRecruiters,
  getSlackUsers,
  setApplicantDetail,
} from '../data/cache.js'
import { searchTimezones } from '../data/timezones.js'
import {
  applicantOptions,
  applicantPickerLabel,
  findApplicant,
  findPerson,
  personOptions,
  personPickerLabel,
  toSlackOption,
} from '../data/search.js'
import { loadSchedulingTemplates, loadTemplates, plainTextToHtml, renderTemplate } from '../templates.js'
import { buildGoogleOAuthUrl, createCalendarEvent, sendRecruiterEmail, updateCalendarEvent } from '../services/google.js'
import { fetchApplicantDetail, refreshJazzhrCache } from '../services/jazzhr.js'
import { loadTalentDirectory } from '../services/talent-directory.js'
import { ensureSlackDirectory, resolveSlackUser } from '../services/slack-directory.js'
import { recruiterPhoneLine } from '../services/recruiter-phone-export.js'
import { resolvePostingChannel, verifyChannel } from './guards.js'
import {
  PH_TIME_ZONE,
  SYDNEY_TIME_ZONE,
  buildCalendarEventDraft,
  convertLocalDateTimeToZone,
  formatDateForInput,
  formatTimeForInput,
  isTimeWithinBusinessHours,
  isValidDateRange,
} from '../time.js'
import {
  applyCancelledInterview,
  applyCompletedReschedule,
  applyRescheduleRequest,
  applyScheduledEvent,
  buildScheduleSnapshot,
  canFinalizeSchedule,
  canStartReschedule,
  isScheduledCase,
} from '../workflow/reschedule.js'
import { buildReminderEmail, buildRescheduleEmail } from '../workflow/messages.js'
import {
  normalizeStageKey,
  resolveStageFromTemplate,
  resolveStageRules,
  resolveTemplateFromStage,
  stageLabel,
} from '../workflow/stage-rules.js'
import { normalizeAttendees, refreshAttendees } from '../workflow/attendees.js'
import { runSchedulingPipeline } from '../workflow/scheduler.js'
import {
  calendarEventUrl,
  checkingAvailabilityModal,
  candidateMessageModal,
  caseMessageBlocks,
  externalAttendeeModal,
  finalizeEmailPreviewModal,
  finalizeModal,
  homeView,
  intakeModal,
  scheduleTrackerModal,
  rescheduleApprovalModal,
  rescheduleModal,
  schedulingModal,
  schedulingPhaseTwo,
} from './views.js'

export function registerSlackHandlers(app, context) {
  const { store, logger, config } = context;
  const schedulingTimeZones = resolveSchedulingTimeZones(config)
  const defaultTimeZone = schedulingTimeZones[0] || SYDNEY_TIME_ZONE

  app.event('app_home_opened', async ({ event, client }) => {
    await publishHome({ client, userId: event.user, store, logger });
  });

  app.command('/schedule-interview', async ({ command, ack, client }) => {
    await ack();
    if (!await verifyChannel({ config, command, client })) return
    if (command.text?.trim().toLowerCase() === 'button') {
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, command.channel_id),
        text: '🚀 Start an interview scheduling case.',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '📋 *Interview scheduling assistant*' },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: '🚀 Start scheduling' },
              action_id: 'open_schedule_intake',
              style: 'primary',
            },
          },
        ],
      });
      return;
    }
    await openIntakeModal({
      client,
      triggerId: command.trigger_id,
      config,
      logger,
      privateMetadata: command.channel_id,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.command('/slack-scheduler', async ({ command, ack, client }) => {
    await ack();
    const text = (command.text || '').trim().toLowerCase();

    if (text === 'refresh-jazz') {
      const result = await refreshJazzhrCache({ config, logger });
      const recruiters = getRecruiters();
      await loadTalentDirectory(config, store)
      const talentRecruiters = getTalentRecruiters()
      await client.chat.postMessage({
        channel: command.channel_id,
        text: result.refreshed
          ? `JazzHR cache refreshed: ${result.records} applicants and ${recruiters.length} JazzHR users loaded. Talent recruiters refreshed: ${talentRecruiters.length}.`
          : 'JazzHR refresh completed with warnings (check logs for details).',
      });
      return;
    }

    if (text === 'refresh-directory') {
      await loadTalentDirectory(config, store)
      const talentRecruiters = getTalentRecruiters()
      await client.chat.postMessage({
        channel: command.channel_id,
        text: `Talent directory refreshed: ${talentRecruiters.length} recruitment records loaded.`,
      });
      return;
    }

    if (text === 'status') {
      const applicants = getApplicants();
      const recruiters = getRecruiters();
      const talentRecruiters = getTalentRecruiters();
      const managers = getHiringManagers();
      const totalPeople = talentRecruiters.length + managers.length
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: [
          `*Cache status:*`,
          `Applicants: ${applicants.length}`,
          `Recruiters (JazzHR): ${recruiters.length}`,
          `Recruiters (talent directory): ${talentRecruiters.length}`,
          `Hiring Managers (talent directory): ${managers.length}`,
          `Total directory people: ${totalPeople}`,
          `Recruiter preview: ${previewPeople(talentRecruiters)}`,
        ].join('\n'),
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Available subcommands: `refresh-jazz` reload JazzHR and talent directory caches, `refresh-directory` reload talent directory only, `status` show cache counts.',
    });
  });

  app.action('post_schedule_launcher', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
      text: '🚀 Start an interview scheduling case.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '📋 *Interview scheduling assistant*' },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '🚀 Start scheduling' },
            action_id: 'open_schedule_intake',
            style: 'primary',
          },
        },
      ],
    });
  });

  app.action('open_schedule_intake', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    await openIntakeModal({
      client,
      triggerId: body.trigger_id,
      config,
      logger,
      privateMetadata: body.channel?.id || body.user.id,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('open_schedule_tracker', async ({ ack, body, client }) => {
    await ack();
    const ownerSlackUserId = body.user?.id || ''
    const scheduledCases = await getScheduledCases(store, ownerSlackUserId, 'all')
    await client.views.open({
      trigger_id: body.trigger_id,
      view: scheduleTrackerModal({
        cases: scheduledCases,
        filters: {},
        scope: 'all',
        ownerSlackUserId,
        totalCount: scheduledCases.length,
      }),
    });
  });

  app.action('applicant_select', async ({ ack, body, client }) => {
    await ack();
    logger.info('applicant_select_fired', { selectedId: selectedOptionValue(body) });
    const selectedId = selectedOptionValue(body);
    const applicant = findApplicant(selectedId);

    if (applicant?.jazzhrApplicationId) {
      try {
        const detail = await Promise.race([
          fetchApplicantDetail(config.jazzhr.apiKey, applicant.jazzhrApplicationId, logger),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        if (detail) {
          setApplicantDetail(selectedId, detail);
          if (detail.email && !applicant.email) {
            applicant.email = detail.email;
          }
        }
      } catch (err) {
        logger.warn('applicant_detail_fetch_failed', { applicantId: selectedId, error: err.message });
      }
    }

    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'applicant',
      selectedId,
      showDetails: true,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('toggle_applicant_details', async ({ ack, body, client }) => {
    await ack();
    const actionValue = body.actions?.[0]?.value || 'show';
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      showDetails: actionValue === 'show',
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('stage_select', async ({ ack, body, client }) => {
    await ack()
    if (body.view?.callback_id === 'scheduling_phase_one') {
      await refreshSchedulingModal({
        client,
        body,
        store,
        selectedStageKey: selectedOptionValue(body),
      })
      return
    }
    if (body.view?.callback_id !== 'schedule_intake_submit') return
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'stageKey',
      selectedId: selectedOptionValue(body),
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('recruiter_select', async ({ ack, body, client }) => {
    await ack();
    const selectedId = selectedOptionValue(body)
    const recruiters = getTalentRecruiters()
    const selectedRecruiter = findPersonInList(selectedId, recruiters)
    if (!selectedRecruiter) {
      logger.warn('recruiter_selection_not_in_talent_directory', {
        selectedId,
      })
    }
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'recruiter',
      selectedId,
      selectedPerson: selectedRecruiter
        ? asRecruiter(selectedRecruiter)
        : asRecruiter(personFromSelectedOption(body)),
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('hm_select', async ({ ack, body, client }) => {
    await ack();
    const selectedId = selectedOptionValue(body)
    const selectedUser = await resolveSlackUser({ client, userId: selectedId, logger })
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'hiringManager',
      selectedId,
      selectedPerson: selectedUser ? asHiringManager(selectedUser) : null,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('open_google_oauth', async ({ ack, body, client }) => {
    await ack()
    if (!await verifyChannel({ config, body, client })) return
    if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
      const dmChannel = await openDm(client, body.user.id)
      await client.chat.postMessage({
        channel: dmChannel,
        text: '⚠️ Google OAuth is not configured yet. Set the Google client credentials before connecting a recruiter account.',
      })
      return
    }

    const oauthUrl = buildGoogleOAuthUrl(config, JSON.stringify({ recruiterId: body.user.id, source: 'slack_home' }))
    const dmChannel = await openDm(client, body.user.id)
    await client.chat.postMessage({
      channel: dmChannel,
      text: `🔗 Connect Google Calendar and Gmail here: <${oauthUrl}>`,
    })
  });

  app.options('applicant_select', async ({ options, ack }) => {
    await ack({ options: applicantOptions(options.value, getApplicants()) });
  });

  app.options('recruiter_select', async ({ options, ack }) => {
    const recruiters = getTalentRecruiters()
    const slackOptions = personOptions(options.value, recruiters)
    logger.info('recruiter_options_requested', {
      query: options.value,
      recruiterCount: recruiters.length,
      optionCount: slackOptions.length,
      preview: slackOptions.slice(0, 3).map((option) => option.text.text),
    })
    await ack({ options: slackOptions });
  });

  app.options('hm_select', async ({ options, ack, client }) => {
    const { users } = await ensureSlackDirectory({ client, config, logger })
    await ack({ options: personOptions(options.value, users) });
  });

  app.options('guest_select', async ({ options, ack, client }) => {
    const { users } = await ensureSlackDirectory({ client, config, logger })
    await ack({ options: personOptions(options.value, users) });
  });

  app.options('schedule_guest_select', async ({ options, ack, client }) => {
    const { users } = await ensureSlackDirectory({ client, config, logger })
    await ack({ options: personOptions(options.value, users) });
  });

  app.options('attendee_select', async ({ options, ack, client }) => {
    const { users } = await ensureSlackDirectory({ client, config, logger })
    await ack({ options: personOptions(options.value, users) });
  });

  app.options('timezone_select', async ({ options, ack }) => {
    await ack({ options: searchTimezones(options.value) });
  });

  app.view('schedule_intake_submit', async ({ ack, body, view, client }) => {
    const values = view.state.values;
    const templates = await loadSchedulingTemplates();
    const intakeDraft = buildIntakeDraft(values, templates);
    const applicantId = intakeDraft.applicantId;
    const templateId = intakeDraft.templateId;
    const stageKey = intakeDraft.stageKey;
    const recruiterId = intakeDraft.recruiterId;
    const notes = intakeDraft.notes;
    const resumeLink = intakeDraft.resumeLink;
    const interviewWindowStartDate = intakeDraft.interviewWindowStartDate;
    const interviewWindowEndDate = intakeDraft.interviewWindowEndDate;
    const interviewTimezone = intakeDraft.interviewTimezone || defaultTimeZone;
    const requiresHiringManager = stageRequiresHiringManager(stageKey)
    const requiresResume = stageRequiresResumeLink(stageKey)
    const errors = {};

    if (!stageKey) {
      errors.stage_block = 'Choose an interview stage.';
    }

    if (intakeDraft.applicantEmail && !isValidEmail(intakeDraft.applicantEmail)) {
      errors.applicant_email_block = 'Enter a valid applicant email.';
    }
    if (intakeDraft.recruiterEmail && !isValidEmail(intakeDraft.recruiterEmail)) {
      errors[findInputBlockId(values, 'recruiter_email', 'recruiter_email_block')] = 'Enter a valid recruiter email.';
    }
    if (requiresHiringManager && !intakeDraft.hiringManagerId) {
      errors.hm_block = 'Choose a hiring manager.';
    }
    if (requiresHiringManager && !intakeDraft.hiringManagerEmail) {
      errors[findInputBlockId(values, 'hm_email', 'hm_email_block')] = 'Enter hiring manager email.';
    } else if (intakeDraft.hiringManagerEmail && !isValidEmail(intakeDraft.hiringManagerEmail)) {
      errors[findInputBlockId(values, 'hm_email', 'hm_email_block')] = 'Enter a valid hiring manager email.';
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    if ((interviewWindowStartDate && !interviewWindowEndDate) || (!interviewWindowStartDate && interviewWindowEndDate)) {
      await ack({
        response_action: 'errors',
        errors: {
          window_start_block: 'Select both target dates or leave both blank.',
          window_end_block: 'Select both target dates or leave both blank.',
        },
      });
      return;
    }

    if (interviewWindowStartDate && interviewWindowEndDate && !isValidDateRange(interviewWindowStartDate, interviewWindowEndDate)) {
      await ack({
        response_action: 'errors',
        errors: {
          window_end_block: 'End date must be on or after the start date.',
        },
      });
      return;
    }

    if (requiresResume && !resumeLink) {
      await ack({
        response_action: 'errors',
        errors: {
          resume_block: 'Paste a resume link for the 2nd/final interview.',
        },
      });
      return;
    }

    await ack();

    const applicant = intakeDraft.applicant;
    const recruiter = intakeDraft.recruiter;
    const hiringManager = intakeDraft.hiringManager;
    const coordinator = await resolveSlackUser({ client, userId: body.user.id, logger })
    const caseRecord = await store.createCase({
      ownerSlackUserId: body.user.id,
      channelId: getChannelId(body.view) || body.user.id,
      applicant,
      recruiter,
      hiringManager,
      templateId,
      stageKey,
      notes,
      resumeLink,
      interviewWindowStartDate: interviewWindowStartDate || null,
      interviewWindowEndDate: interviewWindowEndDate || null,
      interviewTimezone,
      autofill: {
        zoomLink: recruiter?.zoomLink || '',
        signature: recruiter?.signature || 'Recruitment Team',
        coordinatorEmail: coordinator?.email || '',
        coordinatorName: coordinator?.name || '',
      },
    });

    await store.addAudit({
      caseId: caseRecord.id,
      actorSlackUserId: body.user.id,
      action: 'case_created',
      templateId,
      stageKey,
    });

    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: '✅ Scheduling case created',
      blocks: caseMessageBlocks(caseRecord),
    });
    await publishHome({ client, userId: body.user.id, store, logger });
  });

  app.action('open_candidate_message_modal', async ({ ack, body, client }) => {
    await ack();
    const caseRecord = await requireCase(store, body.actions[0].value);
    const templates = await loadTemplates();
    const template = templates.find((item) => item.id === caseRecord.templateId) || templates[0];
    const renderedTemplate = renderTemplate(template, buildTemplateVariables(caseRecord));
    const smsDraft = buildSmsDraft(caseRecord);
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: candidateMessageModal({ caseRecord, renderedTemplate, smsDraft, recentAudits }),
    });
  });

  app.action('open_reminder_message_modal', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    const caseRecord = await requireCase(store, body.actions[0].value);
    if (!caseRecord.calendarEventId) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: '📅 Create the calendar invite before sending a reminder.',
      });
      return;
    }
    const templates = await loadTemplates();
    const template = templates.find((item) => item.id === 'interview-reminder') || templates[0];
    const renderedTemplate = renderTemplate(template, buildTemplateVariables(caseRecord));
    const smsDraft = buildSmsDraft(caseRecord);
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: candidateMessageModal({
        caseRecord,
        renderedTemplate,
        smsDraft,
        callbackId: 'reminder_message_submit',
        submitText: 'Send',
        recentAudits,
      }),
    });
  });

  app.action('view_resume', async ({ ack, body, client }) => {
    await ack();
    const caseRecord = await requireCase(store, body.actions[0].value);
    if (!caseRecord.resumeLink) {
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, body.user.id),
        text: `📄 No resume link has been added for ${caseRecord.id} yet.`,
      });
      return;
    }

    const details = canOpenResumeReference(caseRecord.resumeLink)
      ? [`📄 Resume for ${caseRecord.id}:`, `🔗 <${caseRecord.resumeLink}|Open resume>`].join('\n')
      : [`📄 Resume for ${caseRecord.id}:`, `Slack file attached: ${caseRecord.resumeLink}`].join('\n');

    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: details,
    });
    await store.addAudit({
      caseId: caseRecord.id,
      actorSlackUserId: body.user.id,
      action: 'resume_viewed',
      resumeLink: caseRecord.resumeLink,
    });
  });

  app.view('candidate_message_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    const plainBody = view.state.values.email_body_block.email_body.value || '';
    const subject = view.state.values.email_subject_block.email_subject.value || '';
    if (hasUnresolvedSchedulePlaceholders(`${subject}\n${plainBody}`)) {
      await ack({
        response_action: 'errors',
        errors: {
          email_body_block: 'Schedule the interview first so Date, Time, and Zoom Link can be filled automatically.',
        },
      });
      return;
    }

    await ack();
    const htmlBody = plainTextToHtml(plainBody);
    const email = {
      subject,
      body: htmlBody,
      htmlBody,
      plainBody,
      to: caseRecord.applicant?.email,
      from: caseRecord.recruiter?.email,
    };
    const smsCopy = view.state.values.sms_block.sms_copy.value || '';
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord, email, store });
    const updated = await store.updateCase(caseId, {
      status: 'Waiting for Candidate',
      candidateEmail: email,
      smsCopy,
      gmailSendStatus: emailResult.mocked ? 'mocked' : 'sent',
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'candidate_email_approved',
      templateId: caseRecord.templateId,
    });
    await publishHome({ client, userId: body.user.id, store, logger });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: `✉️ Candidate message approved for ${caseId}. SMS remains manual.`,
      blocks: caseMessageBlocks(updated),
    });
  });

  app.view('reminder_message_submit', async ({ ack, body, view, client }) => {
    await ack();
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    if (caseRecord.reminderStatus === 'sent' && caseRecord.reminderScheduleVersion === caseRecord.scheduleVersion) {
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, body.user.id),
        text: `⚠️ A reminder has already been sent for schedule version ${caseRecord.scheduleVersion}.`,
      });
      return;
    }
    const plainBody = view.state.values.email_body_block.email_body.value || '';
    const htmlBody = plainTextToHtml(plainBody);
    const email = {
      subject: view.state.values.email_subject_block.email_subject.value,
      body: htmlBody,
      htmlBody,
      plainBody,
      to: caseRecord.applicant?.email,
      from: caseRecord.recruiter?.email,
    };
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord, email, store });
    const updated = await store.updateCase(caseId, {
      reminderEmail: email,
      reminderStatus: emailResult.mocked ? 'mocked' : 'sent',
      reminderScheduleVersion: caseRecord.scheduleVersion || 1,
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'reminder_sent',
      scheduleVersion: updated.reminderScheduleVersion,
    });
    await publishHome({ client, userId: body.user.id, store, logger });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: `🔔 Reminder sent for ${caseId}.`,
      blocks: caseMessageBlocks(updated),
    });
  });

  app.action('open_finalize_modal', async ({ ack, body, client }) => {
    await ack();
    const caseRecord = await requireCase(store, body.actions[0].value);
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: finalizeModal(caseRecord, recentAudits),
    });
  });

  app.action('scheduling_open', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    try {
      const caseId = body.actions?.[0]?.value || body.view?.private_metadata
      const caseRecord = await requireCase(store, caseId)
      const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
      const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
      const attendees = normalizeAttendees(caseRecord, stageRules)
      const recentAudits = await store.listAudits(caseRecord.id, 5)

      await client.views.open({
        trigger_id: body.trigger_id,
        view: schedulingModal(caseRecord, { phase: 1, stageRules, attendees, stageKey }, recentAudits)
      })
    } catch (error) {
      logger.error('scheduling_open_error', { error: error.message })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user?.id || body.user.id),
        user: body.user.id,
        text: `❌ Could not open scheduling: ${error.message}`
      })
    }
  })

  app.view('scheduling_phase_one', async ({ ack, body, view, client }) => {
    try {
      let metadata = {}
      try {
        metadata = JSON.parse(view.private_metadata || '{}')
      } catch (_) {
        metadata = { caseId: view.private_metadata }
      }
      const caseId = metadata.caseId

      const stageKey = normalizeStageKey(view.state.values.stage_block?.stage_select?.selected_option?.value || metadata.stageKey) || '1st-interview'
      const stageOverrides = metadata.stageOverrides || {}

      const attendeeValues = view.state.values.attendee_toggle_block?.attendee_toggle?.selected_options || []
      const selectedEmails = attendeeValues.map((o) => o.value)

      const windowStart = view.state.values.schedule_window_start_block?.schedule_window_start?.selected_date || ''
      const windowEnd = view.state.values.schedule_window_end_block?.schedule_window_end?.selected_date || ''
      const durationStr = view.state.values.duration_block?.duration_select?.selected_option?.value || '30'
      const durationMinutes = parseInt(durationStr, 10)

      const externalAttendees = metadata.externalAttendees || []

      const resolvedRules = resolveStageRules(stageKey, {
        ...stageOverrides,
        durationMinutes
      })

      const caseRecord = await requireCase(store, caseId)
      if (!caseRecord) throw new Error('Case not found')

      await ack({
        response_action: 'update',
        view: {
          ...checkingAvailabilityModal(caseRecord),
          private_metadata: view.private_metadata,
        }
      })

      const attendanceOverrides = {}
      const allAttendees = normalizeAttendees(caseRecord, resolvedRules)
      for (const a of allAttendees) {
        const email = a.email || a.id
        attendanceOverrides[a.id] = selectedEmails.includes(email)
        attendanceOverrides[a.email] = selectedEmails.includes(email)
      }

      const updatedRecord = {
        ...caseRecord,
        stageKey,
        templateId: resolveTemplateFromStage(stageKey) || caseRecord.templateId,
        stageOverrides: { ...caseRecord.stageOverrides, ...stageOverrides, durationMinutes },
        attendanceOverrides: { ...caseRecord.attendanceOverrides, ...attendanceOverrides },
        externalAttendees,
        interviewWindowStartDate: windowStart || caseRecord.interviewWindowStartDate,
        interviewWindowEndDate: windowEnd || caseRecord.interviewWindowEndDate
      }

      const refreshedAttendees = refreshAttendees(updatedRecord, stageKey, { ...stageOverrides, durationMinutes }, { ...caseRecord.attendanceOverrides, ...attendanceOverrides })
      updatedRecord.attendees = refreshedAttendees

      await store.updateCase(caseRecord.id, {
        stageKey,
        templateId: updatedRecord.templateId,
        stageOverrides: updatedRecord.stageOverrides,
        attendanceOverrides: updatedRecord.attendanceOverrides,
        externalAttendees,
        interviewWindowStartDate: updatedRecord.interviewWindowStartDate,
        interviewWindowEndDate: updatedRecord.interviewWindowEndDate,
        attendees: refreshedAttendees
      })

      const result = await runSchedulingPipeline({
        caseRecord: updatedRecord,
        config,
        logger,
        store
      })

      const recentAudits = await store.listAudits(caseRecord.id, 5)

      await client.views.update({
        view_id: body.view.id,
        view: schedulingPhaseTwo(caseRecord, {
          ...result,
          phase: 2,
          mocked: result.warnings?.some((w) => w.includes('mocked')) || false
        }, recentAudits)
      })
    } catch (error) {
      if (!body?.view?.id) {
        logger.error('scheduling_check_availability_error', { error: error.message })
        return
      }
      logger.error('scheduling_check_availability_error', { error: error.message })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.user.id),
        user: body.user.id,
        text: `❌ Could not check availability: ${error.message}`
      })
    }
  })

  app.action('scheduling_edit_attendees', async ({ ack, body, client }) => {
    await ack()
    try {
      const caseId = body.actions?.[0]?.value || body.view?.private_metadata
      let metadata = {}
      try { metadata = JSON.parse(body.view?.private_metadata || '{}') } catch (_) { metadata = {} }
      const resolvedCaseId = caseId || metadata.caseId

      const caseRecord = await requireCase(store, resolvedCaseId)
      const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
      const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
      const attendees = normalizeAttendees(caseRecord, stageRules)
      const recentAudits = await store.listAudits(caseRecord.id, 5)

      await client.views.update({
        view_id: body.view.id,
        view: schedulingModal(caseRecord, {
          phase: 1,
          stageRules,
          attendees,
          stageKey,
          externalAttendees: caseRecord.externalAttendees || []
        }, recentAudits)
      })
    } catch (error) {
      logger.error('scheduling_edit_attendees_error', { error: error.message })
    }
  })

  app.action('scheduling_add_external', async ({ ack, body, client }) => {
    await ack()
    try {
      const caseId = body.actions?.[0]?.value
      const caseRecord = await requireCase(store, caseId)
      const recentAudits = await store.listAudits(caseRecord.id, 5)

      await client.views.push({
        trigger_id: body.trigger_id,
        view: externalAttendeeModal(caseRecord, recentAudits)
      })
    } catch (error) {
      logger.error('scheduling_add_external_error', { error: error.message })
    }
  })

  app.action('attendee_select', async ({ ack, body, client }) => {
    await ack()
    try {
      const caseId = body.view?.private_metadata
      const caseRecord = await requireCase(store, caseId)
      const recentAudits = await store.listAudits(caseRecord.id, 5)
      const person = findPersonById(selectedOptionValue(body))

      await client.views.update({
        view_id: body.view.id,
        hash: body.view.hash,
        view: externalAttendeeModal(caseRecord, recentAudits, buildAttendeeDraft(person))
      })
    } catch (error) {
      logger.error('attendee_select_error', { error: error.message })
    }
  })

  app.view('external_attendee_submit', async ({ ack, body, view, client }) => {
    try {
      const caseId = view.private_metadata
      const caseRecord = await requireCase(store, caseId)

      const selectedAttendeeId = view.state.values.attendee_select_block?.attendee_select?.selected_option?.value || ''
      const selectedPerson = findPersonById(selectedAttendeeId)
      const name = selectedPerson?.name || selectedPerson?.email || ''
      const email = view.state.values.ext_email_block?.ext_email?.value || ''
      const role = view.state.values.ext_role_block?.ext_role?.value ||
        selectedPerson?.positionTitle ||
        selectedPerson?.department ||
        selectedPerson?.role ||
        ''

      if (!email) {
        await ack({
          response_action: 'errors',
          errors: {
            ext_email_block: 'Select an attendee with an email address.',
          },
        })
        return
      }

      const newExternal = {
        id: selectedPerson?.id || `attendee-${crypto.randomUUID()}`,
        name,
        email,
        role: role || 'attendee',
        required: false
      }
      const externalAttendees = [
        ...(caseRecord.externalAttendees || []).filter((attendee) =>
          String(attendee.email || '').toLowerCase() !== String(email).toLowerCase()
        ),
        newExternal
      ]

      await store.updateCase(caseId, { externalAttendees })

      const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
      const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
      const updatedRecord = { ...caseRecord, externalAttendees }
      const attendees = normalizeAttendees(updatedRecord, stageRules)
      const recentAudits = await store.listAudits(caseId, 5)

      await ack({
        response_action: 'update',
        view: schedulingModal(caseRecord, {
          phase: 1,
          stageRules,
          attendees,
          stageKey,
          externalAttendees
        }, recentAudits)
      })
    } catch (error) {
      await ack()
      logger.error('external_attendee_submit_error', { error: error.message })
    }
  })

  app.view('scheduling_phase_two', async ({ ack, body, view, client }) => {
    await ack()
    try {
      let metadata = {}
      try { metadata = JSON.parse(view.private_metadata || '{}') } catch (_) { metadata = {} }

      const caseId = metadata.caseId || body.view?.previous_view_id
      const caseRecord = await requireCase(store, caseId)
      if (!caseRecord) throw new Error('Case not found')

      const slotValue = view.state.values.slot_select_block?.slot_select?.selected_option?.value
      const manualDate = view.state.values.schedule_manual_date_block?.schedule_manual_date?.selected_date
      const manualTime = view.state.values.schedule_manual_time_block?.schedule_manual_time?.selected_option?.value

      if (!slotValue && !(manualDate && manualTime)) {
        await client.chat.postEphemeral({
          channel: resolvePostingChannel(config, body.user.id),
          user: body.user.id,
          text: '⚠️ Select a time slot or provide a manual date and time.'
        })
        return
      }

      const selectedGuests =
        view.state.values.schedule_guest_block?.schedule_guest_select?.selected_options?.map((option) => findPerson(option.value)?.email) ||
        []
      const selectedGuestPeople =
        view.state.values.schedule_guest_block?.schedule_guest_select?.selected_options?.map((option) => findPerson(option.value)).filter(Boolean) ||
        []
      const zoomLink = view.state.values.schedule_zoom_block?.schedule_zoom_link?.value || caseRecord.autofill?.zoomLink || ''

      const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
      const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
      const allAttendees = normalizeAttendees(caseRecord, stageRules)
      const includedEmails = allAttendees.filter((a) => a.included).map((a) => a.email).filter(Boolean)
      const includedPeople = allAttendees.filter((a) => a.included)

      const allAttendeeEmails = [...new Set([...includedEmails, ...selectedGuests])].filter(Boolean)
      const attendeeDetails = mergeAttendeeDetails([...includedPeople, ...selectedGuestPeople], allAttendeeEmails)

      const interviewTimeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
      let startDate, startTime
      if (slotValue) {
        startDate = formatDateForInput(slotValue, interviewTimeZone)
        startTime = formatTimeForInput(slotValue, interviewTimeZone)
      } else {
        const converted = convertLocalDateTimeToZone({
          date: manualDate,
          time: manualTime,
          fromTimeZone: PH_TIME_ZONE,
          toTimeZone: interviewTimeZone,
        })
        startDate = converted.date
        startTime = converted.time
      }

      const eventResult = await createCalendarEvent({
        config,
        logger,
        caseRecord,
        store,
        eventInput: {
          candidateName: [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName].filter(Boolean).join(' '),
          jobTitle: caseRecord.applicant?.jobTitle || 'Interview',
          startDate,
          startTime,
          durationMinutes: stageRules.typicalDurationMinutes,
          zoomLink,
          attendees: allAttendeeEmails,
          timeZone: interviewTimeZone,
        },
      })

      const scheduleInput = buildScheduleSnapshot({
        date: startDate,
        time: startTime,
        zoomLink,
        attendees: allAttendeeEmails,
        attendeeDetails,
        eventId: eventResult.eventId,
        htmlLink: eventResult.googleEvent?.htmlLink || null,
      })

      const updated = await store.updateCase(caseRecord.id, {
        ...applyScheduledEvent(caseRecord, eventResult, scheduleInput),
        selectedSlot: slotValue ? { start: slotValue } : null
      })

      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: body.user.id,
        action: 'calendar_event_approved',
        eventId: eventResult.eventId,
        via: slotValue ? 'slot_selection' : 'manual_entry'
      })

      const reminderEmail = await buildScheduledCandidateEmail(updated)
      const reminderResult = await sendRecruiterEmail({ config, logger, caseRecord: updated, email: reminderEmail, store })
      const attendeeInviteResults = await sendAttendeeInviteEmails({ config, logger, store, caseRecord: updated })
      await store.updateCase(caseRecord.id, {
        reminderEmail,
        reminderStatus: reminderResult.mocked ? 'mocked' : 'sent',
        reminderScheduleVersion: updated.scheduleVersion || 1,
        attendeeInviteStatus: attendeeInviteResults.length === 0
          ? 'none'
          : (attendeeInviteResults.every((result) => result.mocked) ? 'mocked' : 'sent'),
      })
      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: body.user.id,
        action: 'reminder_sent',
        scheduleVersion: updated.scheduleVersion || 1,
      })
      if (attendeeInviteResults.length > 0) {
        await store.addAudit({
          caseId: caseRecord.id,
          actorSlackUserId: body.user.id,
          action: 'attendee_invites_sent',
          count: attendeeInviteResults.length,
        })
      }

      await publishHome({ client, userId: body.user.id, store, logger })
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, body.user.id),
        text: '📅 Interview scheduled',
        blocks: caseMessageBlocks(updated),
      })
    } catch (error) {
      logger.error('scheduling_confirm_error', { error: error.message })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.user.id),
        user: body.user.id,
        text: `❌ Could not schedule interview: ${error.message}`
      })
    }
  })

  app.view('finalize_schedule_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    if (!canFinalizeSchedule(caseRecord)) {
      await ack({
        response_action: 'errors',
        errors: {
          date_block: 'This case is already scheduled. Use Reschedule interview instead.',
        },
      });
      return;
    }

    const selectedTime = view.state.values.time_block.time.selected_option?.value || '';
    if (!isTimeWithinBusinessHours(selectedTime)) {
      await ack({
        response_action: 'errors',
        errors: {
          time_block: `Select a time between 7:00 AM and 4:00 PM ${PH_TIME_ZONE}.`,
        },
      });
      return;
    }

    const interviewTimeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
    const selectedDate = view.state.values.date_block.date.selected_date
    const zoomLink = view.state.values.zoom_block.zoom_link.value || resolveCaseZoomLink(caseRecord)
    const converted = convertLocalDateTimeToZone({
      date: selectedDate,
      time: selectedTime,
      fromTimeZone: PH_TIME_ZONE,
      toTimeZone: interviewTimeZone,
    })
    const selectedGuests =
      view.state.values.guest_block.guest_select.selected_options?.map((option) => findPerson(option.value)?.email).filter(Boolean) ||
      []
    const finalizeStageKey = normalizeStageKey(
      view.state.values.stage_block?.stage_select?.selected_option?.value ||
      caseRecord.stageKey ||
      resolveStageFromTemplate(caseRecord.templateId)
    ) || '1st-interview'
    const durationMinutes = Number(view.state.values.duration_block?.duration_select?.selected_option?.value || 30)
    const stageOverrides = { ...caseRecord.stageOverrides, durationMinutes }
    const finalizeStageRules = resolveStageRules(finalizeStageKey, stageOverrides)
    const finalCaseRecord = {
      ...caseRecord,
      stageKey: finalizeStageKey,
      templateId: resolveTemplateFromStage(finalizeStageKey) || caseRecord.templateId,
      stageOverrides,
    }
    const includedEmails = normalizeAttendees(finalCaseRecord, finalizeStageRules)
      .filter((attendee) => attendee.included)
      .map((attendee) => attendee.email)
      .filter(Boolean)
    const includedPeople = normalizeAttendees(finalCaseRecord, finalizeStageRules).filter((attendee) => attendee.included)
    const selectedGuestPeople =
      view.state.values.guest_block.guest_select.selected_options?.map((option) => findPerson(option.value)).filter(Boolean) ||
      []
    const attendees = [...new Set([...includedEmails, ...selectedGuests])]
    const attendeeDetails = mergeAttendeeDetails([...includedPeople, ...selectedGuestPeople], attendees)
    const scheduleInput = {
      candidateName: [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName].filter(Boolean).join(' '),
      jobTitle: caseRecord.applicant?.jobTitle || 'Interview',
      startDate: converted.date,
      startTime: converted.time,
      durationMinutes,
      zoomLink,
      attendees,
      attendeeDetails,
      timeZone: interviewTimeZone,
      stageKey: finalizeStageKey,
      templateId: finalCaseRecord.templateId,
      stageOverrides,
    }
    const previewCaseRecord = {
      ...finalCaseRecord,
      selectedInterviewDate: converted.date,
      selectedInterviewTime: converted.time,
      currentSchedule: buildScheduleSnapshot({
        date: converted.date,
        time: converted.time,
        zoomLink,
        attendees,
        attendeeDetails,
      }),
    }
    const renderedTemplate = await buildScheduledCandidateEmail(previewCaseRecord)
    const recentAudits = await store.listAudits(caseId, 5)
    await ack({
      response_action: 'update',
      view: finalizeEmailPreviewModal({
        caseRecord: previewCaseRecord,
        scheduleInput,
        renderedTemplate,
        recentAudits,
      }),
    })
  });

  app.view('finalize_email_preview_submit', async ({ ack, body, view, client }) => {
    const metadata = parseRequiredPrivateMetadata(view.private_metadata)
    const caseId = metadata.caseId
    const scheduleInput = metadata.scheduleInput
    const caseRecord = await requireCase(store, caseId)
    if (!canFinalizeSchedule(caseRecord)) {
      await ack({
        response_action: 'errors',
        errors: {
          email_subject_block: 'This case is already scheduled. Use Reschedule interview instead.',
        },
      })
      return
    }

    await ack()
    const finalCaseRecord = {
      ...caseRecord,
      stageKey: scheduleInput.stageKey || caseRecord.stageKey,
      templateId: scheduleInput.templateId || caseRecord.templateId,
      stageOverrides: scheduleInput.stageOverrides || caseRecord.stageOverrides || {},
    }
    const eventResult = await createCalendarEvent({
      config,
      logger,
      caseRecord: finalCaseRecord,
      store,
      eventInput: scheduleInput,
    });

    const scheduleSnapshot = buildScheduleSnapshot({
      date: scheduleInput.startDate,
      time: scheduleInput.startTime,
      zoomLink: scheduleInput.zoomLink,
      attendees: scheduleInput.attendees,
      eventId: eventResult.eventId,
      htmlLink: eventResult.googleEvent?.htmlLink || null,
    });
    const updated = await store.updateCase(caseId, {
      ...applyScheduledEvent(finalCaseRecord, eventResult, scheduleSnapshot),
      stageKey: finalCaseRecord.stageKey,
      templateId: finalCaseRecord.templateId,
      stageOverrides: finalCaseRecord.stageOverrides,
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'calendar_event_approved',
      eventId: eventResult.eventId,
    });

    const emailSubject = view.state.values.email_subject_block.email_subject.value
    const emailBody = view.state.values.email_body_block.email_body.value
    const reminderEmail = {
      ...(await buildScheduledCandidateEmail(updated)),
      subject: emailSubject,
      body: plainTextToHtml(emailBody),
      plainBody: emailBody,
    }
    const reminderResult = await sendRecruiterEmail({ config, logger, caseRecord: updated, email: reminderEmail, store });
    const attendeeInviteResults = await sendAttendeeInviteEmails({ config, logger, store, caseRecord: updated })
    const reminderUpdated = await store.updateCase(caseId, {
      reminderEmail,
      reminderStatus: reminderResult.mocked ? 'mocked' : 'sent',
      reminderScheduleVersion: updated.scheduleVersion || 1,
      attendeeInviteStatus: attendeeInviteResults.length === 0
        ? 'none'
        : (attendeeInviteResults.every((result) => result.mocked) ? 'mocked' : 'sent'),
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'reminder_sent',
      scheduleVersion: reminderUpdated.reminderScheduleVersion,
    });
    if (attendeeInviteResults.length > 0) {
      await store.addAudit({
        caseId,
        actorSlackUserId: body.user.id,
        action: 'attendee_invites_sent',
        count: attendeeInviteResults.length,
      });
    }
    await publishHome({ client, userId: body.user.id, store, logger });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: '📅 Interview scheduled',
      blocks: caseMessageBlocks(reminderUpdated),
    });
  });

  app.view('schedule_tracker_submit', async ({ ack, body, view }) => {
    const metadata = parseViewMetadata(view.private_metadata)
    const ownerSlackUserId = metadata.ownerSlackUserId || body.user.id
    const filters = readTrackerFilters(view.state.values)
    const scope = filters.scope || 'all'
    const scheduledCases = await getScheduledCases(store, ownerSlackUserId, scope)
    const filteredCases = filterScheduledCases(scheduledCases, filters)

    await ack({
      response_action: 'update',
      view: scheduleTrackerModal({
        cases: filteredCases,
        filters,
        scope,
        ownerSlackUserId,
        totalCount: scheduledCases.length,
      }),
    });
  });

  app.action('open_reschedule_modal', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    const caseRecord = await requireCase(store, body.actions[0].value);
    if (!canStartReschedule(caseRecord)) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: '⚠️ This interview is already being rescheduled or is not scheduled yet.',
      });
      return;
    }
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: rescheduleModal(caseRecord, recentAudits),
    });
  });

  app.view('reschedule_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    if (!canStartReschedule(caseRecord)) {
      await ack({
        response_action: 'errors',
        errors: {
          reschedule_reason_block: 'This interview is already being rescheduled.',
        },
      });
      return;
    }

    const selectedTime = view.state.values.time_block.time.selected_option?.value || '';
    if (!isTimeWithinBusinessHours(selectedTime)) {
      await ack({
        response_action: 'errors',
        errors: {
          time_block: `Select a time between 7:00 AM and 4:00 PM ${PH_TIME_ZONE}.`,
        },
      });
      return;
    }

    await ack();
    const interviewTimeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
    const selectedDate = view.state.values.date_block.date.selected_date
    const converted = convertLocalDateTimeToZone({
      date: selectedDate,
      time: selectedTime,
      fromTimeZone: PH_TIME_ZONE,
      toTimeZone: interviewTimeZone,
    })
    const selectedGuests =
      view.state.values.guest_block.guest_select.selected_options?.map((option) => findPerson(option.value)?.email) ||
      [];
    const attendees = [
      caseRecord.applicant?.email,
      caseRecord.recruiter?.email,
      caseRecord.hiringManager?.email,
      ...selectedGuests,
    ].filter(Boolean);

    const request = {
      actorSlackUserId: body.user.id,
      reason: view.state.values.reschedule_reason_block.reschedule_reason.value,
      date: converted.date,
      time: converted.time,
      zoomLink: view.state.values.zoom_block.zoom_link.value,
      note: view.state.values.candidate_note_block.candidate_note.value || '',
      attendees,
    };
    const email = buildRescheduleEmail(caseRecord, request);
    request.email = email;

    const updated = await store.updateCase(caseId, applyRescheduleRequest(caseRecord, request));
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'reschedule_requested',
      reason: request.reason,
    });
    await publishHome({ client, userId: body.user.id, store, logger });
    const recentAudits = await store.listAudits(caseId, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: rescheduleApprovalModal({ caseRecord: updated, email, recentAudits }),
    });
  });

  app.view('reschedule_approval_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    const request = caseRecord.pendingReschedule;
    if (!request || caseRecord.rescheduleStatus !== 'requested') {
      await ack({
        response_action: 'errors',
        errors: {
          email_subject_block: 'There is no pending reschedule request to approve.',
        },
      });
      return;
    }

    await ack();
    const plainBody = view.state.values.email_body_block.email_body.value || '';
    const htmlBody = plainTextToHtml(plainBody);
    const email = {
      ...request.email,
      subject: view.state.values.email_subject_block.email_subject.value,
      body: htmlBody,
      htmlBody,
      plainBody,
    };
    const rescheduleStageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
    const rescheduleStageRules = resolveStageRules(rescheduleStageKey, caseRecord.stageOverrides)
    const eventResult = await updateCalendarEvent({
      config,
      logger,
      caseRecord,
      store,
      eventInput: {
        candidateName: [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName].filter(Boolean).join(' '),
        jobTitle: caseRecord.applicant?.jobTitle || 'Interview',
        startDate: request.date,
        startTime: request.time,
        durationMinutes: rescheduleStageRules.typicalDurationMinutes,
        zoomLink: request.zoomLink,
        attendees: request.attendees,
        timeZone: caseRecord.interviewTimezone || SYDNEY_TIME_ZONE,
      },
    });
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord, email, store });
    const completedRequest = { ...request, email };
    const updated = await store.updateCase(
      caseId,
      applyCompletedReschedule(caseRecord, eventResult, completedRequest, emailResult),
    );
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'reschedule_candidate_message_approved',
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'calendar_event_updated',
      eventId: eventResult.eventId,
    });
    if (caseRecord.reminderStatus && caseRecord.reminderStatus !== 'sent') {
      await store.addAudit({
        caseId,
        actorSlackUserId: body.user.id,
        action: 'reminder_rescheduled',
        scheduleVersion: updated.scheduleVersion,
      });
    }
    await publishHome({ client, userId: body.user.id, store, logger });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: '🔄 Interview rescheduled',
      blocks: caseMessageBlocks(updated),
    });
  });

  app.action('cancel_interview', async ({ ack, body, client }) => {
    await ack();
    const caseRecord = await requireCase(store, body.actions[0].value);
    const updated = await store.updateCase(caseRecord.id, applyCancelledInterview(caseRecord, body.user.id));
    await store.addAudit({
      caseId: caseRecord.id,
      actorSlackUserId: body.user.id,
      action: 'reschedule_cancelled',
    });
    await publishHome({ client, userId: body.user.id, store, logger });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: '⚠️ Interview marked as needing attention. Calendar cancellation is not automatic yet.',
      blocks: caseMessageBlocks(updated),
    });
  });

  app.action('view_calendar_details', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    const caseRecord = await requireCase(store, body.actions[0].value);
    const schedule = caseRecord.currentSchedule || {};
    const eventLink = caseRecord.calendarEventHtmlLink || schedule.htmlLink || calendarEventUrl(caseRecord.calendarEventId) || null;

    const lines = [
      eventLink
        ? `📅 *Calendar:* <${eventLink}|Open in Google Calendar>`
        : (caseRecord.calendarEventId ? '📅 Calendar event created' : '📅 *Calendar:* not created yet'),
      `📅 *Date:* ${schedule.date || 'TBD'}`,
      `🕐 *Time:* ${schedule.time || 'TBD'}`,
      `🔗 *Zoom:* ${schedule.zoomLink || caseRecord.autofill?.zoomLink || 'TBD'}`,
    ];

    await client.chat.postEphemeral({
      channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
      user: body.user.id,
      text: lines.join('\n'),
    });
  });
}

async function openIntakeModal({
  client,
  triggerId,
  config,
  logger,
  privateMetadata = '',
  timeZones = [],
  defaultTimeZone,
}) {
  const templates = await loadSchedulingTemplates();
  ensureSlackDirectory({ client, config, logger }).catch((error) => {
    logger.warn('slack_directory_background_failed', { error: error.message })
  })
  const meta = JSON.stringify({ channelId: privateMetadata, showDetails: false });
  logger.info('schedule_intake_opened', { templateCount: templates.length });
  await client.views.open({
    trigger_id: triggerId,
    view: {
      ...intakeModal({ templates, timeZones, defaultTimeZone, recruiters: getTalentRecruiters() }),
      private_metadata: meta,
    },
  });
}

function parsePrivateMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* not JSON */ }
  return null;
}

function parseRequiredPrivateMetadata(raw) {
  const parsed = parsePrivateMetadata(raw)
  if (!parsed) throw new Error('Invalid view metadata')
  return parsed
}

function getChannelId(view) {
  const parsed = parsePrivateMetadata(view?.private_metadata);
  if (parsed?.channelId) return parsed.channelId;
  return view?.private_metadata || '';
}

function getShowDetails(view, fallback) {
  const parsed = parsePrivateMetadata(view?.private_metadata);
  if (parsed && 'showDetails' in parsed) return parsed.showDetails;
  if (fallback !== undefined) return fallback;
  return false;
}

function buildPrivateMetadata(view, overrides = {}) {
  const parsed = parsePrivateMetadata(view?.private_metadata) || {};
  const channelId = overrides.channelId || parsed.channelId || view?.private_metadata || '';
  const showDetails = 'showDetails' in overrides ? overrides.showDetails : parsed.showDetails;
  return JSON.stringify({ channelId, showDetails });
}

async function refreshIntakeModal({
  client,
  body,
  templates,
  selectedKey,
  selectedId,
  selectedPerson,
  showDetails,
  timeZones = [],
  defaultTimeZone,
}) {
  if (!body.view?.id || !body.view?.hash) return;
  const overrides = { [selectedKey]: selectedId }
  if (selectedKey === 'recruiter' && selectedPerson) {
    overrides.recruiterPerson = selectedPerson
    overrides.recruiterEmail = selectedPerson.email || ''
  }
  if (selectedKey === 'hiringManager' && selectedPerson) {
    overrides.hiringManagerPerson = selectedPerson
    overrides.hiringManagerEmail = selectedPerson.email || ''
  }
  const draft = buildIntakeDraft(body.view.state.values, templates, overrides);

  const resolvedShowDetails = showDetails !== undefined
    ? showDetails
    : getShowDetails(body.view, false);

  draft.showDetails = resolvedShowDetails;
  if (draft.showDetails && draft.applicantId) {
    const cachedDetail = getApplicantDetail(draft.applicantId);
    if (cachedDetail) {
      draft.applicantDetail = cachedDetail;
    } else if (draft.applicant) {
      draft.applicantDetail = {
        email: draft.applicant.email || '',
        phone: draft.applicant.phone || '',
        jobTitle: draft.applicant.jobTitle || '',
        stage: draft.applicant.stage || '',
        source: draft.applicant.source || '',
        applyDate: '',
        rating: '',
        address: '',
        resumeUrl: '',
        resumeText: '',
        linkedinUrl: '',
        education: '',
        experience: '',
        notes: '',
      };
    } else {
      draft.applicantDetail = null;
    }
  }

  const privateMetadata = buildPrivateMetadata(body.view, {
    channelId: getChannelId(body.view) || body.channel?.id || body.user.id,
    showDetails: resolvedShowDetails,
  });

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: {
      ...intakeModal({ templates, draft, timeZones, defaultTimeZone, recruiters: getTalentRecruiters() }),
      private_metadata: privateMetadata,
    },
  });
}

async function refreshSchedulingModal({ client, body, store, selectedStageKey }) {
  if (!body.view?.id || !body.view?.hash) return
  let metadata = {}
  try {
    metadata = JSON.parse(body.view.private_metadata || '{}')
  } catch (_) {
    metadata = { caseId: body.view.private_metadata }
  }

  const caseRecord = await requireCase(store, metadata.caseId)
  const stageKey = normalizeStageKey(selectedStageKey || caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
  const durationMinutes = Number(
    body.view.state.values.duration_block?.duration_select?.selected_option?.value ||
    caseRecord.stageOverrides?.durationMinutes ||
    resolveStageRules(stageKey).typicalDurationMinutes
  )
  const stageOverrides = { ...(metadata.stageOverrides || {}), durationMinutes }
  const stageRules = resolveStageRules(stageKey, stageOverrides)
  const updatedRecord = {
    ...caseRecord,
    stageKey,
    templateId: resolveTemplateFromStage(stageKey) || caseRecord.templateId,
    stageOverrides,
    interviewWindowStartDate:
      body.view.state.values.schedule_window_start_block?.schedule_window_start?.selected_date ||
      caseRecord.interviewWindowStartDate,
    interviewWindowEndDate:
      body.view.state.values.schedule_window_end_block?.schedule_window_end?.selected_date ||
      caseRecord.interviewWindowEndDate,
    externalAttendees: metadata.externalAttendees || caseRecord.externalAttendees || [],
  }
  const attendees = normalizeAttendees(updatedRecord, stageRules)
  const recentAudits = await store.listAudits(caseRecord.id, 5)

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: schedulingModal(updatedRecord, {
      phase: 1,
      stageRules,
      attendees,
      stageKey,
      externalAttendees: updatedRecord.externalAttendees,
    }, recentAudits),
  })
}

async function publishHome({ client, userId, store, logger }) {
  const [myCases, allCases] = await Promise.all([store.listCasesForUser(userId), store.listCases()]);
  const teamCases = allCases.filter((item) => item.ownerSlackUserId !== userId && item.status !== 'Scheduled');
  const googleConnected = typeof store.hasGoogleToken === 'function' ? await store.hasGoogleToken(userId) : false;
  try {
    await client.views.publish({
      user_id: userId,
      view: homeView({ myCases, teamCases, googleConnected }),
    });
  } catch (error) {
    logger.error('home_publish_failed', { userId, error: error.message });
  }
}

async function requireCase(store, caseId) {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error(`Case not found: ${caseId}`);
  return caseRecord;
}

async function buildScheduledCandidateEmail(caseRecord) {
  const templates = await loadTemplates()
  const template = templates.find((item) => item.id === caseRecord.templateId)
  if (!template) return buildReminderEmail(caseRecord)
  const rendered = renderTemplate(template, buildTemplateVariables(caseRecord))
  return {
    subject: rendered.subject,
    body: rendered.body,
    htmlBody: rendered.body,
    plainBody: rendered.plainBody,
    to: caseRecord.applicant?.email,
    from: caseRecord.recruiter?.email,
  }
}

async function sendAttendeeInviteEmails({ config, logger, store, caseRecord }) {
  const recipients = attendeeInviteRecipients(caseRecord)
  const results = []
  for (const attendee of recipients) {
    const email = buildAttendeeInviteEmail(caseRecord, attendee)
    const result = await sendRecruiterEmail({ config, logger, caseRecord, email, store })
    results.push(result)
  }
  return results
}

export function attendeeInviteRecipients(caseRecord) {
  const schedule = caseRecord.currentSchedule || {}
  const scheduledEmails = new Set((schedule.attendees || caseRecord.guests || []).map(normalizeEmail).filter(Boolean))
  const excludedEmails = new Set([
    normalizeEmail(caseRecord.applicant?.email),
    normalizeEmail(caseRecord.recruiter?.email),
  ].filter(Boolean))

  const details = Array.isArray(schedule.attendeeDetails) && schedule.attendeeDetails.length > 0
    ? schedule.attendeeDetails
    : normalizeAttendees(caseRecord, resolveStageRules(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId), caseRecord.stageOverrides))

  const byEmail = new Map()
  for (const attendee of details) {
    const email = normalizeEmail(attendee.email)
    if (!email || excludedEmails.has(email)) continue
    if (scheduledEmails.size > 0 && !scheduledEmails.has(email)) continue
    byEmail.set(email, {
      name: attendee.name || attendee.email || 'there',
      email: attendee.email,
      role: attendee.positionTitle || attendee.role || 'interviewer',
    })
  }

  return [...byEmail.values()]
}

export function buildAttendeeInviteEmail(caseRecord, attendee) {
  const schedule = caseRecord.currentSchedule || {}
  const candidateName = [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName].filter(Boolean).join(' ') || 'the candidate'
  const jobTitle = caseRecord.applicant?.jobTitle || 'the role'
  const subject = `Interview invite: ${candidateName} - ${jobTitle}`
  const plainBody = [
    `Hi ${attendee.name || 'there'},`,
    '',
    `You are included as an interviewer/attendee for ${candidateName}'s interview for ${jobTitle}.`,
    '',
    `Date: ${schedule.date || caseRecord.selectedInterviewDate || 'TBD'}`,
    `Time: ${schedule.time || caseRecord.selectedInterviewTime || 'TBD'} ${caseRecord.interviewTimezone || ''}`.trim(),
    `Zoom link: ${schedule.zoomLink || caseRecord.autofill?.zoomLink || 'TBD'}`,
    '',
    `Recruiter: ${caseRecord.recruiter?.name || ''}${caseRecord.recruiter?.email ? ` (${caseRecord.recruiter.email})` : ''}`.trim(),
    '',
    'Thank you.',
  ].join('\n')

  return {
    subject,
    body: plainTextToHtml(plainBody),
    htmlBody: plainTextToHtml(plainBody),
    plainBody,
    to: attendee.email,
    from: caseRecord.recruiter?.email,
  }
}

function mergeAttendeeDetails(people, scheduledEmails) {
  const emailSet = new Set((scheduledEmails || []).map(normalizeEmail).filter(Boolean))
  const byEmail = new Map()
  for (const person of people || []) {
    const email = normalizeEmail(person?.email)
    if (!email || !emailSet.has(email)) continue
    byEmail.set(email, {
      id: person.id || email,
      name: person.name || person.email || email,
      email: person.email,
      role: person.role || 'attendee',
      positionTitle: person.positionTitle || person.department || '',
    })
  }
  for (const email of emailSet) {
    if (!byEmail.has(email)) {
      byEmail.set(email, { id: email, name: email, email, role: 'attendee', positionTitle: '' })
    }
  }
  return [...byEmail.values()]
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function parseViewMetadata(privateMetadata) {
  try {
    return JSON.parse(privateMetadata || '{}')
  } catch {
    return {}
  }
}

function readTrackerFilters(values) {
  return {
    scope: values.tracker_scope_block?.tracker_scope?.selected_option?.value || 'all',
    candidate: values.tracker_candidate_block?.tracker_candidate?.value?.trim() || '',
    recruiter: values.tracker_recruiter_block?.tracker_recruiter?.value?.trim() || '',
    hiringManager: values.tracker_hm_block?.tracker_hm?.value?.trim() || '',
    date: values.tracker_date_block?.tracker_date?.selected_date || '',
    time: values.tracker_time_block?.tracker_time?.value?.trim() || '',
  }
}

async function getScheduledCases(store, ownerSlackUserId, scope = 'all') {
  const allCases = await store.listCases()
  return allCases
    .filter((item) => isScheduledCase(item))
    .filter((item) => {
      if (scope === 'my') return item.ownerSlackUserId === ownerSlackUserId
      if (scope === 'team') return item.ownerSlackUserId !== ownerSlackUserId
      return true
    })
    .sort(compareScheduledCases)
}

function filterScheduledCases(cases, filters) {
  return cases.filter((caseRecord) => {
    const schedule = caseRecord.currentSchedule || {}
    const candidateText = buildCaseSearchText(caseRecord.applicant)
    const recruiterText = buildCaseSearchText(caseRecord.recruiter)
    const hiringManagerText = buildCaseSearchText(caseRecord.hiringManager)

    if (filters.candidate && !candidateText.includes(filters.candidate.toLowerCase())) return false
    if (filters.recruiter && !recruiterText.includes(filters.recruiter.toLowerCase())) return false
    if (filters.hiringManager && !hiringManagerText.includes(filters.hiringManager.toLowerCase())) return false
    if (filters.date && !matchesDateFilter(caseRecord, schedule, filters.date)) return false
    if (filters.time && !matchesTimeFilter(caseRecord, schedule, filters.time)) return false

    return true
  })
}

function buildCaseSearchText(person) {
  if (!person) return ''
  return [person.name, person.firstName, person.lastName, person.email]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function matchesDateFilter(caseRecord, schedule, dateFilter) {
  const date = schedule.date || caseRecord.selectedInterviewDate || ''
  return date === dateFilter
}

function matchesTimeFilter(caseRecord, schedule, timeFilter) {
  const time = schedule.time || caseRecord.selectedInterviewTime || ''
  return time.toLowerCase().includes(timeFilter.toLowerCase())
}

function compareScheduledCases(left, right) {
  const leftSort = scheduledCaseSortKey(left)
  const rightSort = scheduledCaseSortKey(right)
  return rightSort.localeCompare(leftSort)
}

function scheduledCaseSortKey(caseRecord) {
  const schedule = caseRecord.currentSchedule || {}
  const date = schedule.date || caseRecord.selectedInterviewDate || ''
  const time = schedule.time || caseRecord.selectedInterviewTime || '00:00'
  const scheduleKey = date ? `${date}T${time}` : ''
  const updatedKey = caseRecord.updatedAt || caseRecord.lastActionAt || caseRecord.createdAt || ''
  return scheduleKey || updatedKey || ''
}

export function buildTemplateVariables(caseRecord) {
  const currentSchedule = caseRecord.currentSchedule || {};
  const date = currentSchedule.date || caseRecord.selectedInterviewDate || '';
  const time = currentSchedule.time || caseRecord.selectedInterviewTime || '';
  const link = currentSchedule.zoomLink || caseRecord.autofill?.zoomLink || '';
  const hiringManagerName = caseRecord.hiringManager?.name || '';
  const positionTitle = caseRecord.hiringManager?.positionTitle || '';
  const resolvedStageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId));
  const interviewStage = stageLabel(resolvedStageKey);

  return {
    applicant_first_name: caseRecord.applicant?.firstName || '',
    job_title: caseRecord.applicant?.jobTitle || '',
    interview_stage: interviewStage,
    date,
    Date: date,
    time,
    Time: time,
    timezone: caseRecord.interviewTimezone || '',
    Timezone: caseRecord.interviewTimezone || '',
    link,
    Link: link,
    hiring_manager_name: hiringManagerName,
    position_title: positionTitle,
    schedule_your_interview_here: '',
    recruiter_phone_line: recruiterContactLine(caseRecord),
  };
}

function recruiterContactLine(caseRecord) {
  const phoneLine = recruiterPhoneLine(caseRecord.recruiter)
  if (phoneLine) return phoneLine

  const recruiterName = caseRecord.recruiter?.name || 'Recruiter'
  const recruiterEmail = caseRecord.recruiter?.email || ''
  const coordinatorEmail = resolveCoordinatorEmail(caseRecord)
  return [
    recruiterEmail ? `${recruiterName}: ${recruiterEmail}` : recruiterName,
    coordinatorEmail ? `Coordinator: ${coordinatorEmail}` : '',
  ].filter(Boolean).join(' | ')
}

function resolveCoordinatorEmail(caseRecord) {
  if (caseRecord.autofill?.coordinatorEmail) return caseRecord.autofill.coordinatorEmail
  const ownerId = caseRecord.ownerSlackUserId
  return getSlackUsers().find((user) => user.slackUserId === ownerId || user.id === ownerId)?.email || ''
}

export function buildIntakeDraft(values, templates, overrides = {}) {
  const applicantId = overrides.applicant ?? (values.applicant_block?.applicant_select?.selected_option?.value || '');
  const selectedStageKey = overrides.stageKey ?? (values.stage_block?.stage_select?.selected_option?.value || '');
  const legacyTemplateId = overrides.templateId ?? (values.template_block?.template_select?.selected_option?.value || '');
  const stageKey = normalizeStageKey(selectedStageKey || resolveStageFromTemplate(legacyTemplateId));
  const templateId = resolveTemplateFromStage(stageKey) || legacyTemplateId;
  const interviewTimezone = overrides.interviewTimezone ?? (values.timezone_block?.timezone_select?.selected_option?.value || '');

  const applicant = applyEmailOverride(
    findApplicant(applicantId),
    getInputValue(values, 'applicant_email'),
  );
  const requiresHiringManager = stageRequiresHiringManager(stageKey)
  const selectedRecruiterId = overrides.recruiter ?? (values.recruiter_block?.recruiter_select?.selected_option?.value || '');
  const recruiterId = selectedRecruiterId || applicant?.recruiterId || '';
  const hiringManagerId = requiresHiringManager
    ? overrides.hiringManager ?? (values.hm_block?.hm_select?.selected_option?.value || applicant?.hiringManagerId || '')
    : ''
  const recruiterEmailOverride =
    overrides.recruiterEmail !== undefined ? overrides.recruiterEmail : getInputValue(values, 'recruiter_email')
  const hiringManagerEmailOverride =
    requiresHiringManager
      ? (overrides.hiringManagerEmail !== undefined ? overrides.hiringManagerEmail : getInputValue(values, 'hm_email'))
      : ''
  const recruiter = applyEmailOverride(
    overrides.recruiterPerson || findPersonById(recruiterId),
    recruiterEmailOverride,
  );
  const hiringManager = requiresHiringManager
    ? applyEmailOverride(
        overrides.hiringManagerPerson || findPersonById(hiringManagerId),
        hiringManagerEmailOverride,
      )
    : null
  const template = templates.find((item) => item.id === templateId);
  const stageOption = stageKey
    ? toSlackOption(stageLabel(stageKey), stageKey)
    : undefined;

  return {
    applicantId,
    recruiterId,
    hiringManagerId,
    templateId,
    stageKey,
    applicant,
    recruiter,
    hiringManager,
    applicantOption: applicant ? toSlackOption(applicantPickerLabel(applicant), applicant.id) : undefined,
    recruiterOption: recruiter ? toSlackOption(personPickerLabel(recruiter), recruiter.id) : undefined,
    hiringManagerOption: hiringManager ? toSlackOption(personPickerLabel(hiringManager), hiringManager.id) : undefined,
    templateOption: template ? toSlackOption(template.label, template.id) : undefined,
    stageOption,
    applicantEmail: applicant?.email || '',
    recruiterEmail: recruiter?.email || '',
    hiringManagerEmail: hiringManager?.email || '',
    notes: getInputValue(values, 'notes'),
    resumeLink: extractResumeLink(values),
    interviewWindowStartDate: values.window_start_block?.window_start?.selected_date || '',
    interviewWindowEndDate: values.window_end_block?.window_end?.selected_date || '',
    interviewTimezone,
  };
}

function getInputValue(values, actionId) {
  for (const block of Object.values(values || {})) {
    const element = findElementByActionId(block, actionId)
    if (element && 'value' in element) return element.value?.trim() || ''
  }
  return ''
}

function findInputBlockId(values, actionId, fallback) {
  for (const [blockId, block] of Object.entries(values || {})) {
    if (findElementByActionId(block, actionId)) return blockId
  }
  return fallback
}

function findElementByActionId(block, actionId) {
  if (!block) return null
  if (block[actionId]) return block[actionId]
  const dynamicPrefix = `${actionId}_`
  const matchedActionId = Object.keys(block).find((key) => key.startsWith(dynamicPrefix))
  return matchedActionId ? block[matchedActionId] : null
}

function resolveSchedulingTimeZones(config) {
  const list = config?.scheduling?.timeZones || []
  const normalized = list.map((timeZone) => String(timeZone || '').trim()).filter(Boolean)
  return normalized.length > 0 ? normalized : [SYDNEY_TIME_ZONE]
}

function selectedOptionValue(body) {
  return body.actions?.[0]?.selected_option?.value || '';
}

function selectedOptionLabel(body) {
  return body.actions?.[0]?.selected_option?.text?.text || ''
}

function personFromSelectedOption(body) {
  const id = selectedOptionValue(body)
  if (!id) return null
  const label = selectedOptionLabel(body)
  const name = label.split('\n')[0].split(' - ')[0].trim() || id
  return {
    id,
    slackUserId: id,
    name,
    email: '',
    source: 'slack',
  }
}

function findPersonInList(id, people) {
  const value = String(id || '').trim()
  if (!value) return null
  return people.find((person) => person.id === value || person.slackUserId === value) || null
}

function stageRequiresHiringManager(stageKey) {
  const normalized = normalizeStageKey(stageKey)
  return normalized === '2nd-interview' || normalized === 'final-interview'
}

function stageRequiresResumeLink(stageKey) {
  return stageRequiresHiringManager(stageKey)
}

function canOpenResumeReference(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function resolveCaseZoomLink(caseRecord) {
  return caseRecord.currentSchedule?.zoomLink ||
    caseRecord.autofill?.zoomLink ||
    caseRecord.recruiter?.zoomLink ||
    ''
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function applyEmailOverride(person, emailOverride) {
  if (!person) return null;
  const email = String(emailOverride || '').trim();
  if (!email) return person;
  return {
    ...person,
    email,
  };
}

function findPersonById(id) {
  const value = String(id || '').trim();
  if (!value) return undefined;
  return findPerson(value) || findPerson(`rec-${value}`) || findPerson(`hm-${value}`);
}

function buildAttendeeDraft(person) {
  if (!person) return {}
  return {
    attendeeOption: toSlackOption(personPickerLabel(person), person.id),
    email: person.email || '',
    role: person.positionTitle || person.department || person.role || '',
  }
}

function asRecruiter(person) {
  if (!person) return null
  return {
    ...person,
    role: 'recruiter',
  }
}

function asHiringManager(person) {
  if (!person) return null
  return {
    ...person,
    role: 'hiring_manager',
  }
}

function buildSmsDraft(caseRecord) {
  return [
    `Hi, ${caseRecord.applicant?.firstName || '[Candidate]'}!`,
    '',
    `This is ${caseRecord.recruiter?.name || '[Recruiter]'} from the Outsourced Pro Global recruitment team.`,
    '',
    `We would like to invite you for an interview for the ${caseRecord.applicant?.jobTitle || '[job_title]'} role. Let me know if the target schedule works well for you.`,
    '',
    'Thank you!',
  ].join('\n');
}

function extractResumeLink(values) {
  const resumeElement = values.resume_block?.resume_link
  return resumeElement?.value?.trim() || ''
}

async function openDm(client, userId) {
  const result = await client.conversations.open({ users: userId })
  return result.channel.id
}

function hasUnresolvedSchedulePlaceholders(value) {
  return /\[(date|time|link|zoom_link)\]/i.test(String(value || ''))
}

function previewPeople(people) {
  if (!people || people.length === 0) return 'none'
  return people
    .slice(0, 3)
    .map((person) => person.name || person.email || person.id || 'Unknown')
    .join(', ')
}

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
import { loadSchedulingTemplates, loadTemplates, plainTextToHtml, renderTemplate, signedEmailBodiesFromPlainText, stripSignatureHtml } from '../templates.js'
import { buildGoogleOAuthUrl, createCalendarEvent, getGoogleTokenOwner, sendRecruiterEmail, updateCalendarEvent } from '../services/google.js'
import { fetchApplicantDetail, inactiveApplicantReason, refreshJazzhrCache } from '../services/jazzhr.js'
import { createJazzhrLiveSearchManager } from '../services/jazzhr-live-search.js'
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
import {
  buildReminderEmail,
  buildRescheduleEmail,
  emailDetailsBlock,
  emailLink,
  emailParagraph,
  escapeEmailHtml,
  generatedEmailHtml,
  generatedEmailPlainText,
} from '../workflow/messages.js'
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
  const liveCandidateSearch = createJazzhrLiveSearchManager({
    apiKey: config.jazzhr.apiKey,
    logger,
    pageSize: config.jazzhr.liveSearch?.pageSize,
    concurrency: config.jazzhr.liveSearch?.concurrency,
    maxPages: config.jazzhr.liveSearch?.maxPages,
    ttlMs: config.jazzhr.liveSearch?.sessionTtlMs,
  })

  app.event('app_home_opened', async ({ event, client }) => {
    await publishHome({ client, userId: event.user, store, logger, config });
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

  app.event('message', async ({ event, client }) => {
    if (!isScheduleWorkflowTrigger(event?.text)) return
    if (!await verifyChannel({
      config,
      body: {
        channel: { id: event.channel },
        user: event.user ? { id: event.user } : undefined,
      },
      client,
    })) return

    await client.chat.postMessage({
      channel: resolvePostingChannel(config, event.channel),
      text: 'Start an interview scheduling case.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Interview scheduling assistant*' },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Start scheduling' },
            action_id: 'open_schedule_intake',
            style: 'primary',
          },
        },
      ],
    })
  })

  app.command('/slack-scheduler', async ({ command, ack, client }) => {
    await ack();
    const text = (command.text || '').trim().toLowerCase();

    if (text === 'refresh-jazz') {
      const result = await refreshJazzhrCache({ config, logger, store });
      const recruiters = getRecruiters();
      await loadTalentDirectory(config, store)
      const talentRecruiters = getTalentRecruiters()
      await client.chat.postMessage({
        channel: command.channel_id,
        text: result.refreshed
          ? `JazzHR cache refreshed: ${result.records} applicants, ${result.indexedCandidates || 0} candidate index records, and ${recruiters.length} JazzHR users loaded. Talent recruiters refreshed: ${talentRecruiters.length}.`
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

  app.action('candidate_search_submit', async ({ ack, body, client }) => {
    await ack();
    const query = body.view?.state?.values?.candidate_search_block?.candidate_search?.value?.trim() || '';
    const indexedCandidates = query ? await searchCandidateIndex(store, '', query, 100) : []
    const session = query && indexedCandidates.length === 0
      ? liveCandidateSearch.start({ query, userId: body.user?.id || '' })
      : null
    const templates = await loadSchedulingTemplates()
    const updateResult = await refreshIntakeModal({
      client,
      body,
      templates,
      candidateSearchQuery: query,
      candidateSearchSessionId: session?.id || '',
      candidateSearchPage: 0,
      candidateSearchResultCount: indexedCandidates.length || session?.resultCount || 0,
      candidateSearchPageSize: session?.pageSize || config.jazzhr.liveSearch?.pageSize || 20,
      candidateSearchComplete: indexedCandidates.length > 0 || session?.complete || false,
      candidateSearchSearching: Boolean(session && !session.complete),
      candidateSearchError: session?.error || '',
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
    if (session && !session.complete) {
      updateLiveCandidateSearchModal({
        liveCandidateSearch,
        client,
        body: bodyWithUpdatedView(body, updateResult),
        templates,
        sessionId: session.id,
        version: session.version,
        page: 0,
        timeZones: schedulingTimeZones,
        defaultTimeZone,
        logger,
      }).catch((error) => {
        logger.warn('candidate_live_search_modal_update_failed', { error: error.message })
      })
    }
  });

  app.action('candidate_search_prev', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const page = Math.max(0, Number(metadata.candidateSearchPage || 0) - 1)
    const session = liveCandidateSearch.get(metadata.candidateSearchSessionId)
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      candidateSearchQuery: metadata.candidateSearchQuery || session?.query || '',
      candidateSearchSessionId: metadata.candidateSearchSessionId || '',
      candidateSearchPage: page,
      candidateSearchResultCount: session?.resultCount || 0,
      candidateSearchPageSize: session?.pageSize || config.jazzhr.liveSearch?.pageSize || 20,
      candidateSearchComplete: session?.complete || false,
      candidateSearchSearching: session?.searching || false,
      candidateSearchError: session?.error || '',
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('candidate_search_next', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const requestedPage = Number(metadata.candidateSearchPage || 0) + 1
    const session = recoverLiveCandidateSearchSession({
      liveCandidateSearch,
      sessionId: metadata.candidateSearchSessionId,
      query: metadata.candidateSearchQuery,
      userId: body.user?.id || '',
      requestedPage,
      logger,
    })
    if (!session) {
      await refreshIntakeModal({
        client,
        body,
        templates: await loadSchedulingTemplates(),
        candidateSearchQuery: metadata.candidateSearchQuery || '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchPageSize: config.jazzhr.liveSearch?.pageSize || 20,
        candidateSearchComplete: true,
        candidateSearchSearching: false,
        candidateSearchError: 'Search expired. Press Search again.',
        timeZones: schedulingTimeZones,
        defaultTimeZone,
      })
      return
    }

    const maxLoadedPage = Math.max(0, Math.ceil(session.resultCount / session.pageSize) - 1)
    const page = session.complete && requestedPage > maxLoadedPage ? maxLoadedPage : requestedPage
    const needsSearch = !session.complete && session.resultCount < (page + 1) * session.pageSize
    const templates = await loadSchedulingTemplates()
    const updateResult = await refreshIntakeModal({
      client,
      body,
      templates,
      candidateSearchQuery: session.query,
      candidateSearchSessionId: session.id,
      candidateSearchPage: page,
      candidateSearchResultCount: session.resultCount,
      candidateSearchPageSize: session.pageSize,
      candidateSearchComplete: session.complete,
      candidateSearchSearching: needsSearch,
      candidateSearchError: session.error,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
    if (needsSearch) {
      updateLiveCandidateSearchModal({
        liveCandidateSearch,
        client,
        body: bodyWithUpdatedView(body, updateResult),
        templates,
        sessionId: session.id,
        version: session.version,
        page,
        timeZones: schedulingTimeZones,
        defaultTimeZone,
        logger,
      }).catch((error) => {
        logger.warn('candidate_live_search_modal_update_failed', { error: error.message })
      })
    }
  });

  app.action('manual_candidate_toggle', async ({ ack, body, client }) => {
    await ack()
    const manualCandidateMode = selectedCheckboxValue(body, 'manual')
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: manualCandidateMode ? 'applicant' : undefined,
      selectedId: manualCandidateMode ? '' : undefined,
      manualCandidateMode,
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

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
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const liveCandidate = liveCandidateSearch.getCandidate(metadata.candidateSearchSessionId, selectedId)
    const indexedCandidate = await resolveCandidateIndexRecord(store, selectedId);
    let applicant = findApplicant(selectedId) || applicantFromCandidateIndex(liveCandidate) || applicantFromCandidateIndex(indexedCandidate);

    if (applicant?.jazzhrApplicationId) {
      try {
        const detail = await Promise.race([
          fetchApplicantDetail(config.jazzhr.apiKey, applicant.jazzhrApplicationId, logger),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        if (detail) {
          const inactiveReason = inactiveApplicantReason(detail)
          if (inactiveReason) {
            logger.info('inactive_applicant_selection_blocked', {
              applicantId: selectedId,
              jazzhrApplicationId: applicant.jazzhrApplicationId,
              inactiveReason,
            })
            await client.chat.postEphemeral({
              channel: resolvePostingChannel(config, getChannelId(body.view) || body.user.id),
              user: body.user.id,
              text: `This candidate is not available for scheduling because their JazzHR stage is "${detail.stage || inactiveReason}".`,
            })
            return
          }
          applicant = mergeApplicantDetail(applicant, detail);
          setApplicantDetail(selectedId, detail);
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
      selectedApplicant: applicant,
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
    const tokenOwnerId = getGoogleTokenOwner(config, body.user.id)
    if (tokenOwnerId !== body.user.id) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'Google is managed through a shared scheduling account. You do not need to connect your own Google account.',
      })
      return
    }
    if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
      const dmChannel = await openDm(client, body.user.id)
      await client.chat.postMessage({
        channel: dmChannel,
        text: '⚠️ Google OAuth is not configured yet. Set the Google client credentials before connecting a recruiter account.',
      })
      return
    }

    const oauthUrl = buildGoogleOAuthUrl(config, JSON.stringify({ recruiterId: tokenOwnerId, source: 'slack_home' }))
    const dmChannel = await openDm(client, body.user.id)
    await client.chat.postMessage({
      channel: dmChannel,
      text: `🔗 Connect Google Calendar and Gmail here: <${oauthUrl}>`,
    })
  });

  app.action('disconnect_google_oauth', async ({ ack, body, client }) => {
    await ack()
    if (!await verifyChannel({ config, body, client })) return
    const tokenOwnerId = getGoogleTokenOwner(config, body.user.id)
    if (tokenOwnerId !== body.user.id) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'Google is managed through a shared scheduling account. You cannot disconnect it from your Slack user.',
      })
      return
    }
    if (typeof store.deleteGoogleToken !== 'function') {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'Google disconnect is not supported by the configured store.',
      })
      return
    }

    await store.deleteGoogleToken(tokenOwnerId)
    await client.chat.postEphemeral({
      channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
      user: body.user.id,
      text: config.google.authSlackUserId
        ? 'Shared Google Calendar and Gmail have been disconnected.'
        : 'Google Calendar and Gmail have been disconnected for your Slack user.',
    })
    await publishHome({ client, userId: body.user.id, store, logger, config })
  });

  app.options('applicant_select', async ({ options, ack }) => {
    const metadata = parsePrivateMetadata(options.view?.private_metadata)
    const liveSessionId = metadata?.candidateSearchSessionId || ''
    const livePage = Number(metadata?.candidateSearchPage || 0)
    const liveCandidates = liveCandidateSearch.getPageCandidates(liveSessionId, livePage, options.value)
    const baseQuery = metadata?.candidateSearchQuery || ''
    const indexedCandidates = await searchCandidateIndex(store, options.value, baseQuery, 100)
    const candidates = mergeCandidateOptions(indexedCandidates, liveCandidates)
    const resolvedOptions = candidates.length > 0 || baseQuery || liveSessionId
      ? candidates.slice(0, 100).map(candidateToSlackOption)
      : applicantOptions(options.value, getApplicants())
    await ack({ options: resolvedOptions });
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
    const interviewTimezone = intakeDraft.interviewTimezone || defaultTimeZone;
    const requiresHiringManager = stageRequiresHiringManager(stageKey)
    const requiresResume = stageRequiresResumeLink(stageKey)
    const errors = {};

    if (!stageKey) {
      errors.stage_block = 'Choose an interview stage.';
    }
    if (intakeDraft.manualCandidateMode) {
      if (!intakeDraft.manualApplicantName) {
        errors.manual_applicant_name_block = 'Enter the candidate name.';
      }
      if (!intakeDraft.manualApplicantRole) {
        errors.manual_applicant_role_block = 'Enter the candidate role.';
      }
      if (!intakeDraft.applicantEmail) {
        errors.applicant_email_block = 'Enter applicant email.';
      }
    } else if (!intakeDraft.applicant) {
      errors.applicant_block = 'Choose a candidate.';
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

    if (requiresResume && !resumeLink) {
      await ack({
        response_action: 'errors',
        errors: {
          resume_block: 'Upload a resume for the 2nd/final interview.',
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
      interviewWindowStartDate: null,
      interviewWindowEndDate: null,
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

    const caseMessage = await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: 'Scheduling case created',
      blocks: caseMessageBlocks(caseRecord),
    });
    await store.updateCase(caseRecord.id, {
      autofill: {
        ...(caseRecord.autofill || {}),
        caseMessageTs: caseMessage.ts,
        caseMessageChannel: caseMessage.channel,
      },
    })
    await publishHome({ client, userId: body.user.id, store, logger, config });
  });

  app.action('open_candidate_message_modal', async ({ ack, body, client }) => {
    await ack();
    const caseRecord = await requireCase(store, body.actions[0].value);
    const templates = await loadTemplates();
    const template = templates.find((item) => item.id === caseRecord.templateId) || templates[0];
    const renderedTemplate = renderTemplate(template, buildTemplateVariables(caseRecord));
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: candidateMessageModal({ caseRecord, renderedTemplate, recentAudits }),
    });
  });

  app.action('open_reminder_message_modal', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    const caseRecord = await requireCase(store, body.actions[0].value);
    if (hasBlockingEmailStatus(caseRecord.reminderStatus) && caseRecord.reminderScheduleVersion === caseRecord.scheduleVersion) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: `⚠️ A reminder has already been sent for schedule version ${caseRecord.scheduleVersion}.`,
      });
      return;
    }
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
    const recentAudits = await store.listAudits(caseRecord.id, 5);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: candidateMessageModal({
        caseRecord,
        renderedTemplate,
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
        text: `📄 No resume has been uploaded for ${caseRecord.id} yet.`,
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

    const emailBodies = signedEmailBodiesFromPlainText(plainBody);
    const email = {
      subject,
      body: emailBodies.htmlBody,
      htmlBody: emailBodies.htmlBody,
      plainBody: emailBodies.plainBody,
      to: caseRecord.applicant?.email,
      from: caseRecord.recruiter?.email,
    };
    if (hasBlockingEmailStatus(caseRecord.gmailSendStatus) && isSameEmail(caseRecord.candidateEmail, email)) {
      await ack();
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, body.user.id),
        text: `⚠️ This candidate email has already been sent for ${caseId}.`,
      });
      return
    }

    await ack();
    const pendingEmailCase = await store.updateCase(caseId, {
      status: 'Waiting for Candidate',
      candidateEmail: email,
      gmailSendStatus: 'sending',
    });
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord: pendingEmailCase, email, store });
    const updated = await store.updateCase(caseId, {
      status: 'Waiting for Candidate',
      candidateEmail: email,
      gmailSendStatus: emailResult.mocked ? 'mocked' : 'sent',
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'candidate_email_approved',
      templateId: caseRecord.templateId,
    });
    await publishHome({ client, userId: body.user.id, store, logger, config });
    await client.chat.postMessage({
      channel: resolvePostingChannel(config, body.user.id),
      text: `Candidate message approved for ${caseId}.`,
      blocks: caseMessageBlocks(updated),
    });
  });

  app.view('reminder_message_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    const caseRecord = await requireCase(store, caseId);
    if (
      caseRecord.reminderEmail?.kind === 'manual_reminder' &&
      hasBlockingEmailStatus(caseRecord.reminderStatus) &&
      caseRecord.reminderScheduleVersion === caseRecord.scheduleVersion
    ) {
      await ack();
      await client.chat.postMessage({
        channel: resolvePostingChannel(config, body.user.id),
        text: `⚠️ A reminder has already been sent for schedule version ${caseRecord.scheduleVersion}.`,
      });
      return;
    }
    const plainBody = view.state.values.email_body_block.email_body.value || '';
    const emailBodies = signedEmailBodiesFromPlainText(plainBody);
    const email = {
      kind: 'manual_reminder',
      subject: view.state.values.email_subject_block.email_subject.value,
      body: emailBodies.htmlBody,
      htmlBody: emailBodies.htmlBody,
      plainBody: emailBodies.plainBody,
      to: caseRecord.applicant?.email,
      from: caseRecord.recruiter?.email,
    };
    await ack();
    const pendingReminderCase = await store.updateCase(caseId, {
      reminderEmail: email,
      reminderStatus: 'sending',
      reminderScheduleVersion: caseRecord.scheduleVersion || 1,
    })
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord: pendingReminderCase, email, store });
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
    await publishHome({ client, userId: body.user.id, store, logger, config });
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

      const selectedGuests = []
      const selectedGuestPeople = []
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

      const scheduleInput = buildScheduleSnapshot({
        date: startDate,
        time: startTime,
        zoomLink,
        attendees: allAttendeeEmails,
        attendeeDetails,
        durationMinutes: stageRules.typicalDurationMinutes,
      })
      const previewCaseRecord = {
        ...caseRecord,
        guests: scheduleInput.attendees,
        currentSchedule: scheduleInput,
        selectedInterviewDate: startDate,
        selectedInterviewTime: startTime,
      }
      const scheduledCandidateEmail = await buildScheduledCandidateEmail(previewCaseRecord)
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
          description: stripSignatureHtml(scheduledCandidateEmail.htmlBody || ''),
        },
      })

      const completedScheduleInput = buildScheduleSnapshot({
        date: startDate,
        time: startTime,
        zoomLink,
        attendees: allAttendeeEmails,
        attendeeDetails,
        durationMinutes: stageRules.typicalDurationMinutes,
        eventId: eventResult.eventId,
        htmlLink: eventResult.googleEvent?.htmlLink || null,
      })

      const updated = await store.updateCase(caseRecord.id, {
        ...applyScheduledEvent(caseRecord, eventResult, completedScheduleInput),
        selectedSlot: slotValue ? { start: slotValue } : null
      })

      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: body.user.id,
        action: 'calendar_event_approved',
        eventId: eventResult.eventId,
        via: slotValue ? 'slot_selection' : 'manual_entry'
      })

      const candidateEmailResult = await sendRecruiterEmail({ config, logger, caseRecord: updated, email: scheduledCandidateEmail, store })
      const attendeeInviteResults = await sendAttendeeInviteEmails({ config, logger, store, caseRecord: updated })
      await store.updateCase(caseRecord.id, {
        candidateEmail: scheduledCandidateEmail,
        gmailSendStatus: candidateEmailResult.mocked ? 'mocked' : 'sent',
        attendeeInviteStatus: attendeeInviteResults.length === 0
          ? 'none'
          : (attendeeInviteResults.every((result) => result.mocked) ? 'mocked' : 'sent'),
      })
      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: body.user.id,
        action: 'scheduled_candidate_invite_sent',
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

      await publishHome({ client, userId: body.user.id, store, logger, config })
      await postCaseThreadMessage({
        client,
        config,
        body,
        store,
        caseRecord: updated,
        text: 'Interview scheduled',
        blocks: caseMessageBlocks(updated),
        saveAsScheduledMessage: true,
      })
      return;
    } catch (error) {
      logger.error('scheduling_confirm_error', { error: error.message })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.user.id),
        user: body.user.id,
        text: `Could not schedule interview: ${error.message}`
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
    const selectedGuests = []
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
    const selectedGuestPeople = []
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
        durationMinutes,
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
    try {
      const emailSubject = view.state.values.email_subject_block.email_subject.value
      const emailBody = view.state.values.email_body_block.email_body.value
      const emailBodies = signedEmailBodiesFromPlainText(emailBody)
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
        eventInput: {
          ...scheduleInput,
          description: plainTextToHtml(emailBody),
        },
      });

      const scheduleSnapshot = buildScheduleSnapshot({
        date: scheduleInput.startDate,
        time: scheduleInput.startTime,
        zoomLink: scheduleInput.zoomLink,
        attendees: scheduleInput.attendees,
        attendeeDetails: scheduleInput.attendeeDetails,
        durationMinutes: scheduleInput.durationMinutes,
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

      const scheduledCandidateEmail = {
        ...(await buildScheduledCandidateEmail(updated)),
        subject: emailSubject,
        ...emailBodies,
      }
      scheduledCandidateEmail.body = scheduledCandidateEmail.htmlBody
      const candidateEmailResult = await sendRecruiterEmail({ config, logger, caseRecord: updated, email: scheduledCandidateEmail, store });
      const attendeeInviteResults = await sendAttendeeInviteEmails({ config, logger, store, caseRecord: updated })
      const reminderUpdated = await store.updateCase(caseId, {
        candidateEmail: scheduledCandidateEmail,
        gmailSendStatus: candidateEmailResult.mocked ? 'mocked' : 'sent',
        attendeeInviteStatus: attendeeInviteResults.length === 0
          ? 'none'
          : (attendeeInviteResults.every((result) => result.mocked) ? 'mocked' : 'sent'),
      });
      await store.addAudit({
        caseId,
        actorSlackUserId: body.user.id,
        action: 'scheduled_candidate_invite_sent',
        scheduleVersion: reminderUpdated.scheduleVersion || 1,
      });
      if (attendeeInviteResults.length > 0) {
        await store.addAudit({
          caseId,
          actorSlackUserId: body.user.id,
          action: 'attendee_invites_sent',
          count: attendeeInviteResults.length,
        });
      }
      await publishHome({ client, userId: body.user.id, store, logger, config });
      await postCaseThreadMessage({
        client,
        config,
        body,
        store,
        caseRecord: reminderUpdated,
        text: 'Interview scheduled',
        blocks: caseMessageBlocks(reminderUpdated),
        saveAsScheduledMessage: true,
      })
    } catch (error) {
      logger.error('finalize_email_preview_submit_error', { caseId, error: error.message })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: `Could not create the calendar invite: ${error.message}`,
      })
    }
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
      durationMinutes: resolveStageRules(
        normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview',
        caseRecord.stageOverrides,
      ).typicalDurationMinutes,
    };
    const email = buildRescheduleEmail(caseRecord, request);
    email.cc = ccRecipientsFromAttendees(caseRecord, request.attendees)
    request.email = email;

    const updated = await store.updateCase(caseId, applyRescheduleRequest(caseRecord, request));
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'reschedule_requested',
      reason: request.reason,
    });
    await publishHome({ client, userId: body.user.id, store, logger, config });
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
    const emailBodies = signedEmailBodiesFromPlainText(plainBody);
    const email = {
      ...request.email,
      subject: view.state.values.email_subject_block.email_subject.value,
      body: emailBodies.htmlBody,
      htmlBody: emailBodies.htmlBody,
      plainBody: emailBodies.plainBody,
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
        description: plainTextToHtml(plainBody),
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
    await publishHome({ client, userId: body.user.id, store, logger, config });
    await postCaseThreadMessage({
      client,
      config,
      body,
      store,
      caseRecord: updated,
      text: 'Interview rescheduled',
      blocks: caseMessageBlocks(updated),
    })
  });

  app.action('cancel_interview', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    const caseRecord = await requireCase(store, body.actions[0].value);
    if (caseRecord.rescheduleStatus === 'cancelled' || hasBlockingEmailStatus(caseRecord.cancellationEmailStatus)) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: '⚠️ This interview has already been cancelled. No duplicate email was sent.',
      });
      return
    }
    const pendingCancellation = await store.updateCase(caseRecord.id, {
      ...applyCancelledInterview(caseRecord, body.user.id),
      cancellationEmailStatus: 'sending',
    });
    const cancellationEmail = buildCancellationEmail(pendingCancellation)
    const cancellationResult = await sendRecruiterEmail({ config, logger, caseRecord: pendingCancellation, email: cancellationEmail, store })
    const updated = await store.updateCase(caseRecord.id, {
      cancellationEmail,
      cancellationEmailStatus: cancellationResult.mocked ? 'mocked' : 'sent',
    })
    await store.addAudit({
      caseId: caseRecord.id,
      actorSlackUserId: body.user.id,
      action: 'reschedule_cancelled',
      cancellationEmailStatus: updated.cancellationEmailStatus,
    });
    await publishHome({ client, userId: body.user.id, store, logger, config });
    await postCaseThreadMessage({
      client,
      config,
      body,
      store,
      caseRecord: updated,
      text: 'Interview cancelled. Cancellation email sent. Calendar cancellation is not automatic yet.',
      blocks: caseMessageBlocks(updated),
    })
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

async function postCaseThreadMessage({
  client,
  config,
  body,
  store,
  caseRecord,
  text,
  blocks,
  saveAsScheduledMessage = false,
}) {
  const fallbackChannel = body.channel?.id || body.user?.id || body.user_id || caseRecord.channelId || caseRecord.ownerSlackUserId
  const channel =
    caseRecord.autofill?.scheduledMessageChannel ||
    caseRecord.autofill?.caseMessageChannel ||
    resolvePostingChannel(config, fallbackChannel)
  const threadTs = saveAsScheduledMessage
    ? null
    : (caseRecord.autofill?.scheduledMessageTs || caseRecord.autofill?.caseMessageTs || body.message?.ts || null)

  const result = await client.chat.postMessage({
    channel,
    text,
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  })

  if (saveAsScheduledMessage && result?.ts) {
    await store.updateCase(caseRecord.id, {
      autofill: {
        ...(caseRecord.autofill || {}),
        scheduledMessageTs: result.ts,
        scheduledMessageChannel: result.channel || channel,
      },
    })
  }

  return result
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
  const meta = JSON.stringify({ channelId: privateMetadata, showDetails: false, manualCandidateMode: false });
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
  const candidateSearchQuery = 'candidateSearchQuery' in overrides ? overrides.candidateSearchQuery : parsed.candidateSearchQuery || '';
  const candidateSearchResultCount = 'candidateSearchResultCount' in overrides
    ? overrides.candidateSearchResultCount
    : parsed.candidateSearchResultCount || 0;
  const candidateSearchPageSize = 'candidateSearchPageSize' in overrides
    ? overrides.candidateSearchPageSize
    : parsed.candidateSearchPageSize || 20
  const candidateSearchSessionId = 'candidateSearchSessionId' in overrides
    ? overrides.candidateSearchSessionId
    : parsed.candidateSearchSessionId || ''
  const candidateSearchPage = 'candidateSearchPage' in overrides
    ? overrides.candidateSearchPage
    : parsed.candidateSearchPage || 0
  const candidateSearchComplete = 'candidateSearchComplete' in overrides
    ? overrides.candidateSearchComplete
    : parsed.candidateSearchComplete || false
  const candidateSearchSearching = 'candidateSearchSearching' in overrides
    ? overrides.candidateSearchSearching
    : parsed.candidateSearchSearching || false
  const candidateSearchError = 'candidateSearchError' in overrides
    ? overrides.candidateSearchError
    : parsed.candidateSearchError || ''
  const manualCandidateMode = 'manualCandidateMode' in overrides
    ? Boolean(overrides.manualCandidateMode)
    : Boolean(parsed.manualCandidateMode)
  return JSON.stringify({
    channelId,
    showDetails,
    manualCandidateMode,
    candidateSearchQuery,
    candidateSearchSessionId,
    candidateSearchPage,
    candidateSearchResultCount,
    candidateSearchPageSize,
    candidateSearchComplete,
    candidateSearchSearching,
    candidateSearchError,
  });
}

async function refreshIntakeModal({
  client,
  body,
  templates,
  selectedKey,
  selectedId,
  selectedPerson,
  selectedApplicant,
  showDetails,
  candidateSearchQuery,
  candidateSearchSessionId,
  candidateSearchPage,
  candidateSearchResultCount,
  candidateSearchPageSize,
  candidateSearchComplete,
  candidateSearchSearching,
  candidateSearchError,
  manualCandidateMode,
  timeZones = [],
  defaultTimeZone,
  useHash = true,
}) {
  if (!body.view?.id || !body.view?.hash) return;
  const overrides = selectedKey ? { [selectedKey]: selectedId } : {}
  const metadata = parsePrivateMetadata(body.view.private_metadata) || {}
  overrides.manualCandidateMode = manualCandidateMode !== undefined
    ? Boolean(manualCandidateMode)
    : Boolean(metadata.manualCandidateMode)
  if (candidateSearchQuery === undefined && metadata.candidateSearchQuery) {
    overrides.candidateSearchQuery = metadata.candidateSearchQuery
    overrides.candidateSearchSessionId = metadata.candidateSearchSessionId || ''
    overrides.candidateSearchPage = metadata.candidateSearchPage || 0
    overrides.candidateSearchResultCount = metadata.candidateSearchResultCount || 0
    overrides.candidateSearchPageSize = metadata.candidateSearchPageSize || 20
    overrides.candidateSearchComplete = metadata.candidateSearchComplete || false
    overrides.candidateSearchSearching = metadata.candidateSearchSearching || false
    overrides.candidateSearchError = metadata.candidateSearchError || ''
  }
  if (candidateSearchQuery !== undefined) {
    overrides.candidateSearchQuery = candidateSearchQuery
    overrides.candidateSearchSessionId = candidateSearchSessionId || ''
    overrides.candidateSearchPage = Number(candidateSearchPage || 0)
    overrides.candidateSearchResultCount = candidateSearchResultCount || 0
    overrides.candidateSearchPageSize = candidateSearchPageSize || 20
    overrides.candidateSearchComplete = Boolean(candidateSearchComplete)
    overrides.candidateSearchSearching = Boolean(candidateSearchSearching)
    overrides.candidateSearchError = candidateSearchError || ''
  }
  if (selectedKey === 'applicant' && selectedApplicant) {
    overrides.applicantRecord = selectedApplicant
  }
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
    candidateSearchQuery: draft.candidateSearchQuery,
    candidateSearchSessionId: draft.candidateSearchSessionId,
    candidateSearchPage: draft.candidateSearchPage,
    candidateSearchResultCount: draft.candidateSearchResultCount,
    candidateSearchPageSize: draft.candidateSearchPageSize,
    candidateSearchComplete: draft.candidateSearchComplete,
    candidateSearchSearching: draft.candidateSearchSearching,
    candidateSearchError: draft.candidateSearchError,
    manualCandidateMode: draft.manualCandidateMode,
  });

  return client.views.update({
    view_id: body.view.id,
    ...(useHash ? { hash: body.view.hash } : {}),
    view: {
      ...intakeModal({ templates, draft, timeZones, defaultTimeZone, recruiters: getTalentRecruiters() }),
      private_metadata: privateMetadata,
    },
  });
}

function bodyWithUpdatedView(body, updateResult) {
  const updatedView = updateResult?.view
  if (!updatedView?.hash) return body
  return {
    ...body,
    view: {
      ...body.view,
      id: updatedView.id || body.view?.id,
      hash: updatedView.hash,
      private_metadata: updatedView.private_metadata || body.view?.private_metadata,
    },
  }
}

export function recoverLiveCandidateSearchSession({
  liveCandidateSearch,
  sessionId = '',
  query = '',
  userId = '',
  requestedPage = 0,
  logger = console,
} = {}) {
  const session = liveCandidateSearch?.get?.(sessionId)
  if (session) return session

  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) return null

  const restarted = liveCandidateSearch?.start?.({ query: normalizedQuery, userId })
  if (!restarted) return null

  logger.warn?.('candidate_live_search_session_restarted', {
    previousSessionId: sessionId || '',
    sessionId: restarted.id,
    query: restarted.query,
    requestedPage,
  })
  return restarted
}

async function updateLiveCandidateSearchModal({
  liveCandidateSearch,
  client,
  body,
  templates,
  sessionId,
  version,
  page,
  timeZones = [],
  defaultTimeZone,
  logger,
}) {
  const snapshot = await liveCandidateSearch.ensurePage(sessionId, page)
  if (!snapshot || !liveCandidateSearch.isCurrent(sessionId, snapshot.version)) return
  if (version && snapshot.version < version) return

  logger.info('candidate_live_search_page_ready', {
    sessionId,
    query: snapshot.query,
    page,
    resultCount: snapshot.resultCount,
    complete: snapshot.complete,
    searching: snapshot.searching,
    error: snapshot.error,
  })

  await refreshIntakeModal({
    client,
    body,
    templates,
    candidateSearchQuery: snapshot.query,
    candidateSearchSessionId: snapshot.id,
    candidateSearchPage: page,
    candidateSearchResultCount: snapshot.resultCount,
    candidateSearchPageSize: snapshot.pageSize,
    candidateSearchComplete: snapshot.complete,
    candidateSearchSearching: snapshot.searching,
    candidateSearchError: snapshot.error,
    timeZones,
    defaultTimeZone,
    useHash: true,
  })
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

async function publishHome({ client, userId, store, logger, config }) {
  const [myCases, allCases] = await Promise.all([store.listCasesForUser(userId), store.listCases()]);
  const teamCases = allCases.filter((item) => item.ownerSlackUserId !== userId && item.status !== 'Scheduled');
  const googleTokenOwnerId = getGoogleTokenOwner(config, userId)
  const googleShared = Boolean(config?.google?.authSlackUserId)
  const googleCanManage = googleTokenOwnerId === userId
  const googleConnected = typeof store.hasGoogleToken === 'function' ? await store.hasGoogleToken(googleTokenOwnerId) : false;
  try {
    await client.views.publish({
      user_id: userId,
      view: homeView({ myCases, teamCases, googleConnected, googleShared, googleCanManage }),
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

export async function buildScheduledCandidateEmail(caseRecord) {
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
    cc: candidateInviteCcRecipients(caseRecord),
    from: caseRecord.recruiter?.email,
  }
}

export function buildCancellationEmail(caseRecord) {
  const schedule = caseRecord.currentSchedule || {}
  const candidateName = caseRecord.applicant?.firstName || 'there'
  const jobTitle = caseRecord.applicant?.jobTitle || 'the role'
  const dateText = schedule.date || caseRecord.selectedInterviewDate || 'TBD'
  const timeText = `${schedule.time || caseRecord.selectedInterviewTime || 'TBD'} ${caseRecord.interviewTimezone || ''}`.trim()
  const zoomLink = schedule.zoomLink || caseRecord.autofill?.zoomLink || 'TBD'
  const scheduleLines = [
    `Date: ${dateText}`,
    `Time: ${timeText}`,
    `Zoom link: ${zoomLink}`,
  ]
  const plainBody = generatedEmailPlainText([
    `Hi ${candidateName},`,
    '',
    `Your interview for ${jobTitle} has been cancelled.`,
    '',
    'Cancelled interview details:',
    ...scheduleLines,
    '',
    `If you have any questions, please contact ${caseRecord.recruiter?.name || 'your recruiter'}.`,
  ])
  const htmlBody = generatedEmailHtml([
    emailParagraph(`Hi <strong>${escapeEmailHtml(candidateName)}</strong>,`),
    emailParagraph(`Your interview for the <strong>${escapeEmailHtml(jobTitle)}</strong> role at Outsourced Pro Global has been cancelled.`),
    emailDetailsBlock('Cancelled interview details:', [
      { label: 'Date', value: escapeEmailHtml(dateText) },
      { label: 'Time', value: escapeEmailHtml(timeText) },
      { label: 'Zoom Link', value: emailLink(zoomLink) },
    ]),
    emailParagraph(`If you have any questions, please contact ${escapeEmailHtml(caseRecord.recruiter?.name || 'your recruiter')}.`),
  ])

  return {
    subject: `Interview cancelled: ${jobTitle}`,
    body: htmlBody,
    htmlBody,
    plainBody,
    to: caseRecord.applicant?.email,
    cc: ccRecipientsFromAttendees(caseRecord, schedule.attendees || caseRecord.guests || []),
    from: caseRecord.recruiter?.email,
  }
}

function candidateInviteCcRecipients(caseRecord) {
  const candidateEmail = normalizeEmail(caseRecord.applicant?.email)
  const emails = [
    caseRecord.recruiter?.email,
    ...attendeeInviteRecipients(caseRecord).map((attendee) => attendee.email),
  ]
  return [...new Set(emails.map(normalizeEmail).filter((email) => email && email !== candidateEmail))]
}

export function ccRecipientsFromAttendees(caseRecord, attendees = []) {
  const candidateEmail = normalizeEmail(caseRecord.applicant?.email)
  const emails = [
    caseRecord.recruiter?.email,
    ...(attendees || []),
  ]
  return [...new Set(emails.map(normalizeEmail).filter((email) => email && email !== candidateEmail))]
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
  const dateText = schedule.date || caseRecord.selectedInterviewDate || 'TBD'
  const timeText = `${schedule.time || caseRecord.selectedInterviewTime || 'TBD'} ${caseRecord.interviewTimezone || ''}`.trim()
  const zoomLink = schedule.zoomLink || caseRecord.autofill?.zoomLink || 'TBD'
  const recruiterText = `Recruiter: ${caseRecord.recruiter?.name || ''}${caseRecord.recruiter?.email ? ` (${caseRecord.recruiter.email})` : ''}`.trim()
  const plainBody = generatedEmailPlainText([
    `Hi ${attendee.name || 'there'},`,
    '',
    `You are included as an interviewer/attendee for ${candidateName}'s interview for ${jobTitle}.`,
    '',
    'Interview details:',
    `Date: ${dateText}`,
    `Time: ${timeText}`,
    `Zoom link: ${zoomLink}`,
    '',
    recruiterText,
    '',
    'Thank you.',
  ])
  const htmlBody = generatedEmailHtml([
    emailParagraph(`Hi <strong>${escapeEmailHtml(attendee.name || 'there')}</strong>,`),
    emailParagraph(`You are included as an interviewer/attendee for <strong>${escapeEmailHtml(candidateName)}</strong>'s interview for <strong>${escapeEmailHtml(jobTitle)}</strong>.`),
    emailDetailsBlock('Interview details:', [
      { label: 'Date', value: escapeEmailHtml(dateText) },
      { label: 'Time', value: escapeEmailHtml(timeText) },
      { label: 'Zoom Link', value: emailLink(zoomLink) },
      recruiterText ? { label: 'Recruiter', value: escapeEmailHtml(recruiterText.replace(/^Recruiter:\s*/i, '')) } : null,
    ]),
    emailParagraph('Thank you.'),
  ])

  return {
    subject,
    body: htmlBody,
    htmlBody,
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
  const interviewDurationMinutes = resolveInterviewDurationMinutes(caseRecord, resolvedStageKey);
  const guestListText = buildGuestListText(caseRecord);
  const resumeLink = caseRecord.resumeLink || '';

  return {
    applicant_first_name: caseRecord.applicant?.firstName || '',
    applicant_full_name: [caseRecord.applicant?.firstName, caseRecord.applicant?.lastName].filter(Boolean).join(' '),
    job_title: caseRecord.applicant?.jobTitle || '',
    company_name: 'Outsourced Pro Global',
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
    interview_duration_minutes: String(interviewDurationMinutes),
    interview_duration_text: formatInterviewDuration(interviewDurationMinutes),
    resume_link: resumeLink,
    guest_list_text: guestListText,
    schedule_your_interview_here: '',
    recruiter_phone_line: recruiterContactLine(caseRecord),
  };
}

function buildGuestListText(caseRecord) {
  const schedule = caseRecord.currentSchedule || {}
  const attendeeEmails = Array.isArray(schedule.attendees) ? schedule.attendees : []
  const details = Array.isArray(schedule.attendeeDetails) ? schedule.attendeeDetails : []
  const byEmail = new Map()

  for (const detail of details) {
    const email = normalizeEmail(detail?.email)
    if (!email) continue
    byEmail.set(email, {
      name: detail.name || detail.email || email,
      email,
    })
  }

  for (const person of [caseRecord.applicant, caseRecord.recruiter, caseRecord.hiringManager]) {
    const email = normalizeEmail(person?.email)
    if (!email || byEmail.has(email)) continue
    byEmail.set(email, {
      name: person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email || email,
      email,
    })
  }

  for (const emailValue of attendeeEmails) {
    const email = normalizeEmail(emailValue)
    if (!email || byEmail.has(email)) continue
    byEmail.set(email, { name: email, email })
  }

  return [...byEmail.values()]
    .map((guest) => `${guest.name}: ${guest.email}`)
    .join('\n')
}

function resolveInterviewDurationMinutes(caseRecord, stageKey) {
  const currentScheduleDuration = Number(caseRecord.currentSchedule?.durationMinutes)
  if (Number.isFinite(currentScheduleDuration) && currentScheduleDuration > 0) return currentScheduleDuration

  const selectedDuration = Number(caseRecord.stageOverrides?.durationMinutes)
  if (Number.isFinite(selectedDuration) && selectedDuration > 0) return selectedDuration

  return resolveStageRules(stageKey || '1st-interview', caseRecord.stageOverrides).typicalDurationMinutes
}

function formatInterviewDuration(minutes) {
  const normalized = Number(minutes)
  if (!Number.isFinite(normalized) || normalized <= 0) return '30-minute'
  if (normalized === 60) return '1-hour'
  return `${normalized}-minute`
}

function recruiterContactLine(caseRecord) {
  const phoneLine = recruiterPhoneLine(caseRecord.recruiter)
  const recruiterName = caseRecord.recruiter?.name || 'Recruiter'
  const recruiterEmail = caseRecord.recruiter?.email || ''
  const coordinatorEmail = resolveCoordinatorEmail(caseRecord)
  const recruiterLine = phoneLine || (recruiterEmail ? `${recruiterName}: ${recruiterEmail}` : recruiterName)
  return [
    recruiterLine,
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
  const manualCandidateMode = overrides.manualCandidateMode !== undefined
    ? Boolean(overrides.manualCandidateMode)
    : isCheckboxSelected(values, 'manual_candidate_toggle', 'manual') ||
      (!values.applicant_block && hasInputElement(values, 'manual_applicant_name'))
  const manualApplicantName = manualCandidateMode
    ? (overrides.manualApplicantName !== undefined ? overrides.manualApplicantName : getInputValue(values, 'manual_applicant_name'))
    : ''
  const manualApplicantRole = manualCandidateMode
    ? (overrides.manualApplicantRole !== undefined ? overrides.manualApplicantRole : getInputValue(values, 'manual_applicant_role'))
    : ''
  const applicantEmailOverride =
    overrides.applicantEmail !== undefined ? overrides.applicantEmail : getInputValue(values, 'applicant_email')
  const candidateSearchQuery = overrides.candidateSearchQuery ?? getInputValue(values, 'candidate_search')
  const candidateSearchPage = Number(overrides.candidateSearchPage || 0)
  const selectedStageKey = overrides.stageKey ?? (values.stage_block?.stage_select?.selected_option?.value || '');
  const legacyTemplateId = overrides.templateId ?? (values.template_block?.template_select?.selected_option?.value || '');
  const stageKey = normalizeStageKey(selectedStageKey || resolveStageFromTemplate(legacyTemplateId));
  const templateId = resolveTemplateFromStage(stageKey) || legacyTemplateId;
  const interviewTimezone = overrides.interviewTimezone ?? (values.timezone_block?.timezone_select?.selected_option?.value || '');

  const applicant = manualCandidateMode
    ? applyEmailOverride(
        buildManualApplicant(manualApplicantName, applicantEmailOverride, manualApplicantRole),
        applicantEmailOverride,
      )
    : applyEmailOverride(
        overrides.applicantRecord || findApplicant(applicantId),
        applicantEmailOverride,
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
    candidateSearchQuery,
    candidateSearchSessionId: overrides.candidateSearchSessionId || '',
    candidateSearchPage,
    candidateSearchResultCount: overrides.candidateSearchResultCount || 0,
    candidateSearchComplete: Boolean(overrides.candidateSearchComplete),
    candidateSearchSearching: Boolean(overrides.candidateSearchSearching),
    candidateSearchError: overrides.candidateSearchError || '',
    candidateSearchPageSize: overrides.candidateSearchPageSize || 20,
    manualCandidateMode,
    manualApplicantName,
    manualApplicantRole,
    applicantEmail: applicant?.email || '',
    recruiterEmail: recruiter?.email || '',
    hiringManagerEmail: hiringManager?.email || '',
    notes: getInputValue(values, 'notes'),
    resumeLink: extractResumeFileReference(values),
    interviewWindowStartDate: '',
    interviewWindowEndDate: '',
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

function isCheckboxSelected(values, actionId, value) {
  for (const block of Object.values(values || {})) {
    const element = findElementByActionId(block, actionId)
    const selected = element?.selected_options || []
    if (selected.some((option) => option.value === value)) return true
  }
  return false
}

function hasInputElement(values, actionId) {
  for (const block of Object.values(values || {})) {
    if (findElementByActionId(block, actionId)) return true
  }
  return false
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

function selectedCheckboxValue(body, value) {
  const selected = body.actions?.[0]?.selected_options || []
  return selected.some((option) => option.value === value)
}

export function isScheduleWorkflowTrigger(text) {
  const value = String(text || '')
    .replace(/<@[A-Z0-9]+>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return value === '/schedule-interview' || value === '/schedule-interview button'
}

async function searchCandidateIndex(store, query, baseQuery = '', limit = 20) {
  if (!store?.searchJazzhrCandidates) return []
  return store.searchJazzhrCandidates(query, { baseQuery, limit })
}

function mergeCandidateOptions(...groups) {
  const seen = new Set()
  const merged = []
  for (const group of groups) {
    for (const candidate of group || []) {
      const key = candidate.candidateKey || String(candidate.id || '').replace(/^applicant-/, '') || candidate.jazzhrApplicationId
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(candidate)
    }
  }
  return merged
}

async function resolveCandidateIndexRecord(store, selectedId) {
  const id = String(selectedId || '').replace(/^applicant-/, '')
  if (!id || !store?.getJazzhrCandidate) return null
  return store.getJazzhrCandidate(id)
}

function candidateToSlackOption(candidate) {
  return toSlackOption(applicantPickerLabel(candidate), candidate.id)
}

function applicantFromCandidateIndex(candidate) {
  if (!candidate) return null
  const [firstName, ...rest] = String(candidate.fullName || '').split(' ')
  return {
    id: candidate.id,
    candidateKey: candidate.candidateKey,
    jazzhrApplicationId: candidate.jazzhrApplicationId,
    jazzhrJobId: candidate.jazzhrJobId,
    fullName: candidate.fullName,
    firstName: candidate.firstName || firstName || '',
    lastName: candidate.lastName || rest.join(' '),
    email: candidate.email || '',
    phone: candidate.phone || '',
    jobTitle: candidate.jobTitle || '',
    stage: candidate.stage || '',
    hiringManagerId: '',
    recruiterId: candidate.recruiterId || '',
    source: 'jazzhr',
    appliedAt: candidate.appliedAt || '',
    sourceOrder: candidate.sourceOrder || 0,
  }
}

function mergeApplicantDetail(applicant, detail) {
  if (!applicant || !detail) return applicant
  return {
    ...applicant,
    email: detail.email || applicant.email || '',
    phone: detail.phone || applicant.phone || '',
    jobTitle: detail.jobTitle || applicant.jobTitle || '',
    stage: detail.stage || applicant.stage || '',
    source: detail.source || applicant.source || 'jazzhr',
    applyDate: detail.applyDate || applicant.applyDate || applicant.appliedAt || '',
  }
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

function buildManualApplicant(name, email = '', jobTitle = '') {
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim()
  if (!normalizedName) return null
  const parts = normalizedName.split(' ')
  const firstName = parts.shift() || normalizedName
  const lastName = parts.join(' ')
  const normalizedEmail = String(email || '').trim()
  const normalizedJobTitle = String(jobTitle || '').replace(/\s+/g, ' ').trim()
  const idSource = [normalizedName, normalizedEmail].filter(Boolean).join('-') || normalizedName
  const id = `manual-applicant-${idSource.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || crypto.randomUUID()}`
  return {
    id,
    firstName,
    lastName,
    email: normalizedEmail,
    jobTitle: normalizedJobTitle,
    stage: '',
    source: 'Manual entry',
  }
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

function extractResumeFileReference(values) {
  const resumeElement = values.resume_block?.resume_file
  const file = Array.isArray(resumeElement?.files) ? resumeElement.files[0] : null
  if (file) return resumeFileReference(file)

  const legacyLinkElement = values.resume_block?.resume_link
  return legacyLinkElement?.value?.trim() || ''
}

function resumeFileReference(file) {
  return String(
    file.permalink ||
    file.url_private ||
    file.url_private_download ||
    file.id ||
    file.name ||
    '',
  ).trim()
}

async function openDm(client, userId) {
  const result = await client.conversations.open({ users: userId })
  return result.channel.id
}

function hasUnresolvedSchedulePlaceholders(value) {
  return /\[(date|time|link|zoom_link)\]/i.test(String(value || ''))
}

function hasBlockingEmailStatus(status) {
  return ['sending', 'sent', 'mocked'].includes(status)
}

function isSameEmail(left, right) {
  if (!left || !right) return false
  return (
    normalizeEmail(left.to) === normalizeEmail(right.to) &&
    normalizeEmail(left.from) === normalizeEmail(right.from) &&
    String(left.subject || '') === String(right.subject || '') &&
    String(left.plainBody || stripHtmlBody(left.body || left.htmlBody || '')) ===
      String(right.plainBody || stripHtmlBody(right.body || right.htmlBody || ''))
  )
}

function stripHtmlBody(value) {
  return String(value || '').replace(/<[^>]+>/g, '').trim()
}

function previewPeople(people) {
  if (!people || people.length === 0) return 'none'
  return people
    .slice(0, 3)
    .map((person) => person.name || person.email || person.id || 'Unknown')
    .join(', ')
}

import crypto from 'node:crypto'
import { issueOAuthState } from '../security/oauth-state.js'
import {
  installSlackSecurityMiddleware,
  requireAdminSlackUser,
} from '../security/slack-access.js'
import {
  getApplicants,
  getRecruiters,
  getHiringManagers,
  getApplicantDetail,
  getTalentRecruiters,
  getSlackRecruiters,
  getSlackUsers,
  getOpenRoles,
  getRoleAssignments,
  setApplicantDetail,
} from '../data/cache.js'
import { searchTimezones } from '../data/timezones.js'
import {
  applicantOptions,
  applicantPickerLabel,
  filterApplicants,
  findApplicant,
  findPerson,
  personOptions,
  personPickerLabel,
  toSlackOption,
} from '../data/search.js'
import {
  CUSTOM_INVITE_MANUAL_TEMPLATE_ID,
  CUSTOM_INVITE_TEMPLATE_IDS,
  loadIntakeTemplates,
  loadSchedulingTemplates,
  loadTemplates,
  plainTextToHtml,
  renderTemplate,
  signedEmailBodiesFromPlainText,
  stripSignatureHtml,
} from '../templates.js'
import { buildGoogleOAuthUrl, createCalendarEvent, getGoogleTokenOwner, sendRecruiterEmail, updateCalendarEvent } from '../services/google.js'
import { normalizeResumeFile, resolveResumeAttachment } from '../services/resume-attachment.js'
import {
  applicantEligibilityReason,
  fetchApplicantDetail,
  refreshJazzhrCache,
  refreshJazzhrOpenJobs,
  syncJazzhrJobCandidates,
} from '../services/jazzhr.js'
import { createJazzhrLiveSearchManager } from '../services/jazzhr-live-search.js'
import { loadTalentDirectory } from '../services/talent-directory.js'
import { applyTestDirectoryData, isTestDirectoryRoleId } from '../services/test-directory-data.js'
import {
  ensureRecruitmentSlackDirectory,
  ensureSlackDirectory,
  resolveSlackUser,
  slackApiErrorDetails,
} from '../services/slack-directory.js'
import { personIdentityMatches, recruiterPhoneLine } from '../services/recruiter-phone-export.js'
import { resumeHtmlLink, resumePlainLink, resumeSlackLink } from '../resume-display.js'
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
  canEditScheduleCase,
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
import {
  buildCustomInviteEmail,
  buildCustomInvitePreviewVariables,
  customInviteExternalAttendees,
  isCustomInviteCase,
  isFinalCustomInviteDeliveryStatus,
  normalizeCustomInviteMetadata,
  parseCustomInviteRecipients,
  replaceInviteVariables,
  validateCustomInviteDraft,
} from '../workflow/custom-invite.js'
import { runSchedulingPipeline } from '../workflow/scheduler.js'
import { matchRoleAssignments, normalizeRoleTitle } from '../workflow/role-assignment-matcher.js'
import {
  markCaseComplete,
  scheduleCaseNotifications,
} from '../workflow/notifications.js'
import {
  calendarEventUrl,
  checkingAvailabilityModal,
  availabilityCheckErrorModal,
  customInviteRequestStatusModal,
  customInviteSentEmailsModal,
  candidateMessageModal,
  caseDetailsModal,
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
  installSlackSecurityMiddleware(app, { config, store, logger })
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
      userId: command.user_id,
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
    if (!await requireAdminSlackUser({
      config,
      userId: command.user_id,
      client,
      channelId: command.channel_id,
      logger,
      action: '/slack-scheduler',
    })) return
    const text = (command.text || '').trim().toLowerCase();

    if (text === 'refresh-jazz') {
      const [result, openJobsResult] = await Promise.all([
        refreshJazzhrCache({ config, logger, store }),
        refreshJazzhrOpenJobs({ config, logger }),
      ])
      const recruiters = getRecruiters();
      await loadTalentDirectory(config, store)
      applyTestDirectoryData(config, logger)
      const talentRecruiters = getTalentRecruiters()
      await postSharedActionMessage({
        client,
        channel: command.channel_id,
        actorSlackUserId: command.user_id,
        text: result.refreshed && openJobsResult.refreshed
          ? `JazzHR cache refreshed: ${result.records} applicants, ${result.indexedCandidates || 0} candidate index records, ${openJobsResult.records} open roles, and ${recruiters.length} JazzHR users loaded. Talent recruiters refreshed: ${talentRecruiters.length}.`
          : 'JazzHR refresh completed with warnings (check logs for details).',
      });
      return;
    }

    if (text === 'refresh-directory') {
      await loadTalentDirectory(config, store)
      applyTestDirectoryData(config, logger)
      const talentRecruiters = getTalentRecruiters()
      await postSharedActionMessage({
        client,
        channel: command.channel_id,
        actorSlackUserId: command.user_id,
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
      userId: body.user.id,
    });
  });

  app.action('view_case_details', async ({ ack, body, client }) => {
    await ack()
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: caseDetailsModal(caseRecord),
        })
      },
    })
  })

  app.action('edit_schedule_case', async ({ ack, body, client }) => {
    await ack()
    let caseRecord
    try {
      caseRecord = await requireCase(store, body.actions[0].value)
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId: body.actions[0].value, client, body, config, logger })
        return
      }
      throw error
    }
    if (!canEditScheduleCase(caseRecord)) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'This case can no longer be edited because its calendar event has already been created.',
      })
      return
    }

    const templates = await loadIntakeTemplates()
    if (isCustomInviteCase(caseRecord)) {
      try {
        await ensureRecruitmentSlackDirectory({ client, config, logger })
      } catch (error) {
        const correlationId = crypto.randomUUID()
        logger.error('custom_invite_directory_lookup_failed', { error, correlationId })
        await client.chat.postEphemeral({
          channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
          user: body.user.id,
          text: `Custom Invite recipients could not be matched with the recruitment sheet. Reference: ${correlationId}`,
        })
        return
      }
    }
    const draft = buildEditCaseDraft(caseRecord, templates)
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        ...intakeModal({
          templates,
          draft,
          timeZones: schedulingTimeZones,
          defaultTimeZone,
          recruiters: getTalentRecruiters(),
          roles: getOpenRoles(),
        }),
        private_metadata: buildPrivateMetadata(null, {
          channelId: caseRecord.channelId || body.channel?.id || body.user.id,
          editCaseId: caseRecord.id,
          eventType: draft.eventType,
          customInviteSlackRecipientIds: draft.customInviteSlackRecipientIds,
          customInviteTemplateId: draft.customInviteTemplateId,
          roleId: draft.roleId,
          roleTitle: draft.roleTitle,
          recruiterIds: draft.recruiterIds,
          hiringManagerIds: draft.hiringManagerIds,
          zoomLink: draft.zoomLink,
          zoomLinkAuto: false,
          zoomLinkRevision: 0,
          resumeLink: draft.resumeLink,
          resumeFile: draft.resumeFile,
        }),
      },
    })
  })

  app.action('candidate_search_submit', async ({ ack, body, client }) => {
    await ack();
    const query = body.view?.state?.values?.candidate_search_block?.candidate_search?.value?.trim() || '';
    const intakeDraft = buildIntakeDraft(body.view?.state?.values || {}, await loadSchedulingTemplates(), parsePrivateMetadata(body.view?.private_metadata) || {})
    const filters = roleCandidateFilters(intakeDraft)
    const indexedCandidates = query ? await searchCandidateIndex(store, '', query, 100, filters) : []
    const session = query && indexedCandidates.length === 0
      ? liveCandidateSearch.start({ query, userId: body.user?.id || '', filters })
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
      filters: roleCandidateFilters(metadata),
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

  app.action('event_type_select', async ({ ack, body, client }) => {
    await ack()
    const eventType = selectedOptionValue(body)
    await refreshIntakeModal({
      client,
      body,
      templates: await loadIntakeTemplates(),
      draftOverrides: {
        eventType,
        roleId: '',
        roleTitle: '',
        recruiterIds: [],
        hiringManagerIds: [],
        recruiterSearchQuery: '',
        hiringManagerSearchQuery: '',
        showAdditionalRecruiters: false,
        showAdditionalHiringManagers: false,
        zoomLink: '',
        zoomLinkAuto: false,
        applicant: '',
        candidateSearchQuery: '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchComplete: false,
        candidateSearchSearching: false,
        candidateSearchError: '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('custom_email_template_select', async ({ ack, body, client }) => {
    await ack()
    const templates = await loadIntakeTemplates()
    const templateId = selectedOptionValue(body)
    const selectedTemplate = templates.find((template) => template.id === templateId)
    await refreshIntakeModal({
      client,
      body,
      templates,
      draftOverrides: {
        customInviteTemplateId: templateId,
        ...(selectedTemplate ? {
          customInviteSubject: selectedTemplate.subject,
          customInviteBody: selectedTemplate.body,
        } : {}),
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('role_select', async ({ ack, body, client }) => {
    await ack()
    const roleId = selectedOptionValue(body)
    const role = roleById(roleId)
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const eventType = getSelectedOptionValues(body.view?.state?.values, 'event_type_select')[0] || metadata.eventType || ''
    const roleMatch = resolveRoleAssignmentsForRole(roleId)
    const recruiters = mappedRecruitersForRole(roleId)
    const hiringManagers = mappedHiringManagersForRole(roleId)
    const { recruiterIds, hiringManagerIds } = roleAutofillSelections(
      eventType,
      recruiters,
      hiringManagers,
    )
    const selectedRecruiters = recruiters.filter((person) => recruiterIds.includes(person.id))
    const selectedHiringManagers = hiringManagers.filter((person) => hiringManagerIds.includes(person.id))
    const zoomLink = resolveZoomLinkForRecruiters(selectedRecruiters)
    const syncRoleCandidates = !isTestDirectoryRoleId(role?.roleId || roleId)
    logger.info('role_assignment_match_resolved', {
      roleId: role?.roleId || roleId,
      roleTitle: role?.title || '',
      matchType: roleMatch.matchType,
      matchedTitle: roleMatch.matchedTitle,
      confidence: roleMatch.confidence,
      candidates: roleMatch.candidates,
      assignmentCount: roleMatch.assignments.length,
    })
    const loadingResult = await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        roleId,
        roleTitle: role?.title || '',
        roleTitleInput: role?.title || '',
        recruiterIds,
        recruiterName: selectedRecruiters[0]?.name || '',
        recruiterEmail: selectedRecruiters[0]?.email || '',
        hiringManagerIds,
        hiringManagerName: selectedHiringManagers[0]?.name || '',
        hiringManagerEmail: selectedHiringManagers[0]?.email || '',
        hiringManagerEmailOverride: '',
        recruiterSearchQuery: '',
        hiringManagerSearchQuery: '',
        showAdditionalRecruiters: false,
        showAdditionalHiringManagers: false,
        zoomLink,
        zoomLinkAuto: Boolean(zoomLink),
        applicant: '',
        candidateSearchQuery: '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchComplete: false,
        candidateSearchSearching: false,
        candidateSearchError: '',
        remoteUpdateStatus: syncRoleCandidates ? 'loading' : '',
        remoteUpdateMessage: syncRoleCandidates
          ? `Loading candidates and assignment data for ${role?.title || 'the selected role'} from JazzHR.`
          : '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
    const updatedBody = bodyWithUpdatedView(body, loadingResult)
    if (!syncRoleCandidates) return
    let remoteUpdateError = ''
    try {
      await syncJazzhrJobCandidates({
        config,
        logger,
        store,
        jobId: role?.roleId || roleId,
        concurrency: config.jazzhr.applicantFetchConcurrency,
      })
    } catch (error) {
      logger.warn('intake_role_remote_update_failed', { roleId, error: error.message })
      remoteUpdateError = 'JazzHR candidate data could not be refreshed. Existing cached options and editable fields remain available.'
    }
    await refreshIntakeModalAfterAsync({
      client,
      body: updatedBody,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        roleTitleInput: role?.title || '',
        recruiterName: selectedRecruiters[0]?.name || '',
        recruiterEmail: selectedRecruiters[0]?.email || '',
        hiringManagerName: selectedHiringManagers[0]?.name || '',
        hiringManagerEmail: selectedHiringManagers[0]?.email || '',
        applicant: '',
        zoomLink,
        zoomLinkAuto: Boolean(zoomLink),
        remoteUpdateStatus: remoteUpdateError ? 'error' : '',
        remoteUpdateMessage: remoteUpdateError,
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
      logger,
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
    const loadingResult = await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'applicant',
      selectedId,
      selectedApplicant: applicant,
      showDetails: true,
      draftOverrides: {
        candidateSearchError: '',
        candidateSearchSearching: false,
        applicantName: applicant ? [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') : '',
        applicantEmail: applicant?.email || '',
        applicantPhone: applicant?.phone || '',
        remoteUpdateStatus: 'loading',
        remoteUpdateMessage: 'Loading the selected candidate details from JazzHR.',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
    const updatedBody = bodyWithUpdatedView(body, loadingResult)

    let detailLoadError = ''
    if (applicant?.jazzhrApplicationId) {
      try {
        const detail = await Promise.race([
          fetchApplicantDetail(config.jazzhr.apiKey, applicant.jazzhrApplicationId, logger, {
            jobId: applicant.jazzhrJobId || metadata.roleId || '',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        if (detail) {
          applicant = mergeApplicantDetail(applicant, detail);
          const inactiveReason = applicantEligibilityReason(applicant)
          if (inactiveReason) {
            logger.info('inactive_applicant_selection_blocked', {
              applicantId: selectedId,
              jazzhrApplicationId: applicant.jazzhrApplicationId,
              inactiveReason,
            })
            await client.chat.postEphemeral({
              channel: resolvePostingChannel(config, getChannelId(body.view) || body.user.id),
              user: body.user.id,
              text: `This application is not available for scheduling because its JazzHR stage is "${applicant.stage || inactiveReason}".`,
            })
            await refreshIntakeModalAfterAsync({
              client,
              body: updatedBody,
              templates: await loadSchedulingTemplates(),
              selectedKey: 'applicant',
              selectedId: '',
              draftOverrides: {
                remoteUpdateStatus: 'error',
                remoteUpdateMessage: 'The selected JazzHR application is not eligible for scheduling. Choose another application.',
              },
              timeZones: schedulingTimeZones,
              defaultTimeZone,
              logger,
            })
            return
          }
          setApplicantDetail(selectedId, detail);
        }
      } catch (err) {
        logger.warn('applicant_detail_fetch_failed', { applicantId: selectedId, error: err.message });
        detailLoadError = 'JazzHR candidate details could not be refreshed. Review and edit the cached contact fields below.'
      }
    }

    const applicantRecruiter = !metadata.recruiterIds?.length && applicant?.recruiterId
      ? findMappedPersonById(applicant.recruiterId)
      : null
    const applicantRecruiterIds = applicantRecruiter ? [applicantRecruiter.id] : []

    await refreshIntakeModalAfterAsync({
      client,
      body: updatedBody,
      templates: await loadSchedulingTemplates(),
      selectedKey: 'applicant',
      selectedId,
      selectedApplicant: applicant,
      showDetails: true,
      draftOverrides: {
        ...(applicantRecruiterIds.length > 0 ? {
          recruiterIds: applicantRecruiterIds,
          zoomLink: resolveZoomLinkForRecruiters([asRecruiter(applicantRecruiter)]),
          zoomLinkAuto: true,
        } : {}),
        candidateSearchError: '',
        candidateSearchSearching: false,
        applicantName: applicant ? [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') : '',
        applicantEmail: applicant?.email || '',
        applicantPhone: applicant?.phone || '',
        remoteUpdateStatus: detailLoadError ? 'error' : '',
        remoteUpdateMessage: detailLoadError,
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
      logger,
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
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const mappedRecruiters = metadata.roleId ? mappedRecruitersForRole(metadata.roleId) : []
    const selectedIds = metadata.roleId && metadata.eventType === 'job-offer'
      ? mappedRecruiters.map((person) => person.id)
      : metadata.roleId
      ? normalizeIdList([
          ...getSelectedOptionValues(body.view?.state?.values, 'recruiter_select'),
          ...getSelectedOptionValues(body.view?.state?.values, 'additional_recruiter_select'),
        ])
      : selectedOptionValues(body)
    const selectedId = selectedIds[0] || ''
    const recruiters = metadata.roleId ? mappedRecruiters : getTalentRecruiters()
    const selectedRecruiters = selectedIds.map((id) => findPersonInList(id, recruiters) || findMappedPersonById(id)).filter(Boolean).map(asRecruiter)
    const selectedRecruiter = selectedRecruiters[0] || findPersonInList(selectedId, recruiters)
    if (!selectedRecruiter) {
      logger.warn('recruiter_selection_not_in_talent_directory', {
        selectedId,
      })
    }
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: metadata.roleId ? undefined : 'recruiter',
      selectedId,
      selectedPerson: metadata.roleId ? undefined : (selectedRecruiter
        ? asRecruiter(selectedRecruiter)
        : asRecruiter(personFromSelectedOption(body))),
      draftOverrides: metadata.roleId ? {
        recruiterIds: selectedIds,
        recruiterName: selectedRecruiter?.name || '',
        recruiterEmail: selectedRecruiter?.email || '',
        ...nextRecruiterZoomState(body, metadata, selectedRecruiters),
        candidateSearchQuery: '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchComplete: false,
        candidateSearchSearching: false,
        candidateSearchError: '',
      } : {},
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('recruiter_checkboxes', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const available = mappedRecruitersForRole(metadata.roleId)
    const selectedIds = metadata.eventType === 'job-offer'
      ? available.map((person) => person.id).slice(0, 10)
      : orderedCheckboxSelection(metadata.recruiterIds, selectedOptionValues(body)).slice(0, 10)
    const selectedRecruiters = selectedIds
      .map((id) => findPersonInList(id, available) || findMappedPersonById(id))
      .filter(Boolean)
      .map(asRecruiter)
    const previousPrimaryId = metadata.recruiterIds?.[0] || ''
    const primary = selectedRecruiters[0] || null
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        recruiterIds: selectedIds,
        ...(previousPrimaryId !== (selectedIds[0] || '') ? {
          recruiterName: primary?.name || '',
          recruiterEmail: primary?.email || '',
        } : {}),
        ...nextRecruiterZoomState(body, metadata, selectedRecruiters),
        candidateSearchQuery: '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchComplete: false,
        candidateSearchSearching: false,
        candidateSearchError: '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('recruiter_people_search', async ({ ack, body, client }) => {
    await ack()
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        recruiterSearchQuery: body.actions?.[0]?.value || '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('hm_select', async ({ ack, body, client }) => {
    await ack();
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const selectedIds = metadata.roleId
      ? normalizeIdList([
          ...getSelectedOptionValues(body.view?.state?.values, 'hm_select'),
          ...getSelectedOptionValues(body.view?.state?.values, 'additional_hm_select'),
        ])
      : selectedOptionValues(body)
    const selectedId = selectedIds[0] || ''
    const selectedUser = metadata.roleId
      ? (selectableHiringManagersForRole(metadata.roleId).find((person) => person.id === selectedId) || findMappedPersonById(selectedId))
      : await resolveSlackUser({ client, userId: selectedId, logger })
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      selectedKey: metadata.roleId ? undefined : 'hiringManager',
      selectedId,
      selectedPerson: metadata.roleId ? undefined : (selectedUser ? asHiringManager(selectedUser) : null),
      draftOverrides: metadata.roleId ? {
        hiringManagerIds: selectedIds,
        hiringManagerName: selectedUser?.name || '',
        hiringManagerEmail: selectedUser?.email || '',
      } : {},
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    });
  });

  app.action('additional_recruiters_toggle', async ({ ack, body, client }) => {
    await ack()
    const enabled = selectedCheckboxValue(body, 'enabled')
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        showAdditionalRecruiters: enabled,
        ...(!enabled ? { recruiterIds: getSelectedOptionValues(body.view?.state?.values, 'recruiter_select') } : {}),
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('additional_recruiter_select', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const selectedIds = normalizeIdList([
      ...getSelectedOptionValues(body.view?.state?.values, 'recruiter_select'),
      ...selectedOptionValues(body),
    ])
    const selectedRecruiters = selectedIds
      .map((id) => findPersonInList(id, mappedRecruitersForRole(metadata.roleId)) || findMappedPersonById(id))
      .filter(Boolean)
      .map(asRecruiter)
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        recruiterIds: selectedIds,
        showAdditionalRecruiters: true,
        ...nextRecruiterZoomState(body, metadata, selectedRecruiters),
        candidateSearchQuery: '',
        candidateSearchSessionId: '',
        candidateSearchPage: 0,
        candidateSearchResultCount: 0,
        candidateSearchComplete: false,
        candidateSearchSearching: false,
        candidateSearchError: '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('additional_hms_toggle', async ({ ack, body, client }) => {
    await ack()
    const enabled = selectedCheckboxValue(body, 'enabled')
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        showAdditionalHiringManagers: enabled,
        ...(!enabled ? { hiringManagerIds: getSelectedOptionValues(body.view?.state?.values, 'hm_select') } : {}),
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('additional_hm_select', async ({ ack, body, client }) => {
    await ack()
    const selectedIds = normalizeIdList([
      ...getSelectedOptionValues(body.view?.state?.values, 'hm_select'),
      ...selectedOptionValues(body),
    ])
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        hiringManagerIds: selectedIds,
        showAdditionalHiringManagers: true,
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('zoom_link_select', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        zoomLink: selectedOptionValue(body),
        zoomLinkAuto: false,
        zoomLinkRevision: Number(metadata.zoomLinkRevision || 0) + 1,
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('open_google_oauth', async ({ ack, body, client }) => {
    await ack()
    if (!await verifyChannel({ config, body, client })) return
    const tokenOwnerId = getGoogleTokenOwner(config, body.user.id)
    if (
      config.google.authSlackUserId &&
      !await requireAdminSlackUser({
        config,
        userId: body.user.id,
        client,
        channelId: body.channel?.id,
        logger,
        action: 'open_google_oauth',
      })
    ) return
    if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
      const dmChannel = await openDm(client, body.user.id)
      await client.chat.postMessage({
        channel: dmChannel,
        text: '⚠️ Google OAuth is not configured yet. Set the Google client credentials before connecting a recruiter account.',
      })
      return
    }

    const state = await issueOAuthState({
      store,
      slackUserId: body.user.id,
      teamId: body.team?.id || config.slack.teamId || '',
      tokenOwnerId,
      source: 'slack_home',
    })
    const oauthUrl = buildGoogleOAuthUrl(config, state)
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
    if (
      config.google.authSlackUserId &&
      !await requireAdminSlackUser({
        config,
        userId: body.user.id,
        client,
        channelId: body.channel?.id,
        logger,
        action: 'disconnect_google_oauth',
      })
    ) return
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
    const filters = roleCandidateFilters(metadata || {})
    const indexedCandidates = await searchCandidateIndex(store, options.value, baseQuery, 100, filters)
    const candidates = mergeCandidateOptions(indexedCandidates, liveCandidates)
    const resolvedOptions = candidates.length > 0 || baseQuery || liveSessionId
      ? candidates.slice(0, 100).map(candidateToSlackOption)
      : applicantOptions(options.value, filterApplicants(getApplicants(), filters))
    await ack({ options: resolvedOptions });
  });

  app.options('role_select', async ({ options, ack }) => {
    await ack({ options: roleOptions(options.value) })
  })

  app.options('recruiter_select', async ({ options, ack }) => {
    const metadata = parsePrivateMetadata(options.view?.private_metadata)
    const recruiters = metadata?.roleId ? mappedRecruitersForRole(metadata.roleId) : getTalentRecruiters()
    const slackOptions = metadata?.roleId
      ? compactPersonOptions(options.value, recruiters)
      : personOptions(options.value, recruiters)
    logger.info('recruiter_options_requested', {
      query: options.value,
      recruiterCount: recruiters.length,
      optionCount: slackOptions.length,
      preview: slackOptions.slice(0, 3).map((option) => option.text.text),
    })
    await ack({ options: slackOptions });
  });

  app.options('additional_recruiter_select', async ({ options, ack }) => {
    const metadata = parsePrivateMetadata(options.view?.private_metadata)
    await ack({ options: compactPersonOptions(options.value, mappedRecruitersForRole(metadata?.roleId)) })
  })

  app.options('hm_select', async ({ options, ack, client }) => {
    const metadata = parsePrivateMetadata(options.view?.private_metadata)
    if (metadata?.roleId) {
      await ack({ options: compactPersonOptions(options.value, selectableHiringManagersForRole(metadata.roleId)) })
      return
    }
    const { users } = await ensureSlackDirectory({ client, config, logger })
    await ack({ options: personOptions(options.value, users) });
  });

  app.options('additional_hm_select', async ({ options, ack }) => {
    const metadata = parsePrivateMetadata(options.view?.private_metadata)
    await ack({ options: compactPersonOptions(options.value, selectableHiringManagersForRole(metadata?.roleId)) })
  })

  app.options('custom_slack_recipients', async ({ options, ack, client }) => {
    try {
      if (!options.value) {
        // No search query: show all recruitment ecosystem people (sheet + talent directory)
        await ack({ options: personOptions('', getTalentRecruiters()) })
      } else {
        // Search query: search all Slack workspace users
        const { users } = await ensureSlackDirectory({ client, config, logger })
        await ack({ options: personOptions(options.value, users) })
      }
    } catch (error) {
      logger.warn('custom_invite_recipient_options_failed', {
        error: error.message,
        slackError: error.data?.error,
      })
      await ack({ options: [] })
    }
  })

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
    const selectedEventType = values.event_type_block?.event_type_select?.selected_option?.value || ''
    const selectedCustomInviteOptions = getSelectedOptions(values, 'custom_slack_recipients')
    const selectedCustomInviteUserIds = getSelectedOptionValues(values, 'custom_slack_recipients')
    let selectedCustomInviteUsers = []
    if (selectedEventType === 'custom-invite' && selectedCustomInviteUserIds.length > 0) {
      // Build combined lookup map from all available people sources
      const byId = new Map()
      for (const person of getTalentRecruiters()) {
        if (person.id) byId.set(person.id, person)
      }
      for (const person of getSlackRecruiters()) {
        if (person.slackUserId) byId.set(person.slackUserId, person)
        if (person.id) byId.set(person.id, person)
      }
      for (const person of getSlackUsers()) {
        if (person.slackUserId) byId.set(person.slackUserId, person)
        if (person.id) byId.set(person.id, person)
      }

      let invalidIds = selectedCustomInviteUserIds.filter((id) => !byId.has(id))

      // Try to resolve unknown IDs from selected option labels
      if (invalidIds.length > 0) {
        const optionFallbackUsers = selectedCustomInviteOptions
          .filter((option) => invalidIds.includes(option.value))
          .map(slackRecipientFromSelectedOption)
          .filter(Boolean)
        for (const user of optionFallbackUsers) {
          byId.set(user.slackUserId || user.id, user)
        }
        invalidIds = selectedCustomInviteUserIds.filter((id) => !byId.has(id))
      }

      // Try Slack API resolution for remaining Slack-format user IDs
      if (invalidIds.length > 0) {
        for (const id of invalidIds) {
          if (id.startsWith('U') || id.startsWith('W')) {
            try {
              const resolved = await resolveSlackUser({ client, userId: id, logger })
              if (resolved) byId.set(id, resolved)
            } catch {
              // resolveSlackUser handles its own logging
            }
          }
        }
        invalidIds = selectedCustomInviteUserIds.filter((id) => !byId.has(id))
      }

      if (invalidIds.length > 0) {
        await ack({
          response_action: 'errors',
          errors: {
            custom_slack_recipients_block: 'Could not identify one or more selected recipients. Make sure the person exists in Slack or use "External emails" for guests without Slack accounts.',
          },
        })
        return
      }
      selectedCustomInviteUsers = selectedCustomInviteUserIds.map((id) => byId.get(id))
    }
    const templates = await loadIntakeTemplates();
    const metadata = parsePrivateMetadata(view.private_metadata) || {}
    const editCase = metadata.editCaseId ? await store.getCase(metadata.editCaseId) : null
    if (metadata.editCaseId && !canEditScheduleCase(editCase)) {
      await ack({
        response_action: 'errors',
        errors: {
          event_type_block: 'This case can no longer be edited because its calendar event has already been created.',
        },
      })
      return
    }
    const intakeDraft = buildIntakeDraft(values, templates, {
      editCaseId: metadata.editCaseId || '',
      customInviteSlackRecipientIds: selectedCustomInviteUserIds,
      customInviteSlackRecipients: selectedCustomInviteUsers,
      remoteUpdateStatus: metadata.remoteUpdateStatus || '',
      remoteUpdateMessage: metadata.remoteUpdateMessage || '',
      manualCandidateMode: metadata.manualCandidateMode,
    });
    if (intakeDraft.standardEventType) {
      if (!hasCheckboxSelection(values, 'recruiter_checkboxes') && metadata.recruiterIds?.length) {
        intakeDraft.recruiterIds = normalizeIdList(metadata.recruiterIds)
        intakeDraft.recruiterId = intakeDraft.recruiterIds[0] || ''
      }
      if (!hasCheckboxSelection(values, 'hiring_manager_checkboxes') && metadata.hiringManagerIds?.length) {
        intakeDraft.hiringManagerIds = normalizeIdList(metadata.hiringManagerIds)
        intakeDraft.hiringManagerId = intakeDraft.hiringManagerIds[0] || ''
      }
    }
    const applicantId = intakeDraft.applicantId;
    const templateId = intakeDraft.templateId;
    const stageKey = intakeDraft.stageKey;
    const recruiterId = intakeDraft.recruiterId;
    const notes = intakeDraft.notes;
    const resumeLink = intakeDraft.resumeLink || editCase?.resumeLink || null;
    const resumeFile = intakeDraft.resumeFile || editCase?.resumeFile || null;
    const zoomLink = intakeDraft.zoomLink;
    const interviewTimezone = intakeDraft.interviewTimezone || defaultTimeZone;
    const requiresHiringManager = stageRequiresHiringManager(stageKey)
    const requiresResume = stageRequiresResumeLink(stageKey)
    const standardEventType = intakeDraft.standardEventType
    const errors = {};

    if (intakeDraft.eventType === 'custom-invite') {
      const customInviteErrors = validateCustomInviteDraft(intakeDraft)
      for (const [blockId, message] of Object.entries(customInviteErrors)) {
        if (blockId === 'custom_subject_block') {
          errors[findInputBlockId(values, 'custom_subject', blockId)] = message
        } else if (blockId === 'custom_body_block') {
          errors[findInputBlockId(values, 'custom_body', blockId)] = message
        } else {
          errors[blockId] = message
        }
      }
      if (Object.keys(errors).length > 0) {
        await ack({ response_action: 'errors', errors })
        return
      }

      await ack()
      const coordinator = await resolveSlackUser({ client, userId: body.user.id, logger })
      const customInvite = {
        templateId: intakeDraft.customInviteTemplateId,
        title: intakeDraft.customInviteTitle,
        subject: intakeDraft.customInviteSubject,
        body: intakeDraft.customInviteBody,
        recipients: intakeDraft.customInviteRecipients,
        meetingLink: intakeDraft.customInviteMeetingLink,
        deliveryStatus: {},
      }
      if (editCase) {
        const updated = await store.updateCase(editCase.id, {
          eventType: 'custom-invite',
          externalAttendees: customInviteExternalAttendees(customInvite.recipients),
          notes,
          interviewTimezone,
          customInvite,
          autofill: {
            ...(editCase.autofill || {}),
            zoomLink: customInvite.meetingLink,
            customInvitePurpose: customInvite.title,
          },
        })
        await store.addAudit({
          caseId: updated.id,
          actorSlackUserId: body.user.id,
          action: 'case_updated',
        })
        await updateCaseSlackMessage({ client, caseRecord: updated })
        await publishHome({ client, userId: body.user.id, store, logger, config })
        return
      }
      const caseRecord = await store.createCase({
        ownerSlackUserId: body.user.id,
        channelId: getChannelId(body.view) || body.user.id,
        eventType: 'custom-invite',
        applicant: null,
        recruiter: null,
        hiringManager: null,
        externalAttendees: customInviteExternalAttendees(customInvite.recipients),
        attendanceOverrides: {},
        templateId: null,
        stageKey: null,
        notes,
        resumeLink: null,
        resumeFile: null,
        interviewWindowStartDate: null,
        interviewWindowEndDate: null,
        interviewTimezone,
        customInvite,
        autofill: {
          zoomLink: customInvite.meetingLink,
          coordinatorEmail: coordinator?.email || '',
          coordinatorName: coordinator?.name || '',
          customInvitePurpose: customInvite.title,
        },
      })

      await store.addAudit({
        caseId: caseRecord.id,
        actorSlackUserId: body.user.id,
        action: 'event_created',
        recipientCount: customInvite.recipients.length,
      })

      const caseMessage = await postSharedActionMessage({
        client,
        channel: resolvePostingChannel(config, body.user.id),
        actorSlackUserId: body.user.id,
        text: 'Event scheduling case created',
        blocks: caseMessageBlocks(caseRecord),
      })
      await store.updateCase(caseRecord.id, {
        autofill: {
          ...(caseRecord.autofill || {}),
          caseMessageTs: caseMessage.ts,
          caseMessageChannel: caseMessage.channel,
        },
      })
      await publishHome({ client, userId: body.user.id, store, logger, config })
      return
    }

    if (intakeDraft.remoteUpdateStatus === 'loading') {
      errors.event_type_block = 'Wait for the form update to finish before submitting.'
    }
    if (!intakeDraft.eventType) {
      errors.event_type_block = 'Choose an event type.';
    }
    if (!stageKey) {
      errors[intakeDraft.eventType === 'custom-invite' ? 'stage_block' : 'event_type_block'] = 'Choose an interview stage.';
    }
    if (standardEventType && !intakeDraft.roleId) {
      errors.role_block = 'Choose an open JazzHR role.';
    }
    if (standardEventType && intakeDraft.roleId && intakeDraft.recruiterIds.length === 0) {
      errors[findInputBlockId(values, 'recruiter_checkboxes', 'recruiters_block')] = 'Choose at least one recruiter.';
    }
    if (standardEventType && intakeDraft.recruiterIds.length > 10) {
      errors[findInputBlockId(values, 'recruiter_checkboxes', 'recruiters_block')] = 'Choose no more than 10 recruiters.';
    }
    if (intakeDraft.eventType === 'custom-invite' && !intakeDraft.customInvitePurpose) {
      errors.custom_purpose_block = 'Enter what this invite is for.';
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
      errors[findInputBlockId(values, 'applicant_select', 'applicant_block')] = 'Choose a candidate.';
    }

    if (intakeDraft.applicantEmail && !isValidEmail(intakeDraft.applicantEmail)) {
      errors[findInputBlockId(values, 'applicant_email', 'applicant_email_block')] = 'Enter a valid applicant email.';
    }
    if (intakeDraft.recruiterEmail && !isValidEmail(intakeDraft.recruiterEmail)) {
      errors[findInputBlockId(values, standardEventType ? 'recruiter_checkboxes' : 'recruiter_select', standardEventType ? 'recruiters_block' : 'recruiter_block')] = 'Selected recruiter has an invalid email.';
    }
    if (requiresHiringManager && intakeDraft.roleId && !intakeDraft.hiringManagerId) {
      errors[findInputBlockId(values, 'hiring_manager_checkboxes', 'hiring_managers_block')] = 'Choose a hiring manager.';
    }
    if (requiresHiringManager && intakeDraft.hiringManagerIds.length > 10) {
      errors[findInputBlockId(values, 'hiring_manager_checkboxes', 'hiring_managers_block')] = 'Choose no more than 10 hiring managers.';
    }
    const hiringManagerEmailActionId = intakeDraft.hiringManagerNeedsEmail
      ? 'hiring_manager_email_override'
      : (standardEventType ? 'hiring_manager_checkboxes' : 'hm_select')
    const hiringManagerEmailBlockId = intakeDraft.hiringManagerNeedsEmail
      ? 'hiring_manager_email_block'
      : (standardEventType ? 'hiring_managers_block' : 'hm_block')
    if (requiresHiringManager && intakeDraft.hiringManagerId && !intakeDraft.hiringManagerEmail) {
      errors[findInputBlockId(values, hiringManagerEmailActionId, hiringManagerEmailBlockId)] = 'Enter the hiring manager email.';
    } else if (intakeDraft.hiringManagerEmail && !isValidEmail(intakeDraft.hiringManagerEmail)) {
      errors[findInputBlockId(values, hiringManagerEmailActionId, hiringManagerEmailBlockId)] = 'Enter a valid hiring manager email.';
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    if (!zoomLink) {
      await ack({
        response_action: 'errors',
        errors: {
          [findInputBlockId(values, 'zoom_link', 'zoom_block')]: 'Enter the final Zoom link.',
        },
      });
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
    if (editCase) {
      const updated = await store.updateCase(editCase.id, {
        eventType: intakeDraft.eventType,
        applicant,
        recruiter,
        hiringManager,
        externalAttendees: intakeDraft.extraAttendees,
        attendanceOverrides: hiringManager ? { hiringManagerIncluded: true } : {},
        templateId,
        stageKey,
        notes,
        resumeLink,
        resumeFile: renameResumeFile(resumeFile, intakeDraft.roleTitle, applicant),
        interviewTimezone,
        autofill: {
          ...(editCase.autofill || {}),
          zoomLink,
          signature: recruiter?.signature || 'Recruitment Team',
          eventType: intakeDraft.eventType,
          roleId: intakeDraft.roleId,
          roleTitle: intakeDraft.roleTitle,
        },
      })
      await store.addAudit({
        caseId: updated.id,
        actorSlackUserId: body.user.id,
        action: 'case_updated',
        templateId,
        stageKey,
      })
      await updateCaseSlackMessage({ client, caseRecord: updated })
      await publishHome({ client, userId: body.user.id, store, logger, config })
      return
    }
    const caseRecord = await store.createCase({
      ownerSlackUserId: body.user.id,
      channelId: getChannelId(body.view) || body.user.id,
      eventType: intakeDraft.eventType,
      applicant,
      recruiter,
      hiringManager,
      externalAttendees: intakeDraft.extraAttendees,
      attendanceOverrides: intakeDraft.hiringManager ? { hiringManagerIncluded: true } : {},
      templateId,
      stageKey,
      notes,
      resumeLink,
      resumeFile: renameResumeFile(resumeFile, intakeDraft.roleTitle, applicant),
      interviewWindowStartDate: null,
      interviewWindowEndDate: null,
      interviewTimezone,
      autofill: {
        zoomLink,
        signature: recruiter?.signature || 'Recruitment Team',
        eventType: intakeDraft.eventType,
        coordinatorEmail: coordinator?.email || '',
        coordinatorName: coordinator?.name || '',
        roleId: intakeDraft.roleId,
        roleTitle: intakeDraft.roleTitle,
        customInvitePurpose: intakeDraft.customInvitePurpose,
      },
    });

    await store.addAudit({
      caseId: caseRecord.id,
      actorSlackUserId: body.user.id,
      action: 'case_created',
      templateId,
      stageKey,
    });

    const caseMessage = await postSharedActionMessage({
      client,
      channel: resolvePostingChannel(config, body.user.id),
      actorSlackUserId: body.user.id,
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
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
        const templates = await loadTemplates();
        const template = templates.find((item) => item.id === caseRecord.templateId) || templates[0];
        const renderedTemplate = renderTemplate(template, buildTemplateVariables(caseRecord));
        const recentAudits = await store.listAudits(caseRecord.id, 5);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: candidateMessageModal({ caseRecord, renderedTemplate, recentAudits }),
        });
      },
    })
  });

  app.action('open_reminder_message_modal', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
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
      },
    })
  });

  app.action('view_resume', async ({ ack, body, client }) => {
    await ack();
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
        if (!caseRecord.resumeLink) {
          await postSharedActionMessage({
            client,
            channel: resolvePostingChannel(config, body.user.id),
            actorSlackUserId: body.user.id,
            text: `📄 No resume has been uploaded for ${caseRecord.id} yet.`,
          });
          return;
        }

        const details = canOpenResumeReference(caseRecord.resumeLink)
          ? [`📄 Resume for ${caseRecord.id}:`, resumeSlackLink(caseRecord)].join('\n')
          : [`📄 Resume for ${caseRecord.id}:`, resumePlainLink(caseRecord)].join('\n');

        await postSharedActionMessage({
          client,
          channel: resolvePostingChannel(config, body.user.id),
          actorSlackUserId: body.user.id,
          text: details,
        });
        await store.addAudit({
          caseId: caseRecord.id,
          actorSlackUserId: body.user.id,
          action: 'resume_viewed',
          resumeLink: caseRecord.resumeLink,
        });
      },
    })
  });

  app.view('candidate_message_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { email_body_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
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

    const renderedCandidateEmail = await buildScheduledCandidateEmail(caseRecord)
    const emailBodies = emailBodiesFromPreview(renderedCandidateEmail, plainBody)
    const email = {
      subject,
      body: emailBodies.htmlBody,
      htmlBody: emailBodies.htmlBody,
      plainBody: emailBodies.plainBody,
      to: caseRecord.applicant?.email,
      from: caseRecord.recruiter?.email,
    };
    try {
      await addRequiredResumeAttachment({ email, caseRecord, client, config, logger })
    } catch (error) {
      await ack({
        response_action: 'errors',
        errors: { email_body_block: error.message },
      })
      return
    }
    if (hasBlockingEmailStatus(caseRecord.gmailSendStatus) && isSameEmail(caseRecord.candidateEmail, email)) {
      await ack();
      await postSharedActionMessage({
        client,
        channel: resolvePostingChannel(config, body.user.id),
        actorSlackUserId: body.user.id,
        text: `⚠️ This candidate email has already been sent for ${caseId}.`,
      });
      return
    }

    await ack();
    const pendingEmailCase = await store.updateCase(caseId, {
      status: 'Waiting for Candidate',
      candidateEmail: persistableEmail(email),
      gmailSendStatus: 'sending',
    });
    const emailResult = await sendRecruiterEmail({ config, logger, caseRecord: pendingEmailCase, email, store });
    const updated = await store.updateCase(caseId, {
      status: 'Waiting for Candidate',
      candidateEmail: persistableEmail(email),
      gmailSendStatus: emailResult.mocked ? 'mocked' : 'sent',
    });
    await store.addAudit({
      caseId,
      actorSlackUserId: body.user.id,
      action: 'candidate_email_approved',
      templateId: caseRecord.templateId,
    });
    await publishHome({ client, userId: body.user.id, store, logger, config });
    await postSharedActionMessage({
      client,
      channel: resolvePostingChannel(config, body.user.id),
      actorSlackUserId: body.user.id,
      text: `Candidate message approved for ${caseId}.`,
      blocks: caseMessageBlocks(updated),
    });
  });

  app.view('reminder_message_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { email_body_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
    if (
      caseRecord.reminderEmail?.kind === 'manual_reminder' &&
      hasBlockingEmailStatus(caseRecord.reminderStatus) &&
      caseRecord.reminderScheduleVersion === caseRecord.scheduleVersion
    ) {
      await ack();
      await postSharedActionMessage({
        client,
        channel: resolvePostingChannel(config, body.user.id),
        actorSlackUserId: body.user.id,
        text: `⚠️ A reminder has already been sent for schedule version ${caseRecord.scheduleVersion}.`,
      });
      return;
    }
    const plainBody = view.state.values.email_body_block.email_body.value || '';
    const templates = await loadTemplates()
    const template = templates.find((item) => item.id === 'interview-reminder')
    const renderedReminder = template
      ? renderTemplate(template, buildTemplateVariables(caseRecord))
      : buildReminderEmail(caseRecord)
    const emailBodies = emailBodiesFromPreview({
      body: renderedReminder.body,
      htmlBody: renderedReminder.htmlBody || renderedReminder.body,
      plainBody: renderedReminder.plainBody,
    }, plainBody)
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
    await postSharedActionMessage({
      client,
      channel: resolvePostingChannel(config, body.user.id),
      actorSlackUserId: body.user.id,
      text: `🔔 Reminder sent for ${caseId}.`,
      blocks: caseMessageBlocks(updated),
    });
  });

  app.action('open_finalize_modal', async ({ ack, body, client }) => {
    await ack();
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
        const recentAudits = await store.listAudits(caseRecord.id, 5);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: finalizeModal(caseRecord, recentAudits),
        });
      },
    })
  });

  app.action('scheduling_open', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    try {
      const caseId = body.actions?.[0]?.value || body.view?.private_metadata
      const caseRecord = await requireCase(store, caseId)
      if (isCustomInviteCase(caseRecord)) {
        const recentAudits = await store.listAudits(caseRecord.id, 5)
        await client.views.open({
          trigger_id: body.trigger_id,
          view: finalizeModal(caseRecord, recentAudits),
        })
        return
      }
      const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
      const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
      const attendees = normalizeAttendees(caseRecord, stageRules)
      const recentAudits = await store.listAudits(caseRecord.id, 5)

      await client.views.open({
        trigger_id: body.trigger_id,
        view: schedulingModal(caseRecord, { phase: 1, stageRules, attendees, stageKey }, recentAudits)
      })
    } catch (error) {
      const correlationId = crypto.randomUUID()
      logger.error('scheduling_open_error', { error, correlationId })
      error.message = `Reference: ${correlationId}`
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user?.id || body.user.id),
        user: body.user.id,
        text: `❌ Could not open scheduling: ${error.message}`
      })
    }
  })

  app.view('scheduling_phase_one', async ({ ack, body, view, client }) => {
    let schedulingCaseId = null
    let schedulingCaseRecord = null
    try {
      let metadata = {}
      try {
        metadata = JSON.parse(view.private_metadata || '{}')
      } catch (_) {
        metadata = { caseId: view.private_metadata }
      }
      const caseId = metadata.caseId
      schedulingCaseId = caseId

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
      schedulingCaseRecord = caseRecord

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
      await store.updateCase(caseRecord.id, {
        lastAvailabilityCheck: result.availabilityCheck
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
      const correlationId = crypto.randomUUID()
      logger.error('scheduling_check_availability_error', {
        caseId: schedulingCaseId,
        error,
        correlationId,
      })
      if (!body?.view?.id) return

      try {
        await client.views.update({
          view_id: body.view.id,
          view: availabilityCheckErrorModal(
            schedulingCaseRecord || { id: schedulingCaseId },
            `Availability could not be checked. Reference: ${correlationId}`,
          ),
        })
      } catch (viewError) {
        logger.warn('scheduling_availability_error_modal_failed', { error: viewError.message })
        await client.chat.postEphemeral({
          channel: resolvePostingChannel(config, body.user.id),
          user: body.user.id,
          text: `Could not check availability. Reference: ${correlationId}`
        })
      }
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
    let caseRecord
    try {
      let metadata = {}
      try { metadata = JSON.parse(view.private_metadata || '{}') } catch (_) { metadata = {} }

      const caseId = metadata.caseId || body.view?.previous_view_id
      caseRecord = await requireCase(store, caseId)
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
      await addRequiredResumeAttachment({
        email: scheduledCandidateEmail,
        caseRecord: previewCaseRecord,
        client,
        config,
        logger,
      })
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
      if (config.notifications?.enabled) {
        await scheduleCaseNotifications({ store, caseRecord: updated })
      }

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
        candidateEmail: persistableEmail(scheduledCandidateEmail),
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
      const correlationId = crypto.randomUUID()
      logger.error('scheduling_confirm_error', {
        error,
        correlationId,
        caseId: caseRecord?.id,
        resumeFileId: caseRecord?.resumeFile?.id,
        hasResumeDownloadUrl: Boolean(caseRecord?.resumeFile?.downloadUrl || caseRecord?.resumeFile?.url_private_download || caseRecord?.resumeLink),
      })
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.user.id),
        user: body.user.id,
        text: `Could not schedule interview. Reference: ${correlationId}`
      })
    }
  })

  app.view('finalize_schedule_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { date_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
    if (!canFinalizeSchedule(caseRecord)) {
      await ack({
        response_action: 'errors',
        errors: {
          date_block: isCustomInviteCase(caseRecord)
            ? 'This event is already scheduled.'
            : 'This case is already scheduled. Use Reschedule interview instead.',
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
    if (isCustomInviteCase(caseRecord)) {
      const customInvite = normalizeCustomInviteMetadata(caseRecord)
      const durationMinutes = Number(view.state.values.duration_block?.duration_select?.selected_option?.value || 30)
      const attendees = customInvite.recipients.map((recipient) => recipient.email)
      const attendeeDetails = customInviteExternalAttendees(customInvite.recipients)
      const scheduleSnapshot = buildScheduleSnapshot({
        date: converted.date,
        time: converted.time,
        zoomLink,
        attendees,
        attendeeDetails,
        durationMinutes,
      })
      const previewCaseRecord = {
        ...caseRecord,
        customInvite: {
          ...customInvite,
          meetingLink: zoomLink,
        },
        selectedInterviewDate: converted.date,
        selectedInterviewTime: converted.time,
        currentSchedule: scheduleSnapshot,
      }
      const previewVariables = buildCustomInvitePreviewVariables(previewCaseRecord)
      const renderedTemplate = {
        subject: replaceInviteVariables(customInvite.subject, previewVariables),
        body: replaceInviteVariables(customInvite.body, previewVariables),
        plainBody: replaceInviteVariables(customInvite.body, previewVariables),
      }
      const scheduleInput = {
        eventTitle: customInvite.title,
        startDate: converted.date,
        startTime: converted.time,
        durationMinutes,
        meetingLink: zoomLink,
        zoomLink,
        attendees,
        attendeeDetails,
        timeZone: interviewTimeZone,
      }
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
      return
    }

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
    const allAttendees = normalizeAttendees(finalCaseRecord, finalizeStageRules)
    const includedEmails = allAttendees
      .filter((attendee) => attendee.included)
      .map((attendee) => attendee.email)
      .filter(Boolean)
    const includedPeople = allAttendees.filter((attendee) => attendee.included)
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
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId)
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { email_subject_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
    if (!canFinalizeSchedule(caseRecord)) {
      await ack({
        response_action: 'errors',
        errors: {
          email_subject_block: isCustomInviteCase(caseRecord)
            ? 'This event is already scheduled.'
            : 'This case is already scheduled. Use Reschedule interview instead.',
        },
      })
      return
    }

    if (isCustomInviteCase(caseRecord)) {
      await ack({
        response_action: 'update',
        view: customInviteRequestStatusModal({
          title: 'Scheduling Event',
          message: 'Creating the calendar event and sending personalized invitations...',
        }),
      })
    } else {
      await ack()
    }
    try {
      const emailSubject = view.state.values.email_subject_block.email_subject.value
      const emailBody = view.state.values.email_body_block.email_body.value
      if (isCustomInviteCase(caseRecord)) {
        const customInvite = {
          ...normalizeCustomInviteMetadata(caseRecord),
          subject: emailSubject,
          body: emailBody,
          meetingLink: scheduleInput.meetingLink || scheduleInput.zoomLink || '',
        }
        const finalCaseRecord = {
          ...caseRecord,
          customInvite,
        }
        const eventResult = await createCalendarEvent({
          config,
          logger,
          caseRecord: finalCaseRecord,
          store,
          eventInput: {
            ...scheduleInput,
            eventTitle: customInvite.title,
            meetingLink: customInvite.meetingLink,
            description: [
              caseRecord.notes || '',
              customInvite.meetingLink ? `Meeting link: ${customInvite.meetingLink}` : '',
            ].filter(Boolean).join('\n'),
          },
        })
        const scheduleSnapshot = buildScheduleSnapshot({
          date: scheduleInput.startDate,
          time: scheduleInput.startTime,
          zoomLink: customInvite.meetingLink,
          attendees: scheduleInput.attendees,
          attendeeDetails: scheduleInput.attendeeDetails,
          durationMinutes: scheduleInput.durationMinutes,
          eventId: eventResult.eventId,
          htmlLink: eventResult.googleEvent?.htmlLink || null,
        })
        const updated = await store.updateCase(caseId, {
          ...applyScheduledEvent(finalCaseRecord, eventResult, scheduleSnapshot),
          customInvite,
          externalAttendees: customInviteExternalAttendees(customInvite.recipients),
        })
        await store.addAudit({
          caseId,
          actorSlackUserId: body.user.id,
          action: 'calendar_event_approved',
          eventId: eventResult.eventId,
        })
        const deliveryResults = await deliverCustomInviteEmails({
          config,
          logger,
          store,
          caseRecord: updated,
        })
        const finalRecord = await requireCase(store, caseId)
        await store.addAudit({
          caseId,
          actorSlackUserId: body.user.id,
          action: 'custom_invitations_sent',
          sent: deliveryResults.filter((result) => result.status === 'sent' || result.status === 'mocked').length,
          failed: deliveryResults.filter((result) => result.status === 'failed').length,
        })
        await publishHome({ client, userId: body.user.id, store, logger, config })
        await postCaseThreadMessage({
          client,
          config,
          body,
          store,
          caseRecord: finalRecord,
          text: 'Event scheduled',
          blocks: caseMessageBlocks(finalRecord),
          saveAsScheduledMessage: true,
        })
        if (body.view?.id) {
          await client.views.update({
            view_id: body.view.id,
            view: customInviteRequestStatusModal({
              title: 'Event Scheduled',
              message: 'The event was created and invitation delivery is complete.',
              status: 'success',
            }),
          })
        }
        return
      }

      const finalCaseRecord = {
        ...caseRecord,
        stageKey: scheduleInput.stageKey || caseRecord.stageKey,
        templateId: scheduleInput.templateId || caseRecord.templateId,
        stageOverrides: scheduleInput.stageOverrides || caseRecord.stageOverrides || {},
      }
      const previewCaseRecord = {
        ...finalCaseRecord,
        currentSchedule: buildScheduleSnapshot({
          date: scheduleInput.startDate,
          time: scheduleInput.startTime,
          zoomLink: scheduleInput.zoomLink,
          attendees: scheduleInput.attendees,
          attendeeDetails: scheduleInput.attendeeDetails,
          durationMinutes: scheduleInput.durationMinutes,
        }),
      }
      const renderedCandidateEmail = await buildScheduledCandidateEmail(previewCaseRecord)
      const emailBodies = emailBodiesFromPreview(renderedCandidateEmail, emailBody)
      const scheduledCandidateEmail = {
        ...renderedCandidateEmail,
        subject: emailSubject,
        ...emailBodies,
      }
      await addRequiredResumeAttachment({
        email: scheduledCandidateEmail,
        caseRecord: previewCaseRecord,
        client,
        config,
        logger,
      })
      scheduledCandidateEmail.body = scheduledCandidateEmail.htmlBody
      const eventResult = await createCalendarEvent({
        config,
        logger,
        caseRecord: finalCaseRecord,
        store,
        eventInput: {
          ...scheduleInput,
          description: stripSignatureHtml(scheduledCandidateEmail.htmlBody || plainTextToHtml(emailBody)),
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

      if (config.notifications?.enabled) {
        await scheduleCaseNotifications({ store, caseRecord: updated })
      }
      const candidateEmailResult = await sendRecruiterEmail({ config, logger, caseRecord: updated, email: scheduledCandidateEmail, store });
      const attendeeInviteResults = await sendAttendeeInviteEmails({ config, logger, store, caseRecord: updated })
      const reminderUpdated = await store.updateCase(caseId, {
        candidateEmail: persistableEmail(scheduledCandidateEmail),
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
      const correlationId = crypto.randomUUID()
      logger.error('finalize_email_preview_submit_error', { caseId, error, correlationId })
      if (isCustomInviteCase(caseRecord) && body.view?.id) {
        await client.views.update({
          view_id: body.view.id,
          view: customInviteRequestStatusModal({
            title: 'Request Failed',
            message: `The event could not be completed. Reference: ${correlationId}`,
            status: 'error',
          }),
        })
        return
      }
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: `Could not complete scheduling. Reference: ${correlationId}`,
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
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
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
      },
    })
  });

  app.view('reschedule_submit', async ({ ack, body, view, client }) => {
    const caseId = view.private_metadata;
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { reschedule_reason_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
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
    let caseRecord
    try {
      caseRecord = await requireCase(store, caseId);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        await notifyCaseNotFound({ caseId, client, body, config, logger })
        await ack({ response_action: 'errors', errors: { email_subject_block: 'This case is no longer available.' } })
        return
      }
      throw error
    }
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
    if (config.notifications?.enabled) {
      await scheduleCaseNotifications({ store, caseRecord: updated })
    }
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
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
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
      },
    })
  });

  app.action('mark_event_complete', async ({ ack, body, client }) => {
    await ack()
    const actionValue = completionActionValue(body.actions?.[0]?.value)
    const caseId = actionValue.caseId
    const result = await markCaseComplete({
      store,
      caseId,
      actorSlackUserId: body.user.id,
      scheduleVersion: actionValue.scheduleVersion,
    })
    const message = result.stale
      ? 'This completion button belongs to an older schedule. The current event was not changed.'
      : (result.alreadyCompleted
          ? 'This event was already marked complete. No duplicate feedback email was queued.'
          : 'Event marked complete. The candidate feedback request has been queued.')
    const channel = body.channel?.id || await openDm(client, body.user.id)
    await postSharedActionMessage({
      client,
      channel,
      actorSlackUserId: body.user.id,
      text: message,
    })
    if (!result.alreadyCompleted && !result.stale) {
      await store.addAudit({
        caseId,
        actorSlackUserId: body.user.id,
        action: 'event_marked_complete',
      })
    }
    await publishHome({ client, userId: body.user.id, store, logger, config })
  })

  app.action('hiring_manager_checkboxes', async ({ ack, body, client }) => {
    await ack()
    const metadata = parsePrivateMetadata(body.view?.private_metadata) || {}
    const available = selectableHiringManagersForRole(metadata.roleId)
    const selectedIds = orderedCheckboxSelection(
      metadata.hiringManagerIds,
      selectedOptionValues(body),
    ).slice(0, 10)
    const previousPrimaryId = metadata.hiringManagerIds?.[0] || ''
    const primary = selectedIds.length > 0
      ? (findPersonInList(selectedIds[0], available) || findMappedPersonById(selectedIds[0]))
      : null
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        hiringManagerIds: selectedIds,
        ...(previousPrimaryId !== (selectedIds[0] || '') ? {
          hiringManagerName: primary?.name || '',
          hiringManagerEmail: primary?.email || '',
          hiringManagerEmailOverride: '',
        } : {}),
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('hiring_manager_people_search', async ({ ack, body, client }) => {
    await ack()
    await refreshIntakeModal({
      client,
      body,
      templates: await loadSchedulingTemplates(),
      draftOverrides: {
        hiringManagerSearchQuery: body.actions?.[0]?.value || '',
      },
      timeZones: schedulingTimeZones,
      defaultTimeZone,
    })
  })

  app.action('retry_custom_invites', async ({ ack, body, client }) => {
    await ack()
    const caseId = body.actions?.[0]?.value
    await guardCaseAction({
      store, caseId, client, body, config, logger,
      handler: async (caseRecord) => {
    if (!isCustomInviteCase(caseRecord) || !caseRecord.calendarEventId) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'This event is not ready to send invitations.',
      })
      return
    }

    const loadingView = body.trigger_id
      ? await client.views.open({
          trigger_id: body.trigger_id,
          view: customInviteRequestStatusModal({
            title: 'Sending Invitations',
            message: 'Retrying invitations that have not been delivered...',
          }),
        })
      : null
    const loadingViewId = loadingView?.view?.id
    try {
      const results = await deliverCustomInviteEmails({ config, logger, store, caseRecord })
      const sent = results.filter((result) => result.status === 'sent' || result.status === 'mocked').length
      const failed = results.filter((result) => result.status === 'failed').length
      const skipped = results.filter((result) => result.status === 'skipped').length
      const updated = await requireCase(store, caseId)
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: `Invitation retry complete: ${sent} sent, ${failed} failed, ${skipped} already delivered.`,
      })
      await postCaseThreadMessage({
        client,
        config,
        body,
        store,
        caseRecord: updated,
        text: 'Invitation delivery updated',
        blocks: caseMessageBlocks(updated),
        saveAsScheduledMessage: true,
      })
      if (loadingViewId) {
        await client.views.update({
          view_id: loadingViewId,
          view: customInviteRequestStatusModal({
            title: failed > 0 ? 'Retry Completed' : 'Invitations Sent',
            message: `${sent} sent, ${failed} failed, ${skipped} already delivered.`,
            status: failed > 0 ? 'error' : 'success',
          }),
        })
      }
    } catch (error) {
      const correlationId = crypto.randomUUID()
      logger.error('custom_invite_retry_failed', { caseId, error, correlationId })
      if (loadingViewId) {
        await client.views.update({
          view_id: loadingViewId,
          view: customInviteRequestStatusModal({
            title: 'Retry Failed',
            message: `Invitations could not be retried. Reference: ${correlationId}`,
            status: 'error',
          }),
        })
      }
    }
      },
    })
  })

  app.action('view_custom_invite_emails', async ({ ack, body, client }) => {
    await ack()
    if (!await verifyChannel({ config, body, client })) return
    await guardCaseAction({
      store, caseId: body.actions?.[0]?.value, client, body, config, logger,
      handler: async (caseRecord) => {
    if (!isCustomInviteCase(caseRecord) || !isScheduledCase(caseRecord)) {
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: 'Invitation emails are available after this event is scheduled.',
      })
      return
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: customInviteSentEmailsModal(caseRecord),
    })
      },
    })
  })

  app.action('view_calendar_details', async ({ ack, body, client }) => {
    await ack();
    if (!await verifyChannel({ config, body, client })) return
    await guardCaseAction({
      store, caseId: body.actions[0].value, client, body, config, logger,
      handler: async (caseRecord) => {
    const schedule = caseRecord.currentSchedule || {};
    const eventLink = caseRecord.calendarEventHtmlLink || schedule.htmlLink || calendarEventUrl(caseRecord.calendarEventId) || null;
    if (isCustomInviteCase(caseRecord)) {
      const customInvite = normalizeCustomInviteMetadata(caseRecord)
      const lines = [
        eventLink
          ? `*Calendar:* <${eventLink}|Open in Google Calendar>`
          : (caseRecord.calendarEventId ? 'Calendar event created' : '*Calendar:* not created yet'),
        `*Date:* ${schedule.date || 'TBD'}`,
        `*Time:* ${schedule.time || 'TBD'}`,
        `*Meeting link:* ${schedule.zoomLink || customInvite.meetingLink || 'None'}`,
      ]
      await client.chat.postEphemeral({
        channel: resolvePostingChannel(config, body.channel?.id || body.user.id),
        user: body.user.id,
        text: lines.join('\n'),
      })
      return
    }

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
      },
    })
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

  const result = await postSharedActionMessage({
    client,
    channel,
    actorSlackUserId: body.user?.id || body.user_id || '',
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

async function postSharedActionMessage({
  client,
  channel,
  actorSlackUserId = '',
  text = '',
  blocks,
  ...rest
}) {
  const payload = sharedActionMessagePayload({
    channel,
    actorSlackUserId,
    text,
    blocks,
  })
  return client.chat.postMessage({
    channel,
    ...payload,
    ...rest,
  })
}

function sharedActionMessagePayload({ channel, actorSlackUserId = '', text = '', blocks }) {
  const mention = slackUserMention(actorSlackUserId)
  if (!mention || isDirectSlackTarget(channel, actorSlackUserId)) {
    return blocks ? { text, blocks } : { text }
  }

  return {
    text: prefixSlackMention(text, mention),
    ...(blocks ? { blocks: actorMentionBlocks(blocks, mention) } : {}),
  }
}

function actorMentionBlocks(blocks, mention) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Action by ${mention}`,
      },
    },
    ...blocks,
  ]
}

function prefixSlackMention(text, mention) {
  const value = String(text || '').trim()
  if (!value) return mention
  return value.includes(mention) ? value : `${mention} ${value}`
}

function slackUserMention(userId) {
  const value = String(userId || '').trim()
  return /^U[A-Z0-9]+$/i.test(value) ? `<@${value}>` : ''
}

function isDirectSlackTarget(channel, actorSlackUserId = '') {
  const value = String(channel || '')
  return /^D[A-Z0-9]+$/i.test(value) || (actorSlackUserId && value === actorSlackUserId)
}

async function openIntakeModal({
  client,
  triggerId,
  config,
  logger,
  privateMetadata = '',
  timeZones = [],
  defaultTimeZone,
  userId = '',
}) {
  const templates = await loadIntakeTemplates();
  ensureSlackDirectory({ client, config, logger }).catch((error) => {
    logger.warn('slack_directory_background_failed', slackApiErrorDetails(error))
  })
  const meta = JSON.stringify({ channelId: privateMetadata, showDetails: false, manualCandidateMode: false });
  logger.info('schedule_intake_opened', { templateCount: templates.length });
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        ...intakeModal({ templates, timeZones, defaultTimeZone, recruiters: getTalentRecruiters(), roles: getOpenRoles() }),
        private_metadata: meta,
      },
    })
  } catch (error) {
    if (error.data?.error === 'expired_trigger_id') {
      logger.warn('schedule_intake_trigger_expired', {
        hint: 'Event loop lag caused trigger_id to expire before modal could open',
      })
      if (privateMetadata && userId) {
        await client.chat.postEphemeral({
          channel: privateMetadata,
          user: userId,
          text: 'Sorry, the form took too long to open. Please click "Start scheduling" again.',
        })
      }
      return
    }
    throw error
  }
}

export function buildEditCaseDraft(caseRecord, templates) {
  if (isCustomInviteCase(caseRecord)) {
    const customInvite = normalizeCustomInviteMetadata(caseRecord)
    const allRecruiters = [
      ...getSlackRecruiters(),
      ...getTalentRecruiters(),
      ...getSlackUsers(),
    ]
    const recruitmentUsersById = new Map()
    const recruitmentUsersByEmail = new Map()
    for (const user of allRecruiters) {
      if (user.slackUserId) recruitmentUsersById.set(user.slackUserId, user)
      if (user.id) recruitmentUsersById.set(user.id, user)
      if (user.email) recruitmentUsersByEmail.set(normalizeEmail(user.email), user)
    }
    const customInviteSlackRecipients = customInvite.recipients
      .map((recipient) =>
        recruitmentUsersById.get(recipient.slackUserId) ||
        recruitmentUsersByEmail.get(normalizeEmail(recipient.email))
      )
      .filter(Boolean)
    return buildIntakeDraft({}, templates, {
      editCaseId: caseRecord.id,
      eventType: 'custom-invite',
      customInviteTitle: customInvite.title,
      customInviteTemplateId: customInvite.templateId || CUSTOM_INVITE_MANUAL_TEMPLATE_ID,
      customInviteSlackRecipientIds: customInviteSlackRecipients
        .map((recipient) => recipient.slackUserId || recipient.id),
      customInviteSlackRecipients,
      customInviteRecipientsRaw: customInvite.recipients
        .filter((recipient) => !recipient.slackUserId)
        .map((recipient) => recipient.name
          ? `${recipient.name} - ${recipient.email}`
          : recipient.email)
        .join('\n'),
      customInviteSubject: customInvite.subject,
      customInviteBody: customInvite.body,
      customInviteMeetingLink: customInvite.meetingLink,
      notes: caseRecord.notes || '',
      interviewTimezone: caseRecord.interviewTimezone || '',
    })
  }

  const additional = Array.isArray(caseRecord.externalAttendees) ? caseRecord.externalAttendees : []
  const recruiterIds = normalizeIdList([
    caseRecord.recruiter?.id,
    ...additional.filter((person) => person?.role === 'recruiter').map((person) => person.id),
  ])
  const hiringManagerIds = normalizeIdList([
    caseRecord.hiringManager?.id,
    ...additional.filter((person) => person?.role === 'hiring_manager').map((person) => person.id),
  ])
  const eventType = caseRecord.eventType || caseRecord.autofill?.eventType || eventTypeForStageKey(caseRecord.stageKey)
  return buildIntakeDraft({}, templates, {
    editCaseId: caseRecord.id,
    eventType,
    roleId: caseRecord.autofill?.roleId || '',
    roleTitle: caseRecord.autofill?.roleTitle || caseRecord.applicant?.jobTitle || '',
    applicant: caseRecord.applicant?.id || '',
    applicantRecord: caseRecord.applicant,
    recruiterIds,
    hiringManagerIds,
    recruiterPerson: caseRecord.recruiter,
    recruiterName: caseRecord.recruiter?.name || '',
    recruiterEmail: caseRecord.recruiter?.email || '',
    hiringManagerPerson: caseRecord.hiringManager,
    hiringManagerName: caseRecord.hiringManager?.name || '',
    hiringManagerEmail: caseRecord.hiringManager?.email || '',
    notes: caseRecord.notes || '',
    resumeLink: caseRecord.resumeLink || '',
    resumeFile: caseRecord.resumeFile || null,
    zoomLink: caseRecord.autofill?.zoomLink || '',
    zoomLinkRevision: 0,
    interviewTimezone: caseRecord.interviewTimezone || '',
  })
}

async function updateCaseSlackMessage({ client, caseRecord }) {
  const channel = caseRecord.autofill?.caseMessageChannel
  const ts = caseRecord.autofill?.caseMessageTs
  if (!channel || !ts) return
  await client.chat.update({
    channel,
    ts,
    text: 'Scheduling case updated',
    blocks: caseMessageBlocks(caseRecord),
  })
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
  const eventType = 'eventType' in overrides ? overrides.eventType : parsed.eventType || ''
  const editCaseId = 'editCaseId' in overrides ? overrides.editCaseId : parsed.editCaseId || ''
  const customInviteSlackRecipientIds = 'customInviteSlackRecipientIds' in overrides
    ? overrides.customInviteSlackRecipientIds
    : parsed.customInviteSlackRecipientIds || []
  const customInviteTemplateId = 'customInviteTemplateId' in overrides
    ? overrides.customInviteTemplateId
    : parsed.customInviteTemplateId || ''
  const roleId = 'roleId' in overrides ? overrides.roleId : parsed.roleId || ''
  const roleTitle = 'roleTitle' in overrides ? overrides.roleTitle : parsed.roleTitle || ''
  const recruiterIds = 'recruiterIds' in overrides ? overrides.recruiterIds : parsed.recruiterIds || []
  const hiringManagerIds = 'hiringManagerIds' in overrides ? overrides.hiringManagerIds : parsed.hiringManagerIds || []
  const recruiterSearchQuery = 'recruiterSearchQuery' in overrides
    ? overrides.recruiterSearchQuery
    : parsed.recruiterSearchQuery || ''
  const hiringManagerSearchQuery = 'hiringManagerSearchQuery' in overrides
    ? overrides.hiringManagerSearchQuery
    : parsed.hiringManagerSearchQuery || ''
  const showAdditionalRecruiters = 'showAdditionalRecruiters' in overrides
    ? Boolean(overrides.showAdditionalRecruiters)
    : Boolean(parsed.showAdditionalRecruiters)
  const showAdditionalHiringManagers = 'showAdditionalHiringManagers' in overrides
    ? Boolean(overrides.showAdditionalHiringManagers)
    : Boolean(parsed.showAdditionalHiringManagers)
  const zoomLink = 'zoomLink' in overrides ? overrides.zoomLink : parsed.zoomLink || ''
  const zoomLinkAuto = 'zoomLinkAuto' in overrides ? Boolean(overrides.zoomLinkAuto) : Boolean(parsed.zoomLinkAuto)
  const zoomLinkRevision = 'zoomLinkRevision' in overrides
    ? Number(overrides.zoomLinkRevision || 0)
    : Number(parsed.zoomLinkRevision || 0)
  const resumeLink = 'resumeLink' in overrides ? overrides.resumeLink : parsed.resumeLink || ''
  const resumeFile = 'resumeFile' in overrides ? overrides.resumeFile : parsed.resumeFile || null
  const customInvitePurpose = 'customInvitePurpose' in overrides
    ? overrides.customInvitePurpose
    : parsed.customInvitePurpose || ''
  const remoteUpdateStatus = 'remoteUpdateStatus' in overrides
    ? overrides.remoteUpdateStatus
    : parsed.remoteUpdateStatus || ''
  const remoteUpdateMessage = 'remoteUpdateMessage' in overrides
    ? overrides.remoteUpdateMessage
    : parsed.remoteUpdateMessage || ''
  return JSON.stringify({
    channelId,
    showDetails,
    manualCandidateMode,
    eventType,
    editCaseId,
    customInviteSlackRecipientIds,
    customInviteTemplateId,
    roleId,
    roleTitle,
    recruiterIds,
    hiringManagerIds,
    recruiterSearchQuery,
    hiringManagerSearchQuery,
    showAdditionalRecruiters,
    showAdditionalHiringManagers,
    zoomLink,
    zoomLinkAuto,
    zoomLinkRevision,
    resumeLink,
    resumeFile,
    customInvitePurpose,
    remoteUpdateStatus,
    remoteUpdateMessage,
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
  draftOverrides = {},
}) {
  if (!body.view?.id || !body.view?.hash) return;
  const overrides = selectedKey ? { [selectedKey]: selectedId } : {}
  Object.assign(overrides, draftOverrides)
  const metadata = parsePrivateMetadata(body.view.private_metadata) || {}
  overrides.manualCandidateMode = manualCandidateMode !== undefined
    ? Boolean(manualCandidateMode)
    : Boolean(metadata.manualCandidateMode)
  if (candidateSearchQuery === undefined && metadata.candidateSearchQuery && !('candidateSearchQuery' in overrides)) {
    overrides.candidateSearchQuery = metadata.candidateSearchQuery
    overrides.candidateSearchSessionId = metadata.candidateSearchSessionId || ''
    overrides.candidateSearchPage = metadata.candidateSearchPage || 0
    overrides.candidateSearchResultCount = metadata.candidateSearchResultCount || 0
    overrides.candidateSearchPageSize = metadata.candidateSearchPageSize || 20
    overrides.candidateSearchComplete = metadata.candidateSearchComplete || false
    overrides.candidateSearchSearching = metadata.candidateSearchSearching || false
    overrides.candidateSearchError = metadata.candidateSearchError || ''
  }
  for (const key of [
    'eventType',
    'editCaseId',
    'customInviteSlackRecipientIds',
    'customInviteTemplateId',
    'roleId',
    'roleTitle',
    'recruiterIds',
    'hiringManagerIds',
    'recruiterSearchQuery',
    'hiringManagerSearchQuery',
    'showAdditionalRecruiters',
    'showAdditionalHiringManagers',
    'zoomLink',
    'zoomLinkAuto',
    'zoomLinkRevision',
    'resumeLink',
    'resumeFile',
    'customInvitePurpose',
    'remoteUpdateStatus',
    'remoteUpdateMessage',
  ]) {
    if (!(key in overrides) && key in metadata) overrides[key] = metadata[key]
  }
  const stateValues = body.view?.state?.values
  if (!('zoomLink' in draftOverrides)) {
    if (hasInputElement(stateValues, 'zoom_link')) {
      overrides.zoomLink = getInputValue(stateValues, 'zoom_link')
    } else if ('zoomLink' in metadata) {
      overrides.zoomLink = metadata.zoomLink
    }
  }
  const uploadedResumeFile = extractResumeFile(stateValues)
  if (uploadedResumeFile) {
    overrides.resumeFile = uploadedResumeFile
    overrides.resumeLink = resumeFileReference(uploadedResumeFile)
  } else {
    if (!('resumeLink' in overrides) && metadata.resumeLink) overrides.resumeLink = metadata.resumeLink
    if (!('resumeFile' in overrides) && metadata.resumeFile) overrides.resumeFile = metadata.resumeFile
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
    eventType: draft.eventType,
    editCaseId: draft.editCaseId,
    customInviteSlackRecipientIds: draft.customInviteSlackRecipientIds,
    customInviteTemplateId: draft.customInviteTemplateId,
    roleId: draft.roleId,
    roleTitle: draft.roleTitle,
    recruiterIds: draft.recruiterIds,
    hiringManagerIds: draft.hiringManagerIds,
    recruiterSearchQuery: draft.recruiterSearchQuery,
    hiringManagerSearchQuery: draft.hiringManagerSearchQuery,
    showAdditionalRecruiters: draft.showAdditionalRecruiters,
    showAdditionalHiringManagers: draft.showAdditionalHiringManagers,
    zoomLink: draft.zoomLink,
    zoomLinkAuto: draft.zoomLinkAuto,
    zoomLinkRevision: draft.zoomLinkRevision,
    resumeLink: draft.resumeLink,
    resumeFile: draft.resumeFile,
    remoteUpdateStatus: draft.remoteUpdateStatus,
    remoteUpdateMessage: draft.remoteUpdateMessage,
  });

  return client.views.update({
    view_id: body.view.id,
    ...(useHash ? { hash: body.view.hash } : {}),
    view: {
      ...intakeModal({ templates, draft, timeZones, defaultTimeZone, recruiters: getTalentRecruiters(), roles: getOpenRoles() }),
      private_metadata: privateMetadata,
    },
  });
}

async function refreshIntakeModalAfterAsync(options) {
  try {
    return await refreshIntakeModal(options)
  } catch (error) {
    const latestView = error?.data?.error === 'hash_conflict' ? error.data.view : null
    if (!latestView?.id || !latestView?.hash) throw error

    options.logger?.info('intake_modal_hash_conflict_recovered', {
      viewId: latestView.id,
    })
    return refreshIntakeModal({
      ...options,
      body: {
        ...options.body,
        view: latestView,
      },
    })
  }
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
  filters = {},
  logger = console,
} = {}) {
  const session = liveCandidateSearch?.get?.(sessionId)
  if (session) return session

  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) return null

  const restarted = liveCandidateSearch?.start?.({ query: normalizedQuery, userId, filters })
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

class CaseNotFoundError extends Error {
  constructor(caseId) {
    super(`Case not found: ${caseId}`)
    this.name = 'CaseNotFoundError'
    this.caseId = caseId
  }
}

async function requireCase(store, caseId) {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new CaseNotFoundError(caseId);
  return caseRecord;
}

async function notifyCaseNotFound({ caseId, client, body, config, logger }) {
  logger.warn('case_not_found_stale_interaction', { caseId, action: body?.actions?.[0]?.action_id })
  try {
    await client.chat.postEphemeral({
      channel: resolvePostingChannel(config, body.user?.id || body.channel?.id),
      user: body.user?.id,
      text: 'This case is no longer available. It may have been deleted or completed. Please start a new request.',
    })
  } catch (_) { /* best effort */ }
}

async function guardCaseAction({ store, caseId, client, body, config, logger, handler }) {
  try {
    const caseRecord = await requireCase(store, caseId)
    return await handler(caseRecord)
  } catch (error) {
    if (error instanceof CaseNotFoundError) {
      await notifyCaseNotFound({ caseId, client, body, config, logger })
      return
    }
    throw error
  }
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

export function emailBodiesFromPreview(renderedEmail, submittedPlainBody) {
  const submitted = normalizePreviewText(submittedPlainBody)
  const renderedPlain = normalizePreviewText(renderedEmail?.plainBody)
  if (submitted === renderedPlain && (renderedEmail?.htmlBody || renderedEmail?.body)) {
    return {
      htmlBody: renderedEmail.htmlBody || renderedEmail.body,
      plainBody: renderedEmail.plainBody,
    }
  }
  return signedEmailBodiesFromPlainText(submittedPlainBody)
}

function normalizePreviewText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim()
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

const customInviteDeliveryLocks = new Map()

export async function deliverCustomInviteEmails(args) {
  const caseId = args.caseRecord.id
  const existing = customInviteDeliveryLocks.get(caseId)
  if (existing) return existing

  const delivery = deliverCustomInviteEmailsUnlocked(args)
    .finally(() => customInviteDeliveryLocks.delete(caseId))
  customInviteDeliveryLocks.set(caseId, delivery)
  return delivery
}

async function deliverCustomInviteEmailsUnlocked({ config, logger, store, caseRecord }) {
  const results = []
  const caseId = caseRecord.id

  for (const recipient of normalizeCustomInviteMetadata(caseRecord).recipients) {
    const latest = await store.getCase(caseId)
    const customInvite = normalizeCustomInviteMetadata(latest || caseRecord)
    const existingStatus = customInvite.deliveryStatus[recipient.email]?.status
    if (existingStatus === 'sending' || isFinalCustomInviteDeliveryStatus(existingStatus)) {
      results.push({ email: recipient.email, status: 'skipped' })
      continue
    }

    const sendingAt = new Date().toISOString()
    const sendingMetadata = {
      ...customInvite,
      deliveryStatus: {
        ...customInvite.deliveryStatus,
        [recipient.email]: {
          status: 'sending',
          updatedAt: sendingAt,
        },
      },
    }
    const pendingCase = await store.updateCase(caseId, { customInvite: sendingMetadata })
    const email = buildCustomInviteEmail(pendingCase, recipient)

    try {
      const sendResult = await sendRecruiterEmail({
        config,
        logger,
        store,
        caseRecord: pendingCase,
        email,
      })
      const status = sendResult.mocked ? 'mocked' : 'sent'
      const completedMetadata = {
        ...sendingMetadata,
        deliveryStatus: {
          ...sendingMetadata.deliveryStatus,
          [recipient.email]: {
            status,
            messageId: sendResult.messageId || '',
            email: {
              to: email.to,
              subject: email.subject,
              plainBody: email.plainBody,
            },
            updatedAt: new Date().toISOString(),
          },
        },
      }
      await store.updateCase(caseId, { customInvite: completedMetadata })
      results.push({ email: recipient.email, status, email, sendResult })
    } catch (error) {
      const failedMetadata = {
        ...sendingMetadata,
        deliveryStatus: {
          ...sendingMetadata.deliveryStatus,
          [recipient.email]: {
            status: 'failed',
            error: error.message,
            updatedAt: new Date().toISOString(),
          },
        },
      }
      await store.updateCase(caseId, { customInvite: failedMetadata })
      logger.error('custom_invite_email_failed', {
        caseId,
        recipientEmail: recipient.email,
        error: error.message,
      })
      results.push({ email: recipient.email, status: 'failed', error: error.message })
    }
  }

  return results
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
  const resumeLink = caseRecord.resumeLink ? resumeHtmlLink(caseRecord) : '';
  const resumePlain = caseRecord.resumeLink ? resumePlainLink(caseRecord) : '';

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
    resume_link_plain: resumePlain,
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
  const editCaseId = overrides.editCaseId || ''
  const selectedEventType = overrides.eventType ?? (values.event_type_block?.event_type_select?.selected_option?.value || '')
  const eventType = selectedEventType || ''
  const standardEventType = isStandardIntakeEvent(eventType)
  const roleId = overrides.roleId ?? (values.role_block?.role_select?.selected_option?.value || '')
  const role = roleById(roleId)
  const roleTitle = overrides.roleTitleInput ?? (
    getInputValue(values, 'role_title_override') ||
    overrides.roleTitle ||
    role?.title ||
    ''
  )
  const customInvite = eventType === 'custom-invite'
  if (customInvite) {
    const customInviteSlackRecipientIds = normalizeIdList(
      overrides.customInviteSlackRecipientIds ??
      getSelectedOptionValues(values, 'custom_slack_recipients')
    )
    const customInviteSlackRecipients = (overrides.customInviteSlackRecipients ||
      customInviteSlackRecipientIds
        .map((id) => {
          return getSlackRecruiters().find((p) => p.id === id || p.slackUserId === id)
            || getTalentRecruiters().find((p) => p.id === id)
            || getSlackUsers().find((p) => p.id === id || p.slackUserId === id)
        })
    )
      .filter((person) => person?.email)
      .map((person) => ({
        id: person.id || person.slackUserId,
        name: person.name || '',
        email: normalizeEmail(person.email),
        slackUserId: person.slackUserId || person.id,
      }))
    const customInviteTitle = overrides.customInviteTitle !== undefined
      ? overrides.customInviteTitle
      : getInputValue(values, 'custom_title')
    const customInviteTemplateId = String(
      overrides.customInviteTemplateId ??
      getSelectedOptionValues(values, 'custom_email_template_select')[0] ??
      CUSTOM_INVITE_TEMPLATE_IDS[0]
    ).trim() || CUSTOM_INVITE_TEMPLATE_IDS[0]
    const selectedCustomInviteTemplate = templates.find(
      (template) => template.id === customInviteTemplateId,
    )
    const customInviteRecipientsRaw = overrides.customInviteRecipientsRaw !== undefined
      ? overrides.customInviteRecipientsRaw
      : getInputValue(values, 'custom_external_guests')
    const customInviteSubject = overrides.customInviteSubject !== undefined
      ? overrides.customInviteSubject
      : hasInputElement(values, 'custom_subject')
        ? getInputValue(values, 'custom_subject')
        : selectedCustomInviteTemplate?.subject || ''
    const customInviteBody = overrides.customInviteBody !== undefined
      ? overrides.customInviteBody
      : hasInputElement(values, 'custom_body')
        ? getInputValue(values, 'custom_body')
        : selectedCustomInviteTemplate?.body || ''
    const customInviteMeetingLink = overrides.customInviteMeetingLink !== undefined
      ? overrides.customInviteMeetingLink
      : getInputValue(values, 'custom_meeting_link')
    const interviewTimezone = overrides.interviewTimezone ??
      (values.timezone_block?.timezone_select?.selected_option?.value || '')
    let customInviteExternalRecipients = []
    let customInviteRecipientError = ''
    if (String(customInviteRecipientsRaw || '').trim()) {
      try {
        customInviteExternalRecipients = parseCustomInviteRecipients(customInviteRecipientsRaw)
      } catch (error) {
        customInviteRecipientError = error.message
      }
    }
    const customInviteRecipients = mergeCustomInviteRecipients(
      customInviteSlackRecipients,
      customInviteExternalRecipients,
    )

    return {
      editCaseId,
      eventType,
      eventTypeOption: toSlackOption(eventTypeLabel(eventType), eventType),
      standardEventType: false,
      customInviteTitle,
      customInviteTemplateId,
      customInviteTemplateOption: toSlackOption(
        selectedCustomInviteTemplate?.label ||
          (customInviteTemplateId === CUSTOM_INVITE_MANUAL_TEMPLATE_ID ? 'Custom' : customInviteTemplateId),
        customInviteTemplateId,
      ),
      customInviteTemplateOptions: [
        ...templates
          .filter((template) => CUSTOM_INVITE_TEMPLATE_IDS.includes(template.id))
          .map((template) => toSlackOption(template.label, template.id)),
        toSlackOption('Custom', CUSTOM_INVITE_MANUAL_TEMPLATE_ID),
      ],
      customInviteSlackRecipientIds,
      customInviteSlackRecipients,
      customInviteRecipientsRaw,
      customInviteRecipients,
      customInviteRecipientError,
      customInviteSubject,
      customInviteBody,
      customInviteMeetingLink,
      notes: overrides.notes !== undefined ? overrides.notes : getInputValue(values, 'notes'),
      interviewTimezone,
      applicant: null,
      recruiter: null,
      hiringManager: null,
      applicantId: '',
      recruiterId: '',
      hiringManagerId: '',
      recruiterIds: [],
      hiringManagerIds: [],
      templateId: null,
      stageKey: null,
      resumeLink: '',
      zoomLink: customInviteMeetingLink,
      extraAttendees: customInviteExternalAttendees(customInviteRecipients),
      remoteUpdateStatus: '',
      remoteUpdateMessage: '',
    }
  }
  const customInvitePurpose = customInvite
    ? (overrides.customInvitePurpose !== undefined ? overrides.customInvitePurpose : getInputValue(values, 'custom_purpose'))
    : ''
  const applicantId = overrides.applicant ?? (getSelectedOptionValues(values, 'applicant_select')[0] || '');
  const manualCandidateMode = customInvite && (overrides.manualCandidateMode !== undefined
    ? Boolean(overrides.manualCandidateMode)
    : (isCheckboxSelected(values, 'manual_candidate_toggle', 'manual') ||
      (!values.applicant_block && hasInputElement(values, 'manual_applicant_name'))
      ))
  const manualApplicantName = manualCandidateMode
    ? (overrides.manualApplicantName !== undefined ? overrides.manualApplicantName : getInputValue(values, 'manual_applicant_name'))
    : ''
  const manualApplicantRole = manualCandidateMode
    ? (overrides.manualApplicantRole !== undefined ? overrides.manualApplicantRole : getInputValue(values, 'manual_applicant_role'))
    : ''
  const applicantEmailOverride =
    overrides.applicantEmail !== undefined ? overrides.applicantEmail : getInputValue(values, 'applicant_email')
  const applicantNameOverride =
    overrides.applicantName !== undefined ? overrides.applicantName : getInputValue(values, 'applicant_name_override')
  const applicantPhoneOverride =
    overrides.applicantPhone !== undefined ? overrides.applicantPhone : getInputValue(values, 'applicant_phone_override')
  const candidateSearchQuery = overrides.candidateSearchQuery ?? getInputValue(values, 'candidate_search')
  const candidateSearchPage = Number(overrides.candidateSearchPage || 0)
  const selectedStageKey = overrides.stageKey ?? (values.stage_block?.stage_select?.selected_option?.value || '');
  const legacyTemplateId = overrides.templateId ?? (values.template_block?.template_select?.selected_option?.value || '');
  const stageKey = normalizeStageKey(customInvite
    ? (selectedStageKey || resolveStageFromTemplate(legacyTemplateId) || '1st-interview')
    : (stageKeyForEventType(eventType) || selectedStageKey || resolveStageFromTemplate(legacyTemplateId)));
  const templateId = resolveTemplateFromStage(stageKey) || legacyTemplateId;
  const interviewTimezone = overrides.interviewTimezone ?? (values.timezone_block?.timezone_select?.selected_option?.value || '');

  const applicant = manualCandidateMode
    ? applyEmailOverride(
        buildManualApplicant(manualApplicantName, applicantEmailOverride, manualApplicantRole),
        applicantEmailOverride,
      )
    : applyApplicantOverrides(
        overrides.applicantRecord || findApplicant(applicantId),
        {
          name: applicantNameOverride,
          email: applicantEmailOverride,
          phone: applicantPhoneOverride,
          jobTitle: roleTitle,
        },
      );
  const requiresHiringManager = stageRequiresHiringManager(stageKey)
  const rawStandardRecruiterIds = normalizeIdList(overrides.recruiterIds ?? [
    ...getSelectedOptionValues(values, 'recruiter_checkboxes'),
    ...getSelectedOptionValues(values, 'recruiter_select'),
    ...getSelectedOptionValues(values, 'additional_recruiter_select'),
  ])
  const jobOfferRecruiterIds = eventType === 'job-offer'
    ? mappedRecruitersForRole(roleId).map((person) => person.id).slice(0, 10)
    : []
  const recruiterIds = standardEventType
    ? normalizeIdList(
        jobOfferRecruiterIds.length > 0
          ? jobOfferRecruiterIds
          : (rawStandardRecruiterIds.length > 0 ? rawStandardRecruiterIds : [applicant?.recruiterId])
      )
    : normalizeIdList([overrides.recruiter ?? (values.recruiter_block?.recruiter_select?.selected_option?.value || '')])
  const standardHiringManagersAllowed = standardEventType &&
    (eventType === '2nd-interview' || eventType === 'final-interview')
  const hiringManagerIds = standardHiringManagersAllowed
    ? normalizeIdList(overrides.hiringManagerIds ?? [
        ...getSelectedOptionValues(values, 'hiring_manager_checkboxes'),
        ...getSelectedOptionValues(values, 'hm_select'),
        ...getSelectedOptionValues(values, 'additional_hm_select'),
      ])
    : normalizeIdList(requiresHiringManager ? [overrides.hiringManager ?? (values.hm_block?.hm_select?.selected_option?.value || applicant?.hiringManagerId || '')] : [])
  const selectedRecruiterId = recruiterIds[0] || '';
  const recruiterId = selectedRecruiterId || applicant?.recruiterId || '';
  const hiringManagerId = hiringManagerIds[0] || ''
  const selectedRecruiter = overrides.recruiterPerson || findMappedPersonById(recruiterId)
  const recruiter = selectedRecruiter ? asRecruiter(selectedRecruiter) : null
  const baseHiringManager = requiresHiringManager
    ? asHiringManager(overrides.hiringManagerPerson || findMappedPersonById(hiringManagerId))
    : null
  const hiringManagerNeedsEmail = Boolean(baseHiringManager && !isValidEmail(baseHiringManager.email))
  const hiringManagerEmailOverride = String(
    overrides.hiringManagerEmailOverride !== undefined
      ? overrides.hiringManagerEmailOverride
      : getInputValue(values, 'hiring_manager_email_override') || '',
  ).trim()
  const hiringManager = baseHiringManager && hiringManagerNeedsEmail
    ? { ...baseHiringManager, email: hiringManagerEmailOverride }
    : baseHiringManager
  const selectedRecruiters = standardEventType ? recruiterIds.map(findMappedPersonById).filter(Boolean).map(asRecruiter) : (recruiter ? [recruiter] : [])
  const selectedHiringManagers = standardHiringManagersAllowed ? hiringManagerIds.map(findMappedPersonById).filter(Boolean).map(asHiringManager) : (hiringManager ? [hiringManager] : [])
  const suggestedHiringManagers = standardHiringManagersAllowed
    ? mappedHiringManagersForRole(roleId)
    : []
  const availableRecruiters = standardEventType
    ? mappedRecruitersForRole(roleId)
    : getTalentRecruiters()
  const availableHiringManagers = standardHiringManagersAllowed
    ? selectableHiringManagersForRole(roleId)
    : []
  const template = templates.find((item) => item.id === templateId);
  const stageOption = stageKey
    ? toSlackOption(stageLabel(stageKey), stageKey)
    : undefined;
  const eventTypeOption = eventType ? toSlackOption(eventTypeLabel(eventType), eventType) : undefined
  const roleOption = role ? toSlackOption(role.title, canonicalRoleId(role)) : undefined
  const zoomLink = overrides.zoomLink !== undefined ? overrides.zoomLink : getInputValue(values, 'zoom_link')
  const zoomLinkAuto = Boolean(overrides.zoomLinkAuto)
  const zoomLinkRevision = Number(overrides.zoomLinkRevision || 0)
  const resumeFile = overrides.resumeFile !== undefined ? overrides.resumeFile : extractResumeFile(values)
  const resumeLink = overrides.resumeLink !== undefined
    ? overrides.resumeLink
    : (resumeFile ? resumeFileReference(resumeFile) : extractResumeFileReference(values))
  const zoomLinkRecruiter = zoomLink
    ? selectedRecruiters.find((person) => String(person?.zoomLink || '').trim() === zoomLink)
    : null
  const showAdditionalRecruiters = overrides.showAdditionalRecruiters !== undefined
    ? Boolean(overrides.showAdditionalRecruiters)
    : hasInputElement(values, 'additional_recruiter_select')
  const showAdditionalHiringManagers = overrides.showAdditionalHiringManagers !== undefined
    ? Boolean(overrides.showAdditionalHiringManagers)
    : hasInputElement(values, 'additional_hm_select')

  return {
    editCaseId,
    eventType,
    eventTypeOption,
    standardEventType,
    roleId,
    roleTitle,
    role,
    roleOption,
    applicantId,
    recruiterId,
    hiringManagerId,
    recruiterIds,
    hiringManagerIds,
    templateId,
    stageKey,
    applicant,
    recruiter,
    hiringManager,
    applicantOption: applicant ? toSlackOption(applicantPickerLabel(applicant), applicant.id) : undefined,
    recruiterOption: recruiter ? compactPersonOption(recruiter) : undefined,
    hiringManagerOption: hiringManager ? compactPersonOption(hiringManager) : undefined,
    recruiterOptions: selectedRecruiters.map(compactPersonOption),
    hiringManagerOptions: selectedHiringManagers.map(compactPersonOption),
    additionalRecruiterOptions: selectedRecruiters.slice(1).map(compactPersonOption),
    additionalHiringManagerOptions: selectedHiringManagers.slice(1).map(compactPersonOption),
    showAdditionalRecruiters,
    showAdditionalHiringManagers,
    selectedRecruiters,
    selectedHiringManagers,
    availableRecruiters,
    availableHiringManagers,
    suggestedHiringManagers,
    recruiterSearchQuery: overrides.recruiterSearchQuery || '',
    hiringManagerSearchQuery: overrides.hiringManagerSearchQuery || '',
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
    customInvitePurpose,
    manualApplicantName,
    manualApplicantRole,
    applicantName: applicant ? [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') : '',
    applicantEmail: applicant?.email || '',
    applicantPhone: applicant?.phone || '',
    recruiterName: recruiter?.name || '',
    recruiterEmail: recruiter?.email || '',
    hiringManagerName: hiringManager?.name || '',
    hiringManagerEmail: hiringManager?.email || '',
    hiringManagerNeedsEmail,
    hiringManagerEmailOverride,
    notes: overrides.notes !== undefined ? overrides.notes : getInputValue(values, 'notes'),
    resumeLink,
    resumeFile,
    zoomLink,
    zoomLinkAuto,
    zoomLinkRevision,
    remoteUpdateStatus: overrides.remoteUpdateStatus || '',
    remoteUpdateMessage: overrides.remoteUpdateMessage || '',
    zoomLinkOption: zoomLinkRecruiter ? zoomLinkOption(zoomLinkRecruiter) : undefined,
    extraAttendees: buildExtraIntakeAttendees(selectedRecruiters, selectedHiringManagers, { includePrimaryHiringManager: !requiresHiringManager }),
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

function getSelectedOptionValues(values, actionId) {
  return getSelectedOptions(values, actionId).map((option) => option.value).filter(Boolean)
}

function getSelectedOptions(values, actionId) {
  for (const block of Object.values(values || {})) {
    const element = findElementByActionId(block, actionId)
    if (Array.isArray(element?.selected_options)) {
      return element.selected_options.filter((option) => option?.value)
    }
    if (element?.selected_option?.value) return [element.selected_option]
  }
  return []
}

function slackRecipientFromSelectedOption(option) {
  const slackUserId = String(option?.value || '').trim()
  const label = String(option?.text?.text || '').trim()
  const description = String(option?.description?.text || '').trim()
  const candidates = [
    label,
    description ? `${label} - ${description}` : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      const [recipient] = parseCustomInviteRecipients(candidate)
      if (recipient?.email) {
        return {
          id: slackUserId,
          slackUserId,
          name: recipient.name || label.replace(/\s+-\s+[^\s]+@[^\s]+$/, '').trim(),
          email: recipient.email,
          role: 'slack_user',
        }
      }
    } catch {
      // Try the next representation.
    }
  }

  return null
}

function normalizeIdList(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim()).filter(Boolean))]
}

export function orderedCheckboxSelection(previousIds = [], selectedIds = []) {
  const previous = normalizeIdList(previousIds)
  const selected = normalizeIdList(selectedIds)
  const selectedSet = new Set(selected)
  const previousSet = new Set(previous)
  const newlySelected = selected.filter((id) => !previousSet.has(id))
  return [
    ...newlySelected,
    ...previous.filter((id) => selectedSet.has(id)),
  ]
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

function hasCheckboxSelection(values, actionId) {
  for (const block of Object.values(values || {})) {
    const element = findElementByActionId(block, actionId)
    if (element && 'selected_options' in element) return true
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

function selectedOptionValues(body) {
  const selected = body.actions?.[0]?.selected_options
  if (Array.isArray(selected)) return selected.map((option) => option.value).filter(Boolean)
  const value = selectedOptionValue(body)
  return value ? [value] : []
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

async function searchCandidateIndex(store, query, baseQuery = '', limit = 20, filters = {}) {
  if (!store?.searchJazzhrCandidates) return []
  return store.searchJazzhrCandidates(query, { baseQuery, limit, ...filters })
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

function compactPersonOptions(query, people = []) {
  const normalized = String(query || '').trim().toLowerCase()
  return (people || [])
    .filter((person) => !normalized || [person.name, person.email].join(' ').toLowerCase().includes(normalized))
    .slice(0, 100)
    .map(compactPersonOption)
}

function compactPersonOption(person) {
  return {
    text: {
      type: 'plain_text',
      text: String(person?.name || person?.email || 'Unknown').slice(0, 75),
    },
    value: person.id,
    ...(person?.email ? {
      description: {
        type: 'plain_text',
        text: String(person.email).slice(0, 75),
      },
    } : {}),
  }
}

function zoomLinkOption(recruiter) {
  const link = String(recruiter?.zoomLink || '').trim()
  if (!link) return undefined
  return {
    text: {
      type: 'plain_text',
      text: String(recruiter?.name || link || 'Zoom link').slice(0, 75),
    },
    value: link,
    ...(recruiter?.email ? {
      description: {
        type: 'plain_text',
        text: String(recruiter.email).slice(0, 75),
      },
    } : {}),
  }
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
    workflowStepId: candidate.workflowStepId || '',
    workflowStep: candidate.workflowStep || '',
    workflowCategory: candidate.workflowCategory || '',
    jobStatus: candidate.jobStatus || '',
    hiringManagerId: '',
    recruiterId: candidate.recruiterId || '',
    recruiterEmail: candidate.recruiterEmail || '',
    recruiterName: candidate.recruiterName || '',
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
    workflowStepId: detail.workflowStepId || applicant.workflowStepId || '',
    workflowStep: detail.workflowStep || applicant.workflowStep || '',
    workflowCategory: detail.workflowCategory || applicant.workflowCategory || '',
    recruiterId: detail.recruiterId || applicant.recruiterId || '',
    recruiterEmail: detail.recruiterEmail || applicant.recruiterEmail || '',
    recruiterName: detail.recruiterName || applicant.recruiterName || '',
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

function applyApplicantOverrides(applicant, { name = '', email = '', phone = '', jobTitle = '' } = {}) {
  if (!applicant) return null
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim()
  const parts = normalizedName ? normalizedName.split(' ') : []
  const firstName = normalizedName ? parts.shift() : ''
  return {
    ...applicant,
    ...(normalizedName ? {
      fullName: normalizedName,
      firstName,
      lastName: parts.join(' '),
    } : {}),
    ...(String(email || '').trim() ? { email: String(email).trim() } : {}),
    ...(String(phone || '').trim() ? { phone: String(phone).trim() } : {}),
    ...(String(jobTitle || '').trim() ? { jobTitle: String(jobTitle).trim() } : {}),
  }
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

function findMappedPersonById(id) {
  const value = String(id || '').trim()
  if (!value) return undefined
  const person = findPersonById(value)
  if (person) return person
  for (const assignment of getRoleAssignments()) {
    for (const mapped of [assignment.recruiter, assignment.hiringManager]) {
      if (!mapped) continue
      if (mapped.id === value || mapped.slackUserId === value) return mapped
    }
  }
  return undefined
}

function roleById(id) {
  const value = String(id || '').trim()
  if (!value) return null
  return getOpenRoles().find((role) => role.id === value || role.roleId === value || role.roleKey === value) || null
}

export function resolveRoleAssignmentsForRole(roleId) {
  const role = roleById(roleId)
  if (!role) {
    return {
      assignments: [],
      matchType: 'unmatched',
      matchedTitle: '',
      confidence: 0,
      candidates: [],
    }
  }
  return matchRoleAssignments(role, getRoleAssignments())
}

function roleAssignmentsForRole(roleId) {
  return resolveRoleAssignmentsForRole(roleId).assignments
}

export function mappedRecruitersForRole(roleId) {
  const mapped = uniquePeople(
    roleAssignmentsForRole(roleId)
      .map((assignment) => assignment.recruiter)
      .filter(Boolean)
      .map(enrichRecruiterFromDirectory)
      .map(asRecruiter),
  )
  if (mapped.length > 0) return mapped

  const role = roleById(roleId)
  const jazzhrLead = getRecruiters().find((person) =>
    person.id === `rec-${role?.hiringLeadId}` ||
    person.id === role?.hiringLeadId
  )
  if (jazzhrLead) {
    const enriched = getTalentRecruiters().find((person) => personIdentityMatches(person, jazzhrLead))
    return [asRecruiter(enriched || jazzhrLead)]
  }

  return getRoleAssignments().length > 0 ? [] : getTalentRecruiters()
}

function enrichRecruiterFromDirectory(recruiter) {
  if (!recruiter) return recruiter
  const directoryRecruiter = getTalentRecruiters().find((person) => personIdentityMatches(person, recruiter))
  if (!directoryRecruiter) return recruiter
  return {
    ...directoryRecruiter,
    ...recruiter,
    phone: directoryRecruiter.phone || recruiter.phone || '',
    zoomLink: directoryRecruiter.zoomLink || recruiter.zoomLink || '',
  }
}

export function mappedHiringManagersForRole(roleId) {
  return uniquePeople(roleAssignmentsForRole(roleId).map((assignment) => assignment.hiringManager).filter(Boolean).map(asHiringManager))
}

export function selectableHiringManagersForRole(roleId) {
  const mapped = mappedHiringManagersForRole(roleId)
  if (mapped.length > 0) return mapped

  const directoryManagers = getHiringManagers().map(asHiringManager)
  if (directoryManagers.length > 0) return directoryManagers

  return uniquePeople(
    getRoleAssignments()
      .map((assignment) => assignment.hiringManager)
      .filter(Boolean)
      .map(asHiringManager),
  )
}

function uniquePeople(people) {
  const seen = new Set()
  const result = []
  for (const person of people || []) {
    const key = normalizeEmail(person.email) || person.id || person.name
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(person)
  }
  return result
}

function roleOptions(query = '') {
  const normalized = String(query || '').trim().toLowerCase()
  return getOpenRoles()
    .filter((role) => !normalized || [role.title, role.roleId, role.roleKey].join(' ').toLowerCase().includes(normalized))
    .filter(canonicalRoleId)
    .slice(0, 100)
    .map((role) => toSlackOption(role.title || role.roleId || role.id, canonicalRoleId(role)))
}

function canonicalRoleId(role) {
  return String(role?.id || role?.roleId || role?.roleKey || '').trim()
}

function roleCandidateFilters(draftOrMetadata = {}) {
  const role = roleById(draftOrMetadata.roleId)
  const selectedRecruiters = (draftOrMetadata.recruiterIds || [])
    .map(findMappedPersonById)
    .filter(Boolean)
  return {
    roleId: role?.roleId || '',
    roleTitle: '',
    recruiterIds: draftOrMetadata.recruiterIds || [],
    recruiterEmails: selectedRecruiters.map((person) => person.email).filter(Boolean),
    recruiterNames: selectedRecruiters.map((person) => person.name).filter(Boolean),
  }
}

export function resolveZoomLinkForRecruiters(recruiters = []) {
  const uniqueLinks = [...new Set((recruiters || []).map((recruiter) => String(recruiter?.zoomLink || '').trim()).filter(Boolean))]
  return uniqueLinks.length === 1 ? uniqueLinks[0] : ''
}

export function roleAutofillSelections(eventType, recruiters = [], hiringManagers = []) {
  const recruiterIds = normalizeIdList(recruiters.map((person) => person?.id)).slice(0, 1)
  const hiringManagerIds = ['2nd-interview', 'final-interview'].includes(eventType)
    ? normalizeIdList(hiringManagers.map((person) => person?.id)).slice(0, 1)
    : []
  return { recruiterIds, hiringManagerIds }
}

function nextRecruiterZoomState(body, metadata, recruiters) {
  const currentValue = getInputValue(body.view?.state?.values, 'zoom_link')
  const previousValue = String(metadata?.zoomLink || '').trim()
  const uniqueLinks = [...new Set((recruiters || []).map((person) => String(person?.zoomLink || '').trim()).filter(Boolean))]
  if (currentValue && currentValue !== previousValue) {
    return { zoomLink: currentValue, zoomLinkAuto: false }
  }
  if (currentValue && !metadata?.zoomLinkAuto) {
    return { zoomLink: currentValue, zoomLinkAuto: false }
  }
  return {
    zoomLink: uniqueLinks.length === 1 ? uniqueLinks[0] : '',
    zoomLinkAuto: uniqueLinks.length === 1,
  }
}

function buildExtraIntakeAttendees(recruiters = [], hiringManagers = [], { includePrimaryHiringManager = false } = {}) {
  const primaryRecruiterId = recruiters[0]?.id || ''
  const primaryHiringManagerId = includePrimaryHiringManager ? '' : hiringManagers[0]?.id || ''
  return [
    ...recruiters.filter((person) => person.id !== primaryRecruiterId).map((person) => attendeeFromPerson(person, 'recruiter')),
    ...hiringManagers.filter((person) => person.id !== primaryHiringManagerId).map((person) => attendeeFromPerson(person, 'hiring_manager')),
  ]
}

function attendeeFromPerson(person, role) {
  return {
    id: person.id,
    name: person.name || person.email || '',
    email: person.email || '',
    role,
    required: false,
    included: true,
    slackUserId: person.slackUserId || null,
    source: person.source || 'role_assignment',
  }
}

function isStandardIntakeEvent(eventType) {
  return ['1st-interview', '2nd-interview', 'final-interview', 'job-offer'].includes(eventType)
}

function stageKeyForEventType(eventType) {
  if (eventType === 'job-offer') return 'job-offer-discussion'
  return isStandardIntakeEvent(eventType) ? eventType : ''
}

function eventTypeForStageKey(stageKey) {
  const normalized = normalizeStageKey(stageKey)
  if (normalized === 'job-offer-discussion' || normalized === 'final-offer') return 'job-offer'
  return ['1st-interview', '2nd-interview', 'final-interview'].includes(normalized) ? normalized : '1st-interview'
}

function eventTypeLabel(eventType) {
  return {
    '1st-interview': '1st Interview',
    '2nd-interview': '2nd Interview',
    'final-interview': 'Final Interview',
    'job-offer': 'Job Offer',
    'custom-invite': 'Custom Invite',
  }[eventType] || ''
}

function mergeCustomInviteRecipients(...groups) {
  const recipients = []
  const seen = new Set()
  for (const group of groups) {
    for (const recipient of group || []) {
      const email = normalizeEmail(recipient?.email)
      if (!email || seen.has(email)) continue
      seen.add(email)
      recipients.push({
        name: String(recipient?.name || '').replace(/\s+/g, ' ').trim(),
        email,
        ...(recipient?.slackUserId ? { slackUserId: recipient.slackUserId } : {}),
      })
    }
  }
  return recipients
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
  const resumeElement = values?.resume_block?.resume_file
  const file = Array.isArray(resumeElement?.files) ? resumeElement.files[0] : null
  if (file) return resumeFileReference(file)

  const legacyLinkElement = values?.resume_block?.resume_link
  return legacyLinkElement?.value?.trim() || ''
}

function extractResumeFile(values) {
  const resumeElement = values?.resume_block?.resume_file
  const file = Array.isArray(resumeElement?.files) ? resumeElement.files[0] : null
  return file ? normalizeResumeFile(file) : null
}

function resumeFileReference(file) {
  return String(
    file.permalink ||
    file.downloadUrl ||
    file.url_private ||
    file.url_private_download ||
    file.id ||
    file.name ||
    '',
  ).trim()
}

function renameResumeFile(resumeFile, roleTitle, applicant) {
  if (!resumeFile || typeof resumeFile !== 'object') return resumeFile
  const match = String(resumeFile.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  const extension = match ? match[1] : ''
  const role = String(roleTitle || '').trim()
  const fullName = applicant
    ? [applicant.firstName, applicant.lastName].filter(Boolean).join(' ').trim()
    : ''
  const base = [role, fullName].filter(Boolean).join(' - ').trim()
  if (!base) return resumeFile
  const safeBase = base.replace(/[\\/]/g, '-').replace(/[\r\n"]/g, '').trim()
  if (!safeBase) return resumeFile
  return { ...resumeFile, name: extension ? `${safeBase}.${extension}` : safeBase }
}

function completionActionValue(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    if (parsed?.caseId) {
      return {
        caseId: String(parsed.caseId),
        scheduleVersion: parsed.scheduleVersion,
      }
    }
  } catch {
    // Legacy completion buttons stored only the case ID.
  }
  return { caseId: String(value || ''), scheduleVersion: undefined }
}

async function addRequiredResumeAttachment({ email, caseRecord, client, config, logger }) {
  if (!stageRequiresResumeLink(caseRecord.stageKey)) return email
  const attachment = await resolveResumeAttachment({
    caseRecord,
    client,
    botToken: config.slack.botToken,
    maxBytes: config.notifications?.resumeAttachmentMaxBytes || 15 * 1024 * 1024,
    logger,
  })
  if (attachment) {
    email.attachments = [attachment]
  } else {
    logger?.warn?.('resume_attachment_unavailable', {
      caseId: caseRecord.id,
      stageKey: caseRecord.stageKey,
      message: 'Proceeding without resume attachment.',
    })
  }
  return email
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

function persistableEmail(email) {
  if (!email) return email
  const { attachments, ...persisted } = email
  return persisted
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

import { applicantLabel, personLabel, personOptions, trimForSlack } from '../data/search.js'
import { TIMEZONE_COUNTRY_MAP } from '../data/timezones.js'
import { isScheduledCase, normalizeCaseSchedule, visibleCaseActions } from '../workflow/reschedule.js'
import { DEFAULT_STAGE_RULES, STAGE_OPTIONS, normalizeStageKey, resolveStageFromTemplate, resolveStageRules } from '../workflow/stage-rules.js'
import { normalizeAttendees } from '../workflow/attendees.js'
import { buildCustomInviteEmail, isCustomInviteCase, normalizeCustomInviteMetadata } from '../workflow/custom-invite.js'
import { resumeSlackLink } from '../resume-display.js'
import {
  BUSINESS_DAY_END,
  BUSINESS_DAY_START,
  PH_TIME_ZONE,
  SYDNEY_TIME_ZONE,
  formatDateForInput,
  formatDateInTimeZone,
  formatTimeInTimeZone,
  formatTimeZoneShortName,
  localDateTimeToUtc,
} from '../time.js'

export const STATUSES = [
  'Draft',
  'Coordinator Review',
  'Checking Availability',
  'Waiting for Candidate',
  'Ready to Schedule',
  'Scheduled',
  'Post-Interview Follow-up',
  'Closed',
];

const STATUS_EMOJI = {
  'Draft': '📄',
  'Coordinator Review': '🧭',
  'Waiting for HM': '🧭',
  'Checking Availability': '🔍',
  'Checking Calendar': '🔍',
  'Waiting for Candidate': '👤',
  'Ready to Schedule': '✅',
  'Scheduled': '📅',
  'Post-Interview Follow-up': '🔔',
  'Closed': '✅',
  'Reschedule Requested': '🔄',
  'Needs Attention': '⚠️',
};

function displayStatus(status) {
  if (status === 'Waiting for HM') return 'Coordinator Review'
  if (status === 'Checking Calendar') return 'Checking Availability'
  return status
}

function statusEmoji(status) {
  const labels = {
    'Draft': 'draft',
    'Coordinator Review': 'review',
    'Checking Availability': 'checking',
    'Waiting for Candidate': 'candidate',
    'Ready to Schedule': 'ready',
    'Scheduled': 'scheduled',
    'Post-Interview Follow-up': 'follow-up',
    'Closed': 'closed',
    'Reschedule Requested': 'reschedule',
    'Needs Attention': 'attention',
  }
  return labels[displayStatus(status)] || 'status';
}

export function homeView({
  myCases,
  teamCases,
  googleConnected = false,
  googleShared = false,
  googleCanManage = true,
}) {
  const googleAction = googleCanManage
    ? (googleConnected
        ? button('Disconnect Google', 'disconnect_google_oauth', 'danger')
        : button('Connect Google', 'open_google_oauth'))
    : null
  const googleText = googleShared
    ? (googleConnected
        ? '✅ Google Calendar and Gmail are connected through the shared scheduling account.'
        : '⚠️ Shared Google Calendar and Gmail are not connected yet. Ask the configured Google owner to connect.')
    : (googleConnected
        ? '✅ Google Calendar and Gmail are connected for this Slack user.'
        : '⚠️ Google is not connected yet. Click Connect Google before final scheduling.')

  return {
    type: 'home',
    blocks: [
      header('📋 Interview Scheduling'),
      section('Start, review, and approve interview scheduling cases without retyping candidate details.'),
      section(googleText) ,
      actions([
        button('🚀 Start scheduling', 'open_schedule_intake', 'primary'),
        button('📚 Schedule tracker', 'open_schedule_tracker'),
        button('📢 Post channel button', 'post_schedule_launcher'),
        googleAction,
      ].filter(Boolean)),
      divider(),
      header('👤 My Cases'),
      ...caseListBlocks(myCases, '📋 No active cases assigned to you.'),
      divider(),
      header('👥 Team Queue'),
      ...caseListBlocks(teamCases, '👥 No team cases need attention.'),
    ],
  };
}

export function intakeModal({ templates, draft = {}, timeZones = [], defaultTimeZone, recruiters = [], roles = [] }) {
  const resolvedTimeZones = timeZones.length > 0 ? timeZones : [SYDNEY_TIME_ZONE]
  const selectedTimeZone = draft.interviewTimezone || defaultTimeZone || resolvedTimeZones[0] || SYDNEY_TIME_ZONE
  const selectedTimeZoneCountry = TIMEZONE_COUNTRY_MAP[selectedTimeZone]
  const selectedTimeZoneOption = {
    text: plain(selectedTimeZoneCountry ? `${selectedTimeZone} (${selectedTimeZoneCountry})` : selectedTimeZone),
    value: selectedTimeZone,
  }
  const eventType = draft.eventType || ''
  const standardEvent = isStandardIntakeEvent(eventType)
  const customInvite = eventType === 'custom-invite'
  if (customInvite) {
    return customInviteIntakeModal({
      draft,
      selectedTimeZoneOption,
    })
  }
  const recruiterSelect = recruiterSelectElement({ recruiters, draft })
  const manualCandidateMode = customInvite && Boolean(draft.manualCandidateMode)
  const recruiterEmailBlockId = dynamicBlockId('recruiter_email_block', draft.recruiterId)
  const hiringManagerEmailBlockId = dynamicBlockId('hm_email_block', draft.hiringManagerId)
  const recruiterEmailActionId = dynamicBlockId('recruiter_email', draft.recruiterId)
  const hiringManagerEmailActionId = dynamicBlockId('hm_email', draft.hiringManagerId)
  const hmRequired = stageRequiresHiringManager(draft.stageKey)
  const resumeRequired = stageRequiresResumeLink(draft.stageKey)
  const showStandardHiringManagers = standardEvent &&
    (eventType === '2nd-interview' || eventType === 'final-interview')
  const applicantBlockId = dynamicBlockId('applicant_block', draft.applicantId || draft.roleId)
  const zoomBlockId = dynamicBlockId('zoom_block', draft.zoomLink)
  const zoomLinkOptions = recruiterZoomOptions(draft.selectedRecruiters)
  const availableRecruiters = draft.availableRecruiters || draft.selectedRecruiters || []
  const availableHiringManagers = draft.availableHiringManagers ||
    uniquePeopleById([...(draft.selectedHiringManagers || []), ...(draft.suggestedHiringManagers || [])])
  const remoteUpdateBlocks = draft.remoteUpdateStatus
    ? [
        section(draft.remoteUpdateStatus === 'loading'
          ? `:hourglass_flowing_sand: *Updating form*\n${draft.remoteUpdateMessage || 'Loading remote data. This can take a few seconds.'}`
          : `:warning: *Automatic update failed*\n${draft.remoteUpdateMessage || 'Remote data could not be loaded. Review and edit the fields below.'}`),
      ]
    : []
  const hiringManagerBlocks = hmRequired
    ? [
        input('Hiring Manager name', 'hm_block', {
          type: 'external_select',
          action_id: 'hm_select',
          min_query_length: 0,
          placeholder: plain('Search active users'),
          ...(draft.hiringManagerOption ? { initial_option: draft.hiringManagerOption } : {}),
        }, false, true),
        input(
          'Hiring Manager email',
          hiringManagerEmailBlockId,
          {
            type: 'plain_text_input',
            action_id: hiringManagerEmailActionId,
            placeholder: plain('Autofills from the selected hiring manager'),
            ...(draft.hiringManagerEmail ? { initial_value: draft.hiringManagerEmail } : {}),
          },
          false,
        ),
      ]
    : []
  const standardRoleBlocks = standardEvent
    ? [
        input('JazzHR role', 'role_block', {
          type: 'external_select',
          action_id: 'role_select',
          min_query_length: 0,
          placeholder: plain('Search open role'),
          ...(draft.roleOption ? { initial_option: draft.roleOption } : {}),
        }, false, true),
        input('Role title', dynamicBlockId('role_title_block', draft.roleId), {
          type: 'plain_text_input',
          action_id: 'role_title_override',
          placeholder: plain('Edit the role title if needed'),
          ...(draft.roleTitle ? { initial_value: draft.roleTitle } : {}),
        }),
        ...peopleCheckboxBlocks({
          label: 'Recruiters',
          blockId: 'recruiters_block',
          actionId: 'recruiter_checkboxes',
          searchBlockId: 'recruiter_search_block',
          searchActionId: 'recruiter_people_search',
          searchQuery: draft.recruiterSearchQuery,
          people: availableRecruiters,
          selectedIds: draft.recruiterIds,
          required: true,
        }),
        input('Recruiter name', dynamicBlockId('recruiter_name_block', draft.recruiterId || draft.roleId), {
          type: 'plain_text_input',
          action_id: 'recruiter_name_override',
          placeholder: plain('Edit the recruiter name if needed'),
          ...(draft.recruiterName ? { initial_value: draft.recruiterName } : {}),
        }),
        input('Recruiter email', dynamicBlockId('recruiter_email_block', draft.recruiterId || draft.roleId), {
          type: 'plain_text_input',
          action_id: 'recruiter_email_override',
          placeholder: plain('Edit the recruiter email if needed'),
          ...(draft.recruiterEmail ? { initial_value: draft.recruiterEmail } : {}),
        }),
        ...(showStandardHiringManagers ? [
          section(draft.suggestedHiringManagers?.length
            ? [
                '*Suggested hiring managers for this role*',
                ...draft.suggestedHiringManagers.map((person) => `• ${personLabel(person)}`),
                '_Select at least one manager below. Suggestions are not invited automatically._',
              ].join('\n')
            : '*Suggested hiring managers for this role*\nNo confident Open Roles match was found. Select a manager manually.'),
          ...peopleCheckboxBlocks({
            label: 'Hiring managers',
            blockId: 'hiring_managers_block',
            actionId: 'hiring_manager_checkboxes',
            searchBlockId: 'hiring_manager_search_block',
            searchActionId: 'hiring_manager_people_search',
            searchQuery: draft.hiringManagerSearchQuery,
            people: availableHiringManagers,
            selectedIds: draft.hiringManagerIds,
            required: hmRequired,
          }),
          input('Hiring manager name', dynamicBlockId('hm_name_block', draft.hiringManagerId || draft.roleId), {
            type: 'plain_text_input',
            action_id: 'hm_name_override',
            placeholder: plain('Edit the hiring manager name if needed'),
            ...(draft.hiringManagerName ? { initial_value: draft.hiringManagerName } : {}),
          }, !hmRequired),
          input('Hiring manager email', dynamicBlockId('hm_email_block', draft.hiringManagerId || draft.roleId), {
            type: 'plain_text_input',
            action_id: 'hm_email_override',
            placeholder: plain('Edit the hiring manager email if needed'),
            ...(draft.hiringManagerEmail ? { initial_value: draft.hiringManagerEmail } : {}),
          }, !hmRequired),
        ] : []),
      ]
    : []

  return {
    type: 'modal',
    callback_id: 'schedule_intake_submit',
    title: plain('📅 Schedule Interview'),
    submit: plain('➕ Create'),
    close: plain('Cancel'),
    blocks: [
      input('Event type', 'event_type_block', {
        type: 'static_select',
        action_id: 'event_type_select',
        placeholder: plain('Choose event type'),
        options: intakeEventTypeOptions(),
        ...(draft.eventTypeOption ? { initial_option: draft.eventTypeOption } : {}),
      }, false, true),
      ...remoteUpdateBlocks,
      ...standardRoleBlocks,
      ...(customInvite ? [
        input('What is this invite for?', 'custom_purpose_block', {
          type: 'plain_text_input',
          action_id: 'custom_purpose',
          placeholder: plain('Example: client intro, assessment, paid trial'),
          ...(draft.customInvitePurpose ? { initial_value: draft.customInvitePurpose } : {}),
        }, false),
      ] : []),
      ...(customInvite ? [actions([manualCandidateModeCheckbox(draft)], 'manual_candidate_mode_block')] : []),
      ...(!(standardEvent || customInvite) ? [] : !manualCandidateMode ? [
        input(
          'Candidate name search',
          'candidate_search_block',
          {
            type: 'plain_text_input',
            action_id: 'candidate_search',
            placeholder: plain('Type part of the candidate name'),
            ...(draft.candidateSearchQuery ? { initial_value: draft.candidateSearchQuery } : {}),
          },
          true,
        ),
        actions([
          button('Search', 'candidate_search_submit', 'primary'),
          ...candidateSearchPaginationButtons(draft),
        ]),
        ...(draft.candidateSearchQuery ? [section(candidateSearchSummary(draft))] : []),
        {
          type: 'input',
          block_id: applicantBlockId,
          optional: false,
          dispatch_action: true,
          label: plain('Candidate results'),
          element: {
            type: 'external_select',
            action_id: 'applicant_select',
            min_query_length: 0,
            placeholder: plain('Select from search results'),
            ...(draft.applicantOption ? { initial_option: draft.applicantOption } : {}),
          },
        },
        input(
          'Candidate name',
          dynamicBlockId('applicant_name_block', draft.applicantId),
          {
            type: 'plain_text_input',
            action_id: 'applicant_name_override',
            placeholder: plain('Edit the candidate name if needed'),
            ...(draft.applicantName ? { initial_value: draft.applicantName } : {}),
          },
          true,
        ),
        input(
          'Applicant email',
          dynamicBlockId('applicant_email_block', draft.applicantId),
          {
            type: 'plain_text_input',
            action_id: 'applicant_email',
            placeholder: plain('Override the applicant email'),
            ...(draft.applicantEmail ? { initial_value: draft.applicantEmail } : {}),
          },
          true,
        ),
        input(
          'Applicant phone',
          dynamicBlockId('applicant_phone_block', draft.applicantId),
          {
            type: 'plain_text_input',
            action_id: 'applicant_phone_override',
            placeholder: plain('Edit the applicant phone if needed'),
            ...(draft.applicantPhone ? { initial_value: draft.applicantPhone } : {}),
          },
          true,
        ),
      ] : [
        input(
          'Candidate name',
          'manual_applicant_name_block',
          {
            type: 'plain_text_input',
            action_id: 'manual_applicant_name',
            placeholder: plain('Type the candidate name'),
            ...(draft.manualApplicantName ? { initial_value: draft.manualApplicantName } : {}),
          },
          false,
        ),
        input(
          'Candidate role',
          'manual_applicant_role_block',
          {
            type: 'plain_text_input',
            action_id: 'manual_applicant_role',
            placeholder: plain('Type the candidate role'),
            ...(draft.manualApplicantRole ? { initial_value: draft.manualApplicantRole } : {}),
          },
          false,
        ),
        input(
          'Applicant email',
          'applicant_email_block',
          {
            type: 'plain_text_input',
            action_id: 'applicant_email',
            placeholder: plain('Type the applicant email'),
            ...(draft.applicantEmail ? { initial_value: draft.applicantEmail } : {}),
          },
          false,
        ),
      ]),
      ...applicantDetailBlocks(draft),
      ...(customInvite ? [
      input('Recruiter name', 'recruiter_block', recruiterSelect, false, true),
      input(
        'Recruiter email',
        recruiterEmailBlockId,
        {
          type: 'plain_text_input',
          action_id: recruiterEmailActionId,
          placeholder: plain('Autofills from the selected recruiter'),
          ...(draft.recruiterEmail ? { initial_value: draft.recruiterEmail } : {}),
        },
        true,
      ),
      ...hiringManagerBlocks,
      ] : []),
      ...((standardEvent || customInvite) ? [
      ...(standardEvent && zoomLinkOptions.length > 0 ? [
        input('Recruiter Zoom link', 'zoom_choice_block', {
          type: 'static_select',
          action_id: 'zoom_link_select',
          placeholder: plain('Choose recruiter Zoom link'),
          options: zoomLinkOptions,
          ...(draft.zoomLinkOption ? { initial_option: draft.zoomLinkOption } : {}),
        }, true),
      ] : []),
      input('Zoom link', zoomBlockId, {
        type: 'plain_text_input',
        action_id: 'zoom_link',
        placeholder: plain('Paste final Zoom link'),
        ...(draft.zoomLink ? { initial_value: draft.zoomLink } : {}),
      }, false),
      input(
        'Notes',
        'notes_block',
        {
          type: 'plain_text_input',
          action_id: 'notes',
          multiline: true,
          placeholder: plain('Optional scheduling context'),
          ...(draft.notes ? { initial_value: draft.notes } : {}),
        },
        true,
      ),
      input(
        'Resume',
        'resume_block',
        {
          type: 'file_input',
          action_id: 'resume_file',
          max_files: 1,
          filetypes: ['pdf', 'doc', 'docx'],
        },
        !resumeRequired,
      ),
      input('Interview timezone', 'timezone_block', {
        type: 'external_select',
        action_id: 'timezone_select',
        min_query_length: 0,
        placeholder: plain('Search by country or timezone'),
        ...(selectedTimeZoneOption ? { initial_option: selectedTimeZoneOption } : {}),
      }),
      section(`🕐 Interview timezone drives calendar invites. Times are shown in PH (${PH_TIME_ZONE}) with interview timezone equivalents.`),
      section('📝 Calendar descriptions are generated automatically from the schedule details. Add notes here only if you want extra intake context.'),
      ] : []),
    ],
  };
}

function customInviteIntakeModal({ draft, selectedTimeZoneOption }) {
  const defaultSubject = draft.customInviteTitle ? `Invitation: ${draft.customInviteTitle}` : ''
  const defaultBody = [
    '[greeting]',
    '',
    'You are invited to [event_title].',
    '',
    'Date: [date]',
    'Time: [time] [timezone]',
    'Meeting link: [meeting_link]',
  ].join('\n')

  return {
    type: 'modal',
    callback_id: 'schedule_intake_submit',
    title: plain('Schedule Event'),
    submit: plain('Create'),
    close: plain('Cancel'),
    blocks: [
      input('Event type', 'event_type_block', {
        type: 'static_select',
        action_id: 'event_type_select',
        placeholder: plain('Choose event type'),
        options: intakeEventTypeOptions(),
        ...(draft.eventTypeOption ? { initial_option: draft.eventTypeOption } : {}),
      }, false, true),
      input('Event purpose / title', 'custom_title_block', {
        type: 'plain_text_input',
        action_id: 'custom_title',
        placeholder: plain('Example: Client introduction'),
        ...(draft.customInviteTitle ? { initial_value: draft.customInviteTitle } : {}),
      }),
      section([
        '*Add one recipient per line*',
        'Use either `Name <email>` or just `email`:',
        '```Alex Reyes <alex@example.com>',
        'guest@example.com```',
        '_All recipients are guests on one shared calendar event and can see each other._',
      ].join('\n')),
      input('Recipient email addresses', 'custom_recipients_block', {
        type: 'plain_text_input',
        action_id: 'custom_recipients',
        multiline: true,
        placeholder: plain('Enter one recipient per line'),
        ...(draft.customInviteRecipientsRaw ? { initial_value: draft.customInviteRecipientsRaw } : {}),
      }, false, false, 'Names are optional. Every line must contain a valid email address.'),
      input('Email subject', 'custom_subject_block', {
        type: 'plain_text_input',
        action_id: 'custom_subject',
        ...(draft.customInviteSubject || defaultSubject
          ? { initial_value: draft.customInviteSubject || defaultSubject }
          : {}),
      }),
      input('Email body', 'custom_body_block', {
        type: 'plain_text_input',
        action_id: 'custom_body',
        multiline: true,
        initial_value: draft.customInviteBody || defaultBody,
      }),
      input('Meeting link', 'custom_meeting_link_block', {
        type: 'plain_text_input',
        action_id: 'custom_meeting_link',
        placeholder: plain('Optional Zoom, Meet, Teams, or other URL'),
        ...(draft.customInviteMeetingLink ? { initial_value: draft.customInviteMeetingLink } : {}),
      }, true),
      input('Notes', 'notes_block', {
        type: 'plain_text_input',
        action_id: 'notes',
        multiline: true,
        placeholder: plain('Optional scheduling context'),
        ...(draft.notes ? { initial_value: draft.notes } : {}),
      }, true),
      input('Event timezone', 'timezone_block', {
        type: 'external_select',
        action_id: 'timezone_select',
        min_query_length: 0,
        placeholder: plain('Search by country or timezone'),
        ...(selectedTimeZoneOption ? { initial_option: selectedTimeZoneOption } : {}),
      }),
      section('Available variables: [greeting], [name], [email], [event_title], [date], [time], [timezone], [meeting_link].'),
    ],
  }
}

export function candidateMessageModal({
  caseRecord,
  renderedTemplate,
  callbackId = 'candidate_message_submit',
  submitText = 'Approve',
  recentAudits = [],
}) {
  const plainBody = renderedTemplate.plainBody || renderedTemplate.body
  return {
    type: 'modal',
    callback_id: callbackId,
    private_metadata: caseRecord.id,
    title: plain('Candidate Message'),
    submit: plain(submitText),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      section('Editing is plain text. Formatting is applied automatically.'),
      section('*Email will be sent* to the candidate when you approve.'),
      input('Email subject', 'email_subject_block', {
        type: 'plain_text_input',
        action_id: 'email_subject',
        initial_value: renderedTemplate.subject,
      }),
      input('Email body', 'email_body_block', {
        type: 'plain_text_input',
        action_id: 'email_body',
        multiline: true,
        initial_value: plainBody,
      }),
    ],
  };
}

export function finalizeModal(caseRecord, recentAudits = []) {
  const interviewTimeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
  if (isCustomInviteCase(caseRecord)) {
    const customInvite = normalizeCustomInviteMetadata(caseRecord)
    const referenceDate = resolveReferenceDate(caseRecord)
    const timeOptions = buildPhTimeOptions({ referenceDate, interviewTimeZone })
    return {
      type: 'modal',
      callback_id: 'finalize_schedule_submit',
      private_metadata: caseRecord.id,
      title: plain('Schedule Event'),
      submit: plain('Preview'),
      close: plain('Cancel'),
      blocks: [
        ...caseProgressHeader(caseRecord, recentAudits),
        section(`*${caseTitle(caseRecord)}*`),
        section(`Times shown in PH (${PH_TIME_ZONE}). Event timezone: ${interviewTimeZone}.`),
        input('Duration', 'duration_block', {
          type: 'static_select',
          action_id: 'duration_select',
          placeholder: plain('Select duration'),
          options: durationSelectOptions(30),
          initial_option: durationSelectOption(30),
        }),
        input('Event date', 'date_block', {
          type: 'datepicker',
          action_id: 'date',
          placeholder: plain('Select date'),
        }),
        input('Event time (PH business hours)', 'time_block', {
          type: 'static_select',
          action_id: 'time',
          placeholder: plain('Select time'),
          options: timeOptions,
        }),
        input('Meeting link', 'zoom_block', {
          type: 'plain_text_input',
          action_id: 'zoom_link',
          placeholder: plain('Optional Zoom, Meet, Teams, or other URL'),
          ...(customInvite.meetingLink ? { initial_value: customInvite.meetingLink } : {}),
        }, true),
      ],
    }
  }

  const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
  const stageRules = resolveStageRules(stageKey, caseRecord.stageOverrides)
  const referenceDate = resolveReferenceDate(caseRecord)
  const timeOptions = buildPhTimeOptions({ referenceDate, interviewTimeZone })
  const zoomLink = resolveCaseZoomLink(caseRecord)

  return {
    type: 'modal',
    callback_id: 'finalize_schedule_submit',
    private_metadata: caseRecord.id,
    title: plain('📅 Finalize Schedule'),
    submit: plain('📅 Schedule'),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      section(`🕐 Times shown in PH (${PH_TIME_ZONE}). Interview timezone: ${interviewTimeZone}.`),
      section('📝 Calendar descriptions are generated automatically from the date, time, attendees, and Zoom link.'),
      input('Stage', 'stage_block', {
        type: 'static_select',
        action_id: 'stage_select',
        placeholder: plain('Select interview stage'),
        options: stageSelectOptions(stageKey),
        initial_option: stageSelectOption(stageKey),
      }),
      input('Duration', 'duration_block', {
        type: 'static_select',
        action_id: 'duration_select',
        placeholder: plain('Select duration'),
        options: durationSelectOptions(stageRules.typicalDurationMinutes),
        initial_option: durationSelectOption(stageRules.typicalDurationMinutes),
      }),
      input('Interview date', 'date_block', {
        type: 'datepicker',
        action_id: 'date',
        placeholder: plain('Select date'),
      }),
      input('Interview time (PH business hours)', 'time_block', {
        type: 'static_select',
        action_id: 'time',
        placeholder: plain('Select time'),
        options: timeOptions,
      }),
      input('Zoom link', 'zoom_block', {
        type: 'plain_text_input',
        action_id: 'zoom_link',
        ...(zoomLink ? { initial_value: zoomLink } : {}),
      }),
    ],
  };
}

export function finalizeEmailPreviewModal({ caseRecord, scheduleInput, renderedTemplate, recentAudits = [] }) {
  const plainBody = renderedTemplate.plainBody || renderedTemplate.body
  const customInvite = isCustomInviteCase(caseRecord)
  return {
    type: 'modal',
    callback_id: 'finalize_email_preview_submit',
    private_metadata: JSON.stringify({ caseId: caseRecord.id, scheduleInput }),
    title: plain(customInvite ? 'Preview Invitation' : 'Preview Email'),
    submit: plain(customInvite ? 'Create Event & Send' : 'Create Invite'),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      section(customInvite
        ? 'Preview of the personalized invitation. One email will be sent to each recipient after the calendar event is created.'
        : 'Email preview before calendar invite creation.'),
      input('Email subject', 'email_subject_block', {
        type: 'plain_text_input',
        action_id: 'email_subject',
        initial_value: renderedTemplate.subject,
      }),
      input('Email body', 'email_body_block', {
        type: 'plain_text_input',
        action_id: 'email_body',
        multiline: true,
        initial_value: plainBody,
      }),
    ],
  }
}

export function schedulingModal(caseRecord, schedulingResult, recentAudits = []) {
  const phase = schedulingResult?.phase || 1
  const stageKey = normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview'
  const stageRules = schedulingResult?.stageRules || resolveStageRules(stageKey, caseRecord.stageOverrides)
  const attendees = schedulingResult?.attendees || normalizeAttendees(caseRecord, stageRules)
  const metadata = JSON.stringify({
    caseId: caseRecord.id,
    phase: 1,
    externalAttendees: schedulingResult?.externalAttendees || caseRecord.externalAttendees || [],
    stageKey,
    stageOverrides: caseRecord.stageOverrides || {}
  })

  const blocks = [
    header('📅 Schedule Interview'),
    section(`*${caseTitle(caseRecord)}*`),
    ...caseProgressHeader(caseRecord, recentAudits),
    header('🎯 Interview Stage'),
    input('Stage', 'stage_block', {
      type: 'static_select',
      action_id: 'stage_select',
      placeholder: plain('Select interview stage'),
      options: stageSelectOptions(stageKey),
      initial_option: stageSelectOption(stageKey)
    }),
    divider(),
    header('👥 Attendees'),
    attendeeCheckboxes(attendees),
    actions([
      button('➕ Add Attendee', 'scheduling_add_external', undefined, caseRecord.id)
    ]),
    divider(),
    header('🕐 Time Window'),
    input('From', 'schedule_window_start_block', {
      type: 'datepicker',
      action_id: 'schedule_window_start',
      placeholder: plain('Start date'),
      ...(caseRecord.interviewWindowStartDate ? { initial_date: caseRecord.interviewWindowStartDate } : {})
    }),
    input('To', 'schedule_window_end_block', {
      type: 'datepicker',
      action_id: 'schedule_window_end',
      placeholder: plain('End date'),
      ...(caseRecord.interviewWindowEndDate ? { initial_date: caseRecord.interviewWindowEndDate } : {})
    }),
    input('Duration', 'duration_block', {
      type: 'static_select',
      action_id: 'duration_select',
      placeholder: plain('Select duration'),
      options: durationSelectOptions(stageRules.typicalDurationMinutes),
      initial_option: durationSelectOption(stageRules.typicalDurationMinutes)
    }),
    section(`🕐 Interview timezone: ${caseRecord.interviewTimezone || SYDNEY_TIME_ZONE}. Times shown in PH (${PH_TIME_ZONE}).`)
  ]

  return {
    type: 'modal',
    callback_id: 'scheduling_phase_one',
    private_metadata: metadata,
    title: plain('📅 Schedule Interview'),
    close: plain('Cancel'),
    submit: plain('🔍 Check Availability'),
    blocks
  }
}

export function checkingAvailabilityModal(caseRecord) {
  return {
    type: 'modal',
    callback_id: 'scheduling_checking',
    title: plain('🔍 Checking Availability'),
    close: plain('Cancel'),
    blocks: [
      section(`*${caseTitle(caseRecord)}*`),
      section('🔍 Checking calendar availability. This may take a moment.'),
    ],
  }
}

export function customInviteRequestStatusModal({
  title = 'Processing Request',
  message,
  status = 'loading',
}) {
  const icon = status === 'loading'
    ? ':hourglass_flowing_sand:'
    : status === 'success'
      ? ':white_check_mark:'
      : ':warning:'
  return {
    type: 'modal',
    callback_id: 'custom_invite_request_status',
    title: plain(title),
    ...(status === 'loading' ? {} : { close: plain('Close') }),
    blocks: [
      section(`${icon} *${message}*`),
      ...(status === 'loading'
        ? [section('Please keep this window open while Calendar and email requests are completed.')]
        : []),
    ],
  }
}

export function customInviteSentEmailsModal(caseRecord) {
  const customInvite = normalizeCustomInviteMetadata(caseRecord)
  const emailBlocks = customInvite.recipients.slice(0, 95).map((recipient) => {
    const delivery = customInvite.deliveryStatus[recipient.email] || {}
    const email = {
      ...buildCustomInviteEmail(caseRecord, recipient),
      ...(delivery.email || {}),
    }
    const recipientLabel = recipient.name
      ? `${recipient.name} (${recipient.email})`
      : recipient.email
    return section([
      `*${escapeSlackText(recipientLabel)}*`,
      `Delivery: *${customInviteDeliveryLabel(delivery.status)}*`,
      `*Subject:* ${escapeSlackText(email.subject || customInvite.subject)}`,
      '*Email:*',
      `\`\`\`${truncateSlackPreservingWhitespace(escapeSlackCodeBlock(email.plainBody || customInvite.body), 2400)}\`\`\``,
    ].join('\n'))
  })

  return {
    type: 'modal',
    callback_id: 'custom_invite_sent_emails',
    title: plain('Sent Invitations'),
    close: plain('Close'),
    blocks: [
      section(`*${escapeSlackText(customInvite.title)}*\nPersonalized invitation emails for ${customInvite.recipients.length} recipient${customInvite.recipients.length === 1 ? '' : 's'}.`),
      ...emailBlocks,
      ...(customInvite.recipients.length > emailBlocks.length
        ? [section(`${customInvite.recipients.length - emailBlocks.length} additional emails are not shown because of Slack's modal limit.`)]
        : []),
    ],
  }
}

export function schedulingPhaseTwo(caseRecord, schedulingResult, recentAudits = []) {
  const timeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
  const referenceDate = resolveReferenceDate(caseRecord)
  const timeOptions = buildPhTimeOptions({ referenceDate, interviewTimeZone: timeZone })
  const allSlots = schedulingResult?.allSlots || schedulingResult?.available || []
  const available = schedulingResult?.available || []
  const warnings = schedulingResult?.warnings || []
  const stageRules = schedulingResult?.stageRules || {}
  const attendees = schedulingResult?.attendees || []
  const includedCount = attendees.filter((a) => a.included).length
  const mocked = schedulingResult?.mocked || false

  const metadata = JSON.stringify({
    caseId: caseRecord.id,
    phase: 2,
    stageKey: normalizeStageKey(caseRecord.stageKey || resolveStageFromTemplate(caseRecord.templateId)) || '1st-interview',
    stageOverrides: caseRecord.stageOverrides || {},
    externalAttendees: caseRecord.externalAttendees || [],
    selectedSlot: null
  })

  const blocks = [
    header('📅 Schedule Interview'),
    section(`*${caseTitle(caseRecord)}*`),
    ...caseProgressHeader(caseRecord, recentAudits),
    section(`🕐 Times shown in PH (${PH_TIME_ZONE}). Interview timezone: ${timeZone}.`),
    section('📝 Calendar descriptions are generated automatically from the selected schedule and attendees.'),
    section(`👥 *Attendees (${includedCount} included)*`),
    ...includedAttendeeList(attendees),
    actions([
      button('✏️ Edit Attendees', 'scheduling_edit_attendees', undefined, caseRecord.id)
    ])
  ]

  if (mocked) {
    blocks.push(section('\u26A0\uFE0F *Calendar not connected* \u2014 all slots during PH business hours shown'))
  }

  if (available.length > 0) {
    const totalCount = allSlots.length || available.length
    blocks.push(divider())
    blocks.push(section(`✅ *Available Slots (${available.length} of ${totalCount} conflict-free)*`))
    blocks.push(...slotOptionBlocks(available, timeZone))
  } else if (warnings.length > 0) {
    blocks.push(section('⚠️ No conflict-free slots found. Showing best available:'))
    const topSlots = (allSlots || []).slice(0, 20)
    if (topSlots.length > 0) {
      blocks.push(...slotOptionBlocks(topSlots, timeZone))
    }
  } else {
    blocks.push(section('❌ No slots found. Please go back and expand the date range.'))
  }

  blocks.push(divider())
  blocks.push(header('✏️ OR: Manual Entry'))
  blocks.push(input('Date', 'schedule_manual_date_block', {
    type: 'datepicker',
    action_id: 'schedule_manual_date',
    placeholder: plain('Select date')
  }, true))
  blocks.push(input('Time (PH business hours)', 'schedule_manual_time_block', {
    type: 'static_select',
    action_id: 'schedule_manual_time',
    placeholder: plain('Select time'),
    options: timeOptions
  }, true))

  blocks.push(divider())
  blocks.push(header('📋 Meeting Details'))
  blocks.push(input('Zoom Link', 'schedule_zoom_block', {
    type: 'plain_text_input',
    action_id: 'schedule_zoom_link',
    initial_value: caseRecord.autofill?.zoomLink || ''
  }))
  return {
    type: 'modal',
    callback_id: 'scheduling_phase_two',
    private_metadata: metadata,
    title: plain('📅 Schedule Interview'),
    close: plain('Cancel'),
    submit: plain('✅ Confirm & Schedule'),
    blocks
  }
}

export function attendeeCheckboxes(attendees) {
  if (!attendees || attendees.length === 0) {
    return section('⚠️ No attendees configured.')
  }

  const options = attendees.map((a) => {
    const roleLabel = a.role.replace(/_/g, ' ')
    const reqLabel = a.required ? ' ⭐ required' : ' — optional'
    const emailSuffix = a.email ? ` — ${a.email}` : ''

    return {
      text: plain(`${a.name || a.email} (${roleLabel})${reqLabel}${emailSuffix}`),
      value: a.email || a.id
    }
  })

  const initialOptions = attendees
    .filter((a) => a.included)
    .map((a) => a.email || a.id)
    .map((value) => options.find((option) => option.value === value))
    .filter(Boolean)

  return {
    type: 'input',
    block_id: 'attendee_toggle_block',
    optional: false,
    label: plain('👥 Include in scheduling'),
    element: {
      type: 'checkboxes',
      action_id: 'attendee_toggle',
      options: options.slice(0, 10),
      ...(initialOptions.length > 0 ? { initial_options: initialOptions.slice(0, 10) } : {})
    }
  }
}

export function slotOptionBlocks(slots, timeZone) {
  if (!slots || slots.length === 0) return [section('❌ No slots available.')]

  const { optionGroups, initialOption, truncated } = buildSlotOptionGroups(slots, timeZone)
  const blocks = []

  if (truncated) {
    blocks.push(section('ℹ️ Showing the first 100 available times. Narrow the date range to see more.'))
  }

  blocks.push({
    type: 'input',
    block_id: 'slot_select_block',
    optional: true,
    label: plain('📅 Select a time slot'),
    element: {
      type: 'static_select',
      action_id: 'slot_select',
      option_groups: optionGroups,
      ...(initialOption ? { initial_option: initialOption } : {})
    }
  })

  return blocks
}

export function buildConflictBlock(conflict) {
  if (!conflict) return section('❓ Unknown conflict')

  const events = conflict.overlappingEvents || []
  const msgs = events.map((e) => {
    const summary = e.summary || ''
    return summary ? `${summary}` : ''
  }).filter(Boolean)

  const detail = msgs.length > 0 ? ` (${msgs.join(', ')})` : ''

  return {
    type: 'context',
    elements: [
      mrkdwn(`\u26A0\uFE0F *Conflict detected*${detail}`)
    ]
  }
}

export function externalAttendeeModal(caseRecord, recentAudits = [], draft = {}) {
  return {
    type: 'modal',
    callback_id: 'external_attendee_submit',
    private_metadata: caseRecord.id,
    title: plain('➕ Add Attendee'),
    submit: plain('➕ Add'),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      input('Attendee', 'attendee_select_block', {
        type: 'external_select',
        action_id: 'attendee_select',
        min_query_length: 0,
        placeholder: plain('Search active users'),
        ...(draft.attendeeOption ? { initial_option: draft.attendeeOption } : {})
      }),
      input('Email', 'ext_email_block', {
        type: 'plain_text_input',
        action_id: 'ext_email',
        placeholder: plain('Autofills from selected attendee'),
        ...(draft.email ? { initial_value: draft.email } : {})
      }),
      input('Role', 'ext_role_block', {
        type: 'plain_text_input',
        action_id: 'ext_role',
        placeholder: plain('Autofills from selected attendee'),
        ...(draft.role ? { initial_value: draft.role } : {})
      })
    ]
  }
}

export function rescheduleModal(caseRecord, recentAudits = []) {
  const interviewTimeZone = caseRecord.interviewTimezone || SYDNEY_TIME_ZONE
  const referenceDate = resolveReferenceDate(caseRecord)
  const timeOptions = buildPhTimeOptions({ referenceDate, interviewTimeZone })

  return {
    type: 'modal',
    callback_id: 'reschedule_submit',
    private_metadata: caseRecord.id,
    title: plain('🔄 Reschedule Interview'),
    submit: plain('✏️ Review'),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      section(`🕐 Times shown in PH (${PH_TIME_ZONE}). Interview timezone: ${interviewTimeZone}.`),
      section('📝 Calendar descriptions are generated automatically from the updated schedule details.'),
      input('Reason for reschedule', 'reschedule_reason_block', {
        type: 'plain_text_input',
        action_id: 'reschedule_reason',
        multiline: true,
        placeholder: plain('Briefly explain why the schedule needs to change'),
      }),
      input('New interview date', 'date_block', {
        type: 'datepicker',
        action_id: 'date',
        placeholder: plain('Select date'),
      }),
      input('New interview time (PH business hours)', 'time_block', {
        type: 'static_select',
        action_id: 'time',
        placeholder: plain('Select time'),
        options: timeOptions,
      }),
      input(
        'Attendees',
        'guest_block',
        {
          type: 'multi_external_select',
          action_id: 'guest_select',
          min_query_length: 0,
          placeholder: plain('Search active users'),
        },
        true,
      ),
      input('Zoom link', 'zoom_block', {
        type: 'plain_text_input',
        action_id: 'zoom_link',
        initial_value: caseRecord.currentSchedule?.zoomLink || caseRecord.autofill?.zoomLink || '',
      }),
      input(
        'Optional candidate note',
        'candidate_note_block',
        {
          type: 'plain_text_input',
          action_id: 'candidate_note',
          multiline: true,
          placeholder: plain('Anything the candidate should know'),
        },
        true,
      ),
    ],
  };
}

export function rescheduleApprovalModal({ caseRecord, email, recentAudits = [] }) {
  const plainBody = email.plainBody || email.body || ''
  return {
    type: 'modal',
    callback_id: 'reschedule_approval_submit',
    private_metadata: caseRecord.id,
    title: plain('✅ Approve Reschedule'),
    submit: plain('✅ Approve'),
    close: plain('Cancel'),
    blocks: [
      ...caseProgressHeader(caseRecord, recentAudits),
      section(`*${caseTitle(caseRecord)}*`),
      section('✏️ Review this message before updating Calendar and sending the candidate email.'),
      section('📝 Editing is plain text. Formatting is applied automatically when sending.'),
      input('Email subject', 'email_subject_block', {
        type: 'plain_text_input',
        action_id: 'email_subject',
        initial_value: email.subject,
      }),
      input('Email body', 'email_body_block', {
        type: 'plain_text_input',
        action_id: 'email_body',
        multiline: true,
        initial_value: plainBody,
      }),
    ],
  };
}

export function caseMessageBlocks(caseRecord) {
  return [
    header('📋 Scheduling Case'),
    section(caseSummary(caseRecord)),
    section(nextStepText(caseRecord)),
    actions(actionButtonsForCase(caseRecord)),
  ];
}

export function scheduleTrackerModal({ cases = [], filters = {}, scope = 'all', ownerSlackUserId = '', totalCount = 0 }) {
  const rows = cases.slice(0, 8).flatMap((item) => [
    section(caseSummary(item)),
    actions(actionButtonsForCase(item)),
    divider(),
  ])

  if (rows.length > 0) {
    rows.pop()
  }

  return {
    type: 'modal',
    callback_id: 'schedule_tracker_submit',
    private_metadata: JSON.stringify({ ownerSlackUserId }),
    title: plain('📚 Schedule Tracker'),
    submit: plain('🔎 Filter'),
    close: plain('Close'),
    blocks: [
      header('📚 Schedule Tracker'),
      section('Browse scheduled interviews newest-first, then narrow the list with filters.'),
      section('📝 Calendar descriptions are generated automatically, so this tracker is read-only.'),
      input('Scope', 'tracker_scope_block', {
        type: 'static_select',
        action_id: 'tracker_scope',
        placeholder: plain('Choose scope'),
        options: trackerScopeOptions(),
        ...(trackerScopeOption(scope) ? { initial_option: trackerScopeOption(scope) } : {}),
      }),
      input('Candidate', 'tracker_candidate_block', {
        type: 'plain_text_input',
        action_id: 'tracker_candidate',
        placeholder: plain('Name or email'),
        ...(filters.candidate ? { initial_value: filters.candidate } : {}),
      }, true),
      input('Recruiter', 'tracker_recruiter_block', {
        type: 'plain_text_input',
        action_id: 'tracker_recruiter',
        placeholder: plain('Name or email'),
        ...(filters.recruiter ? { initial_value: filters.recruiter } : {}),
      }, true),
      input('Hiring manager', 'tracker_hm_block', {
        type: 'plain_text_input',
        action_id: 'tracker_hm',
        placeholder: plain('Name or email'),
        ...(filters.hiringManager ? { initial_value: filters.hiringManager } : {}),
      }, true),
      input('Date', 'tracker_date_block', {
        type: 'datepicker',
        action_id: 'tracker_date',
        placeholder: plain('Filter by interview date'),
        ...(filters.date ? { initial_date: filters.date } : {}),
      }, true),
      input('Time', 'tracker_time_block', {
        type: 'plain_text_input',
        action_id: 'tracker_time',
        placeholder: plain('HH:MM or part of the time'),
        ...(filters.time ? { initial_value: filters.time } : {}),
      }, true),
      section(`Showing ${cases.length} of ${totalCount} scheduled cases.`),
      ...(rows.length > 0 ? rows : [section('No scheduled cases match the current filters.')]),
    ],
  }
}

function caseListBlocks(cases, emptyText) {
  if (!cases.length) return [section(emptyText)];
  return cases.slice(0, 8).flatMap((item) => [
    section(caseSummary(item)),
    actions(actionButtonsForCase(item, true)),
  ]);
}

function caseSummary(caseRecord) {
  if (isCustomInviteCase(caseRecord)) {
    const customInvite = normalizeCustomInviteMetadata(caseRecord)
    const recipientLines = customInvite.recipients.map((recipient) => {
      const label = recipient.name
        ? `${recipient.name} (${recipient.email})`
        : recipient.email
      const status = customInvite.deliveryStatus[recipient.email]?.status
      return `• ${escapeSlackText(label)}${status ? ` - ${customInviteDeliveryLabel(status)}` : ''}`
    })
    return [
      `*${caseTitle(caseRecord)}*`,
      `Status: *${displayStatus(caseRecord.status)}*`,
      `Recipients (${customInvite.recipients.length}):`,
      ...recipientLines,
      ...(customInvite.meetingLink ? [`Meeting link: ${customInvite.meetingLink}`] : []),
      ...scheduleSummary(caseRecord),
    ].join('\n')
  }

  const applicant = caseRecord.applicant;
  const recruiter = caseRecord.recruiter;
  const hiringManager = caseRecord.hiringManager;
  return [
    `*${caseTitle(caseRecord)}*`,
    `Status: *${displayStatus(caseRecord.status)}*`,
    `👤 Applicant: ${applicant ? applicantLabel(applicant) : 'Missing applicant'}`,
    `👥 Recruiter: ${recruiter ? mentionPerson(recruiter) : 'Missing recruiter'}`,
    ...(hiringManager ? [`👤 Hiring Manager: ${mentionPerson(hiringManager)}`] : []),
    ...scheduleSummary(caseRecord),
    ...resumeSummary(caseRecord),
  ].join('\n');
}

export function actionButtonsForCase(caseRecord, compact = false) {
  const actionMap = {
    open_candidate_message_modal: button(
      compact ? '✉️ Candidate' : '✉️ Prepare candidate message',
      'open_candidate_message_modal',
      undefined,
      caseRecord.id,
    ),
    send_reminder: button(compact ? '🔔 Reminder' : '🔔 Send reminder', 'open_reminder_message_modal', undefined, caseRecord.id),
    view_resume: button(compact ? '📄 Resume' : '📄 View resume', 'view_resume', undefined, caseRecord.id),
    open_finalize_modal: button(compact ? '📅 Create invite' : '📅 Create calendar invite', 'open_finalize_modal', 'primary', caseRecord.id),
    scheduling_open: button(compact ? '📅 Schedule' : '📅 Schedule Interview', 'scheduling_open', 'primary', caseRecord.id),
    open_reschedule_modal: button(
      compact ? '🔄 Reschedule' : '🔄 Reschedule interview',
      'open_reschedule_modal',
      'primary',
      caseRecord.id,
    ),
    cancel_interview: button(compact ? '❌ Cancel' : '❌ Cancel interview', 'cancel_interview', 'danger', caseRecord.id),
    view_calendar_details: button(
      compact ? '📅 Calendar' : '📅 View calendar details',
      'view_calendar_details',
      undefined,
      caseRecord.id,
    ),
    retry_custom_invites: button(
      compact ? 'Retry invitations' : 'Retry unsent invitations',
      'retry_custom_invites',
      'primary',
      caseRecord.id,
    ),
    view_custom_invite_emails: button(
      compact ? 'View emails' : 'View sent emails',
      'view_custom_invite_emails',
      undefined,
      caseRecord.id,
    ),
  }

  return visibleCaseActions(caseRecord).map((actionId) => actionMap[actionId]).filter(Boolean)
}

function nextStepText(caseRecord) {
  if (isCustomInviteCase(caseRecord)) {
    if (isScheduledCase(caseRecord)) {
      return 'Next: view the calendar event or retry any invitation that did not send.'
    }
    return 'Next: choose the event date and time, review the invitation, then create the event.'
  }

  if (caseRecord.status === 'Reschedule Requested') {
    return '🎯 *Next:* approve the updated candidate message to update Calendar and notify the candidate.';
  }
  if (isScheduledCase(caseRecord)) {
    return '🎯 *Next:* send a reminder, view the calendar details, or reschedule if the interview time changes.';
  }
  return '🎯 *Next:* continue the scheduling steps. Uploaded resumes stay attached to the case.';
}

function calendarEventUrl(eventId) {
  if (!eventId || eventId.startsWith('mock-') || eventId.startsWith('pending-')) return null
  return `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eventId)}`
}

export { calendarEventUrl }

function scheduleSummary(caseRecord) {
  const normalized = normalizeCaseSchedule(caseRecord);
  const lines = [];
  if (normalized.currentSchedule?.date || normalized.currentSchedule?.time) {
    const tz = caseRecord.interviewTimezone ? ` (${caseRecord.interviewTimezone})` : '';
    lines.push(`📅 Schedule: ${normalized.currentSchedule.date || 'date TBD'} ${normalized.currentSchedule.time || ''}${tz}`.trim());
  }
  if (caseRecord.calendarEventId) {
    const link = caseRecord.calendarEventHtmlLink || caseRecord.currentSchedule?.htmlLink || calendarEventUrl(caseRecord.calendarEventId);
    if (link) {
      lines.push(`📅 <${link}|Calendar event>`);
    } else {
      lines.push('📅 Calendar event created (link not available)');
    }
  }
  if (caseRecord.interviewWindowStartDate || caseRecord.interviewWindowEndDate) {
    lines.push(
      `🎯 Target window: ${caseRecord.interviewWindowStartDate || 'TBD'} to ${caseRecord.interviewWindowEndDate || 'TBD'}`,
    );
  }
  if (caseRecord.interviewTimezone) {
    lines.push(`🕐 Timezone: ${caseRecord.interviewTimezone}`);
  }
  if (caseRecord.reminderEmail?.kind === 'manual_reminder' && caseRecord.reminderStatus) {
    lines.push(`🔔 Reminder: ${caseRecord.reminderStatus}`);
  }
  if (caseRecord.rescheduleReason) {
    lines.push(`🔄 Last reschedule reason: ${caseRecord.rescheduleReason}`);
  }
  return lines;
}

function resumeSummary(caseRecord) {
  if (!caseRecord.resumeLink) {
    return ['Resume: not linked yet']
  }

  return [`Resume: ${resumeSlackLink(caseRecord)}`]
}

function caseTitle(caseRecord) {
  if (isCustomInviteCase(caseRecord)) {
    return normalizeCustomInviteMetadata(caseRecord).title
  }
  const applicantName = caseRecord.applicant
    ? [caseRecord.applicant.firstName, caseRecord.applicant.lastName].filter(Boolean).join(' ')
    : 'Candidate';
  return `${applicantName} - ${caseRecord.applicant?.jobTitle || 'Interview'}`;
}

function plain(text) {
  return { type: 'plain_text', text: trimForSlack(text, 75) };
}

function mrkdwn(text) {
  return { type: 'mrkdwn', text };
}

function header(text) {
  return { type: 'header', text: plain(text) };
}

function section(text) {
  return { type: 'section', text: mrkdwn(text) };
}

function input(label, blockId, element, optional = false, dispatchAction = false, hint = '') {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    ...(dispatchAction ? { dispatch_action: true } : {}),
    ...(hint ? { hint: { type: 'plain_text', text: trimForSlack(hint, 2000) } } : {}),
    label: plain(label),
    element,
  };
}

function customInviteDeliveryLabel(status) {
  const labels = {
    sent: 'Sent',
    mocked: 'Mocked',
    sending: 'Sending',
    failed: 'Failed',
  }
  return labels[status] || 'Not sent'
}

function escapeSlackText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeSlackCodeBlock(value) {
  return String(value || '').replace(/```/g, "'''")
}

function truncateSlackPreservingWhitespace(value, max) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function dynamicBlockId(base, value) {
  const suffix = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return suffix ? `${base}_${suffix}` : base
}

function stageRequiresHiringManager(stageKey) {
  const normalized = normalizeStageKey(stageKey)
  return normalized === '2nd-interview' || normalized === 'final-interview'
}

function stageRequiresResumeLink(stageKey) {
  return stageRequiresHiringManager(stageKey)
}

function resolveCaseZoomLink(caseRecord) {
  return caseRecord.currentSchedule?.zoomLink ||
    caseRecord.autofill?.zoomLink ||
    caseRecord.recruiter?.zoomLink ||
    ''
}

function recruiterSelectElement({ recruiters, draft }) {
  return {
    type: 'external_select',
    action_id: 'recruiter_select',
    min_query_length: 0,
    placeholder: plain('Search recruiter'),
    ...(draft.recruiterOption ? { initial_option: draft.recruiterOption } : {}),
  }
}

function manualCandidateModeCheckbox(draft) {
  const option = { text: plain('Enter candidate manually'), value: 'manual' }
  return {
    type: 'checkboxes',
    action_id: 'manual_candidate_toggle',
    options: [option],
    ...(draft.manualCandidateMode ? { initial_options: [option] } : {}),
  }
}

function candidateSearchSummary(draft) {
  const count = Number(draft.candidateSearchResultCount || 0)
  const pageSize = Number(draft.candidateSearchPageSize || 20)
  const page = Math.max(0, Number(draft.candidateSearchPage || 0))
  const start = count > 0 ? page * pageSize + 1 : 0
  const end = Math.min(count, (page + 1) * pageSize)
  if (!draft.candidateSearchQuery) return ''
  if (draft.candidateSearchError) return `JazzHR search for "${draft.candidateSearchQuery}" could not continue: ${draft.candidateSearchError}`
  if (draft.candidateSearchSearching && count === 0) {
    return `Searching JazzHR for "${draft.candidateSearchQuery}"...`
  }
  if (count === 0 && draft.candidateSearchComplete) return `No JazzHR candidates found for "${draft.candidateSearchQuery}".`
  if (count === 0) return `Searching JazzHR for "${draft.candidateSearchQuery}"...`
  if (count <= page * pageSize && draft.candidateSearchSearching) {
    return `Searching JazzHR for page ${page + 1} of "${draft.candidateSearchQuery}". Loaded ${count} candidate${count === 1 ? '' : 's'} so far.`
  }
  if (count <= page * pageSize && draft.candidateSearchComplete) {
    return `No more JazzHR candidates found for "${draft.candidateSearchQuery}".`
  }

  const total = draft.candidateSearchComplete ? String(count) : `${count}+`
  const status = draft.candidateSearchSearching ? ' Still searching JazzHR for more results.' : ''
  return `Showing ${start}-${end} of ${total} JazzHR candidate${count === 1 ? '' : 's'} for "${draft.candidateSearchQuery}" on page ${page + 1}.${status} Select a result below or type in the selector to filter this page.`
}

function candidateSearchPaginationButtons(draft) {
  if (!draft.candidateSearchQuery) return []
  const page = Math.max(0, Number(draft.candidateSearchPage || 0))
  const count = Number(draft.candidateSearchResultCount || 0)
  const pageSize = Number(draft.candidateSearchPageSize || 20)
  const hasPrevious = page > 0
  const hasLoadedNext = count > (page + 1) * pageSize
  const hasSearchableNext = !draft.candidateSearchComplete && !draft.candidateSearchError
  return [
    hasPrevious ? button('Previous', 'candidate_search_prev') : null,
    (hasLoadedNext || hasSearchableNext) ? button('Next', 'candidate_search_next') : null,
  ].filter(Boolean)
}

function applicantDetailBlocks(draft) {
  const hasApplicant = Boolean(draft.applicantId);

  if (!hasApplicant) return [];

  const toggleButton = draft.showDetails
    ? button('🔽 Hide candidate details', 'toggle_applicant_details', undefined, 'hide')
    : button('▶️ Show candidate details', 'toggle_applicant_details', undefined, 'show');

  const blocks = [
    { type: 'divider' },
    { type: 'actions', elements: [toggleButton] },
  ];

  if (!draft.showDetails) return blocks;

  // Merge base applicant fields with richer JazzHR detail (detail wins on overlap)
  const applicant = draft.applicant || {};
  const detail = draft.applicantDetail || {};
  const rich = { ...applicant, ...detail };

  const coreLines = [];
  if (rich.email)     coreLines.push(`📧 *Email:* ${rich.email}`);
  if (rich.phone)     coreLines.push(`📞 *Phone:* ${rich.phone}`);
  if (rich.jobTitle)  coreLines.push(`💼 *Position:* ${rich.jobTitle}`);
  if (rich.stage)     coreLines.push(`📊 *Stage:* ${rich.stage}`);
  if (rich.source)    coreLines.push(`📥 *Source:* ${rich.source}`);
  if (rich.applyDate) coreLines.push(`📅 *Applied:* ${rich.applyDate}`);

  if (coreLines.length > 0) {
    blocks.push(section(coreLines.join('\n')));
  } else {
    blocks.push(section('ℹ️ No additional details available for this candidate.'));
  }

  const hasExtended = detail.address ||
    detail.linkedinUrl || detail.education || detail.experience || detail.notes;

  if (!hasExtended && draft.applicant?.jazzhrApplicationId) {
    blocks.push(section('⏳ Loading extended details from JazzHR…'));
  }

  if (detail.address) {
    blocks.push(section(`📍 *Address:* ${detail.address}`));
  }

  if (detail.linkedinUrl) {
    blocks.push(section(`🔗 <${detail.linkedinUrl}|LinkedIn profile>`));
  }

  if (detail.education) {
    blocks.push(section(`🎓 *Education:* ${detail.education}`));
  }

  if (detail.experience) {
    const expPreview = detail.experience.length > 200
      ? detail.experience.slice(0, 200) + '…'
      : detail.experience;
    blocks.push(section(`💪 *Experience:*\n> ${expPreview}`));
  }

  if (typeof detail.notes === 'string' && detail.notes.trim()) {
    const notesPreview = detail.notes.length > 200
      ? detail.notes.slice(0, 200) + '…'
      : detail.notes;
    blocks.push(section(`🗒️ *Notes:*\n> ${notesPreview}`));
  }

  blocks.push({ type: 'divider' });
  return blocks;
}

function actions(elements, blockId) {
  return { type: 'actions', ...(blockId ? { block_id: blockId } : {}), elements };
}

function button(text, actionId, style, value) {
  const payload = {
    type: 'button',
    text: plain(text),
    action_id: actionId,
    ...(style ? { style } : {}),
  };
  if (value !== undefined && value !== null && value !== '') payload.value = value;
  return payload;
}

function trackerScopeOptions() {
  return [
    { text: plain('All scheduled cases'), value: 'all' },
    { text: plain('My scheduled cases'), value: 'my' },
    { text: plain('Team scheduled cases'), value: 'team' },
  ]
}

function trackerScopeOption(scope) {
  return trackerScopeOptions().find((item) => item.value === scope) || trackerScopeOptions()[0]
}

function mentionPerson(person) {
  return personLabel(person);
}

function divider() {
  return { type: 'divider' }
}

function stageSelectOptions(currentKey) {
  return STAGE_OPTIONS.map((stage) => ({
    text: plain(stage.label),
    value: stage.key
  }))
}

function stageSelectOption(key) {
  const normalized = normalizeStageKey(key)
  const stage = STAGE_OPTIONS.find((item) => item.key === normalized)
  if (!stage) return undefined
  return { text: plain(stage.label), value: stage.key }
}

function intakeStageOptions() {
  return STAGE_OPTIONS.map((stage) => ({
    text: plain(stage.label),
    value: stage.key
  }))
}

function optionalPeopleCheckbox(label, actionId, selected) {
  const option = { text: plain(label), value: 'enabled' }
  return {
    type: 'checkboxes',
    action_id: actionId,
    options: [option],
    ...(selected ? { initial_options: [option] } : {}),
  }
}

export function peopleCheckboxOptions(people = [], selectedIds = [], query = '') {
  const byId = new Map((people || []).filter((person) => person?.id).map((person) => [person.id, person]))
  const selected = (selectedIds || []).map((id) => byId.get(id)).filter(Boolean)
  const selectedSet = new Set(selected.map((person) => person.id))
  const normalizedQuery = String(query || '').trim().toLowerCase()
  const remaining = (people || [])
    .filter((person) =>
      person?.id &&
      !selectedSet.has(person.id) &&
      (!normalizedQuery || [person.name, person.email].join(' ').toLowerCase().includes(normalizedQuery))
    )
    .sort((left, right) =>
      String(left.name || left.email || '').localeCompare(String(right.name || right.email || ''))
    )
  return [...selected, ...remaining].slice(0, 10).map(compactPersonCheckboxOption)
}

function peopleCheckboxBlocks({
  label,
  blockId,
  actionId,
  searchBlockId,
  searchActionId,
  searchQuery = '',
  people = [],
  selectedIds = [],
  required = false,
}) {
  const options = peopleCheckboxOptions(people, selectedIds, searchQuery)
  const selectedSet = new Set(selectedIds || [])
  const initialOptions = options.filter((option) => selectedSet.has(option.value))
  const needsSearch = people.length > Math.max(10, selectedIds.length)
  if (people.length === 0) {
    return [
      section(`*${label}*\nSelect a JazzHR role to load available ${label.toLowerCase()}.`),
    ]
  }
  const searchBlock = input(`Search ${label.toLowerCase()}`, searchBlockId, {
    type: 'plain_text_input',
    action_id: searchActionId,
    dispatch_action_config: { trigger_actions_on: ['on_character_entered'] },
    placeholder: plain('Search by name or email'),
    ...(searchQuery ? { initial_value: searchQuery } : {}),
  }, true, true)
  if (options.length === 0) {
    return [
      searchBlock,
      section(`No ${label.toLowerCase()} match "${escapeSlackText(searchQuery)}". Try another name or email.`),
    ]
  }
  return [
    ...(needsSearch ? [searchBlock] : []),
    input(label, blockId, {
      type: 'checkboxes',
      action_id: actionId,
      options,
      ...(initialOptions.length ? { initial_options: initialOptions } : {}),
    }, !required, true, 'Selected people are shown first. You can select up to 10.'),
  ]
}

function compactPersonCheckboxOption(person) {
  return {
    text: plain(person?.name || person?.email || 'Unknown'),
    value: person.id,
    ...(person?.email ? {
      description: plain(person.email),
    } : {}),
  }
}

function uniquePeopleById(people) {
  const seen = new Set()
  return (people || []).filter((person) => {
    if (!person?.id || seen.has(person.id)) return false
    seen.add(person.id)
    return true
  })
}

function recruiterZoomOptions(recruiters = []) {
  const seen = new Set()
  const options = []
  for (const recruiter of recruiters || []) {
    const link = String(recruiter?.zoomLink || '').trim()
    if (!link || seen.has(link)) continue
    seen.add(link)
    options.push({
      text: plain(recruiter.name || link),
      value: link,
      ...(recruiter.email ? { description: plain(recruiter.email) } : {}),
    })
  }
  return options.slice(0, 100)
}

function intakeEventTypeOptions() {
  return [
    { text: plain('1st Interview'), value: '1st-interview' },
    { text: plain('2nd Interview'), value: '2nd-interview' },
    { text: plain('Final Interview'), value: 'final-interview' },
    { text: plain('Job Offer'), value: 'job-offer' },
    { text: plain('Custom Invite'), value: 'custom-invite' },
  ]
}

function isStandardIntakeEvent(eventType) {
  return ['1st-interview', '2nd-interview', 'final-interview', 'job-offer'].includes(eventType)
}

function durationSelectOptions(currentMinutes) {
  const options = []
  for (let minutes = 10; minutes <= 60; minutes += 5) {
    options.push(minutes)
  }
  return options.map((m) => ({
    text: plain(`${m} min`),
    value: String(m)
  }))
}

function durationSelectOption(minutes) {
  return { text: plain(`${minutes} min`), value: String(minutes) }
}

function resolveReferenceDate(caseRecord) {
  return (
    caseRecord.interviewWindowStartDate ||
    caseRecord.selectedInterviewDate ||
    formatDateForInput(new Date(), PH_TIME_ZONE)
  )
}

function buildPhTimeOptions({ referenceDate, interviewTimeZone, stepMinutes = 30 }) {
  const resolvedDate = referenceDate || formatDateForInput(new Date(), PH_TIME_ZONE)
  const startMinutes = parseTimeToMinutes(BUSINESS_DAY_START)
  const endMinutes = parseTimeToMinutes(BUSINESS_DAY_END)
  if (startMinutes === null || endMinutes === null) return []

  const options = []
  for (let minutes = startMinutes; minutes < endMinutes; minutes += stepMinutes) {
    const timeValue = formatMinutesToTime(minutes)
    const phInstant = localDateTimeToUtc(resolvedDate, timeValue, PH_TIME_ZONE)
    const phLabel = formatTimeInTimeZone(phInstant, PH_TIME_ZONE)
    let label = `${phLabel} PH`

    if (interviewTimeZone && interviewTimeZone !== PH_TIME_ZONE) {
      const interviewLabel = formatTimeInTimeZone(phInstant, interviewTimeZone)
      const interviewZone = formatTimeZoneShortName(phInstant, interviewTimeZone)
      const dayOffset = formatDayOffsetLabel(
        formatDateForInput(phInstant, PH_TIME_ZONE),
        formatDateForInput(phInstant, interviewTimeZone)
      )
      label = `${phLabel} PH (${interviewLabel} ${interviewZone}${dayOffset})`
    }

    options.push({ text: plain(label), value: timeValue })
  }

  return options
}

function buildSlotOptionGroups(slots, timeZone) {
  const grouped = groupSlotsByDay(slots, timeZone)
  const optionGroups = []
  const flatOptions = []
  let truncated = false
  let count = 0

  for (const group of grouped) {
    const options = []
    for (const slot of group.slots) {
      if (count >= 100) {
        truncated = true
        break
      }
      const label = formatSlotOptionLabel(slot, timeZone)
      const option = {
        text: plain(label),
        value: slot.start,
        ...(slot.allAvailable ? {} : { description: plain(conflictSummary(slot)) })
      }
      options.push(option)
      flatOptions.push(option)
      count += 1
    }
    if (options.length > 0) {
      optionGroups.push({ label: plain(group.label), options })
    }
    if (truncated) break
  }

  return {
    optionGroups,
    initialOption: flatOptions[0],
    truncated,
  }
}

function groupSlotsByDay(slots, timeZone) {
  const grouped = new Map()
  for (const slot of slots) {
    const dateKey = formatDateForInput(slot.start, timeZone)
    const label = buildDayLabel(slot.start, timeZone)
    if (!grouped.has(dateKey)) {
      grouped.set(dateKey, { dateKey, label, slots: [] })
    }
    grouped.get(dateKey).slots.push(slot)
  }
  return Array.from(grouped.values())
}

function buildDayLabel(dateLike, timeZone) {
  const interviewLabel = formatDateInTimeZone(dateLike, timeZone)
  const phLabel = formatDateInTimeZone(dateLike, PH_TIME_ZONE)
  if (timeZone === PH_TIME_ZONE || interviewLabel === phLabel) return interviewLabel
  return `${interviewLabel} (PH: ${phLabel})`
}

function formatSlotOptionLabel(slot, timeZone) {
  const phLabel = formatTimeInTimeZone(slot.start, PH_TIME_ZONE)
  if (timeZone === PH_TIME_ZONE) return `${phLabel} PH`

  const interviewLabel = formatTimeInTimeZone(slot.start, timeZone)
  const interviewZone = formatTimeZoneShortName(slot.start, timeZone)
  const dayOffset = formatDayOffsetLabel(
    formatDateForInput(slot.start, PH_TIME_ZONE),
    formatDateForInput(slot.start, timeZone)
  )
  return `${phLabel} PH (${interviewLabel} ${interviewZone}${dayOffset})`
}

function parseTimeToMinutes(timeStr) {
  const [hour, minute] = String(timeStr || '').split(':').map((part) => Number(part))
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  return hour * 60 + minute
}

function formatMinutesToTime(minutes) {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function formatDayOffsetLabel(baseDate, targetDate) {
  if (!baseDate || !targetDate || baseDate === targetDate) return ''
  return targetDate > baseDate ? ' +1d' : ' -1d'
}

function includedAttendeeList(attendees) {
  return attendees
    .filter((a) => a.included)
    .map((a) => {
      const roleLabel = a.role.replace(/_/g, ' ')
      return section(`\u2705 ${a.name || a.email} (${roleLabel})`)
    })
}

function conflictSummary(slot) {
  if (!slot.conflicts) return ''
  const entries = Object.entries(slot.conflicts).filter(([, c]) => c.hasConflict)
  if (entries.length === 0) return ''
  const count = entries.length
  return `⚠️ ${count} conflict${count > 1 ? 's' : ''}`
}

const ACTION_LABELS = {
  case_created: 'Case created',
  hm_message_approved: 'Legacy HM review sent',
  hm_availability_saved: 'Legacy availability saved',
  candidate_email_approved: 'Candidate email approved',
  calendar_event_approved: 'Calendar event created',
  calendar_event_updated: 'Calendar updated',
  reminder_sent: 'Reminder sent',
  reminder_rescheduled: 'Reminder re-sent',
  reschedule_requested: 'Reschedule requested',
  reschedule_candidate_message_approved: 'Reschedule approved',
  reschedule_cancelled: 'Interview cancelled',
  resume_viewed: 'Resume viewed',
}

function formatActionLabel(action) {
  return ACTION_LABELS[action] || action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatTimeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(isoString).toLocaleDateString()
}

function caseProgressHeader(caseRecord, recentAudits = []) {
  const shownStatus = displayStatus(caseRecord.status)
  const statusIndex = STATUSES.indexOf(shownStatus)
  const indicator = statusEmoji(caseRecord.status)
  const stepLabel = statusIndex >= 0 ? `(step ${statusIndex + 1} of ${STATUSES.length})` : ''
  const statusText = stepLabel
    ? `*Status:* ${shownStatus}  \`${indicator}\` ${stepLabel}`
    : `*Status:* ${shownStatus}  \`${indicator}\``

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: statusText } },
  ]

  if (recentAudits.length > 0) {
    const last = recentAudits[0]
    const actorRef = last.actorSlackUserId ? 'coordinator' : 'system'
    const elements = [
      { type: 'mrkdwn', text: `📝 *Last:* ${formatActionLabel(last.action)} by ${actorRef} • ${formatTimeAgo(last.at)}` },
    ]
    blocks.push({ type: 'context', elements })
  }

  blocks.push({ type: 'divider' })
  return blocks
}

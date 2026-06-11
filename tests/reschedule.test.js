import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCompletedReschedule,
  applyRescheduleRequest,
  applyScheduledEvent,
  buildScheduleSnapshot,
  canFinalizeSchedule,
  canStartReschedule,
  visibleCaseActions,
} from '../src/workflow/reschedule.js';
import { buildReminderEmail, buildRescheduleEmail } from '../src/workflow/messages.js';
import {
  attendeeInviteRecipients,
  buildAttendeeInviteEmail,
  buildCancellationEmail,
  buildIntakeDraft,
  recoverLiveCandidateSearchSession,
  resolveZoomLinkForRecruiters,
  buildScheduledCandidateEmail,
  buildTemplateVariables,
  ccRecipientsFromAttendees,
  isScheduleWorkflowTrigger,
  mappedHiringManagersForRole,
  mappedRecruitersForRole,
  orderedCheckboxSelection,
  registerSlackHandlers,
  resolveRoleAssignmentsForRole,
  selectableHiringManagersForRole,
} from '../src/slack/handlers.js';
import { actionButtonsForCase, externalAttendeeModal, finalizeEmailPreviewModal, finalizeModal, homeView, intakeModal, peopleCheckboxOptions, rescheduleModal, schedulingModal, scheduleTrackerModal } from '../src/slack/views.js';
import { setApplicants, setRecruiters, setHiringManagers, setJazzhrJobs, setRoleAssignments, setTalentRecruiters } from '../src/data/cache.js';
import { SAMPLE_APPLICANTS, SAMPLE_PEOPLE } from '../src/data/sample-data.js';

const baseCase = {
  id: 'case-1',
  status: 'Draft',
  applicant: {
    firstName: 'Alex',
    lastName: 'Reyes',
    email: 'alex@example.com',
    jobTitle: 'Customer Support Specialist',
  },
  recruiter: {
    name: 'Jamal Al Badi',
    email: 'jamal@example.com',
  },
  hiringManager: {
    name: 'Ana Cruz',
    email: 'ana@example.com',
  },
  autofill: {
    zoomLink: 'https://zoom.us/j/demo',
  },
};

test('scheduled cases show reschedule actions instead of create invite', () => {
  const scheduledCase = {
    ...baseCase,
    status: 'Scheduled',
    calendarEventId: 'event-1',
  };

  const actions = visibleCaseActions(scheduledCase);
  assert.ok(actions.includes('open_reschedule_modal'));
  assert.ok(!actions.includes('open_finalize_modal'));

  const labels = actionButtonsForCase(scheduledCase).map((item) => item.text.text);
  assert.ok(labels.includes('🔄 Reschedule interview'));
  assert.ok(!labels.includes('📅 Create calendar invite'));
});

test('cancelled scheduled cases hide repeat email actions', () => {
  const cancelledCase = {
    ...baseCase,
    status: 'Needs Attention',
    calendarEventId: 'event-1',
    rescheduleStatus: 'cancelled',
    cancellationEmailStatus: 'sent',
  };

  const actions = visibleCaseActions(cancelledCase);
  assert.deepEqual(actions, ['view_calendar_details']);

  const labels = actionButtonsForCase(cancelledCase).map((item) => item.text.text);
  assert.ok(labels.includes('📅 View calendar details'));
  assert.ok(!labels.includes('❌ Cancel interview'));
  assert.ok(!labels.includes('🔔 Send reminder'));
});

test('cases with uploaded resumes show a view resume action', () => {
  const caseWithResume = {
    ...baseCase,
    resumeLink: 'https://example.com/resume.pdf',
  };

  const actions = visibleCaseActions(caseWithResume);
  const labels = actionButtonsForCase(caseWithResume).map((item) => item.text.text);

  assert.ok(actions.includes('view_resume'));
  assert.ok(labels.includes('📄 View resume'));
});

test('final scheduling is rejected after a calendar event exists', () => {
  assert.equal(canFinalizeSchedule(baseCase), true);
  assert.equal(canFinalizeSchedule({ ...baseCase, status: 'Scheduled', calendarEventId: 'event-1' }), false);
});

test('reschedule increments schedule version and preserves existing event id', () => {
  const scheduledPatch = applyScheduledEvent(
    baseCase,
    {
      eventId: 'event-1',
      eventDraft: {},
    },
    buildScheduleSnapshot({
      date: '2026-05-20',
      time: '10:00',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com'],
      eventId: 'event-1',
    }),
  );
  const scheduledCase = { ...baseCase, ...scheduledPatch };
  assert.equal(canStartReschedule(scheduledCase), true);

  const request = {
    actorSlackUserId: 'U1',
    reason: 'Hiring manager conflict',
    date: '2026-05-21',
    time: '11:00',
    zoomLink: 'https://zoom.us/j/demo',
    attendees: ['alex@example.com', 'ana@example.com'],
    email: buildRescheduleEmail(scheduledCase, {
      reason: 'Hiring manager conflict',
      date: '2026-05-21',
      time: '11:00',
      zoomLink: 'https://zoom.us/j/demo',
    }),
  };
  const requestedCase = { ...scheduledCase, ...applyRescheduleRequest(scheduledCase, request) };
  const completed = applyCompletedReschedule(
    requestedCase,
    {
      eventId: 'event-1',
      eventDraft: {},
    },
    request,
    { mocked: true },
  );

  assert.equal(completed.status, 'Scheduled');
  assert.equal(completed.calendarEventId, 'event-1');
  assert.equal(completed.scheduleVersion, 2);
  assert.equal(completed.scheduleHistory.length, 1);
});

test('reschedule candidate email CCs recruiter and involved attendees only', () => {
  const scheduledCase = {
    ...baseCase,
    status: 'Scheduled',
    currentSchedule: buildScheduleSnapshot({
      date: '2026-05-20',
      time: '10:00',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'ana@example.com', 'interviewer@example.com'],
      eventId: 'event-1',
    }),
  };

  assert.deepEqual(
    ccRecipientsFromAttendees(scheduledCase, scheduledCase.currentSchedule.attendees),
    ['jamal@example.com', 'ana@example.com', 'interviewer@example.com'],
  );
});

test('cancellation email is sent to candidate and CCs involved meeting participants', () => {
  const scheduledCase = {
    ...baseCase,
    status: 'Scheduled',
    currentSchedule: buildScheduleSnapshot({
      date: '2026-05-20',
      time: '10:00',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'ana@example.com', 'interviewer@example.com'],
      eventId: 'event-1',
    }),
  };

  const email = buildCancellationEmail(scheduledCase);

  assert.equal(email.to, 'alex@example.com');
  assert.deepEqual(email.cc, ['jamal@example.com', 'ana@example.com', 'interviewer@example.com']);
  assert.match(email.subject, /Interview cancelled/);
  assert.match(email.plainBody, /Your interview for Customer Support Specialist has been cancelled/);
  assert.match(email.plainBody, /Date: 2026-05-20/);
  assert.match(email.plainBody, /Outsourced Pro Global Limited/);
  assert.match(email.htmlBody, /background-color: #f5f5f5/);
  assert.match(email.htmlBody, /Cancelled interview details:/);
  assert.match(email.htmlBody, /<strong>Zoom Link:<\/strong> <a href="https:\/\/zoom\.us\/j\/demo"/);
  assert.match(email.htmlBody, /cid:opg-logo/);
  assert.match(email.htmlBody, /IMPORTANT: The contents of this email/);
});

test('home view buttons do not include empty values', () => {
  const view = homeView({ myCases: [], teamCases: [] });
  const buttonElements = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button');

  assert.ok(buttonElements.length > 0);
  assert.equal(buttonElements.some((button) => button.value === ''), false);
});

test('home view exposes the schedule tracker button', () => {
  const view = homeView({ myCases: [], teamCases: [] });
  const labels = view.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements)
    .filter((element) => element.type === 'button')
    .map((button) => button.text.text);

  assert.ok(labels.includes('📚 Schedule tracker'));
});

test('workflow trigger accepts schedule interview command messages', () => {
  assert.equal(isScheduleWorkflowTrigger('/schedule-interview'), true);
  assert.equal(isScheduleWorkflowTrigger('/schedule-interview button'), true);
  assert.equal(isScheduleWorkflowTrigger('<@U123> /schedule-interview button'), true);
  assert.equal(isScheduleWorkflowTrigger('/slack-scheduler'), false);
  assert.equal(isScheduleWorkflowTrigger('please run /schedule-interview'), false);
});

test('case summaries and progress headers never mention Slack users', () => {
  const caseWithSlackIds = {
    ...baseCase,
    recruiter: {
      ...baseCase.recruiter,
      slackUserId: 'U-REC',
    },
    hiringManager: {
      ...baseCase.hiringManager,
      slackUserId: 'U-HM',
    },
  };
  const home = homeView({ myCases: [caseWithSlackIds], teamCases: [] });
  const finalize = finalizeModal(caseWithSlackIds, [
    {
      action: 'case_created',
      actorSlackUserId: 'U-ACTOR',
      at: new Date().toISOString(),
    },
  ]);

  const text = JSON.stringify([home.blocks, finalize.blocks]);
  assert.equal(text.includes('<@'), false);
  assert.match(text, /Jamal Al Badi/);
  assert.match(text, /Ana Cruz/);
  assert.equal(text.includes('Slack user U-ACTOR'), false);
  assert.match(text, /by coordinator/);
});

test('schedule tracker modal renders scheduled case rows with action buttons', () => {
  const scheduledCase = {
    ...baseCase,
    status: 'Scheduled',
    ownerSlackUserId: 'U123',
    currentSchedule: {
      date: '2026-05-21',
      time: '10:00',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com'],
    },
    calendarEventId: 'event-1',
  };

  const view = scheduleTrackerModal({
    cases: [scheduledCase],
    filters: { candidate: 'Alex' },
    scope: 'all',
    ownerSlackUserId: 'U123',
    totalCount: 1,
  });

  const actionBlocks = view.blocks.filter((block) => block.type === 'actions');
  const labels = actionBlocks.flatMap((block) => block.elements).map((element) => element.text.text);

  assert.ok(view.blocks.some((block) => block.type === 'input' && block.block_id === 'tracker_candidate_block'));
  assert.ok(view.blocks.some((block) => block.type === 'section' && block.text.text.includes('Showing 1 of 1 scheduled cases.')));
  assert.ok(labels.includes('🔄 Reschedule interview'));
  assert.ok(labels.includes('❌ Cancel interview'));
  assert.ok(labels.includes('📅 View calendar details'));
});

test('finalize modal explains that calendar descriptions are generated automatically', () => {
  const view = finalizeModal(baseCase);
  const sectionTexts = view.blocks
    .filter((block) => block.type === 'section')
    .map((block) => block.text.text);

  assert.ok(sectionTexts.some((text) => text.includes('Calendar descriptions are generated automatically')));
});

test('finalize modal prepopulates zoom link from recruiter sheet data when autofill is missing', () => {
  const view = finalizeModal({
    ...baseCase,
    autofill: {},
    recruiter: {
      ...baseCase.recruiter,
      zoomLink: 'https://zoom.us/j/from-sheet',
    },
  });
  const zoomBlock = view.blocks.find((block) => block.block_id === 'zoom_block');

  assert.equal(zoomBlock.element.initial_value, 'https://zoom.us/j/from-sheet');
});

test('finalize modal direct schedule time options start at 7 AM and end before 4 PM PH', () => {
  const view = finalizeModal(baseCase);
  const timeBlock = view.blocks.find((block) => block.block_id === 'time_block');
  const options = timeBlock.element.options;

  assert.equal(options[0].value, '07:00');
  assert.equal(options[options.length - 1].value, '15:30');
});

test('finalize modal includes stage and duration workflow controls', () => {
  const view = finalizeModal({
    ...baseCase,
    stageKey: '2nd-interview',
    stageOverrides: { durationMinutes: 45 },
  });
  const stageBlock = view.blocks.find((block) => block.block_id === 'stage_block');
  const durationBlock = view.blocks.find((block) => block.block_id === 'duration_block');
  const durationValues = durationBlock.element.options.map((option) => option.value);

  assert.equal(stageBlock.element.initial_option.value, '2nd-interview');
  assert.equal(durationBlock.element.initial_option.value, '45');
  assert.deepEqual(durationValues, ['10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60']);
});

test('schedule modal duration options run from 10 to 60 minutes by five', () => {
  const view = schedulingModal(baseCase, {
    stageRules: { typicalDurationMinutes: 30 },
    attendees: [],
    stageKey: '1st-interview',
  });
  const durationBlock = view.blocks.find((block) => block.block_id === 'duration_block');

  assert.deepEqual(
    durationBlock.element.options.map((option) => option.value),
    ['10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60'],
  );
});

test('finalize email preview modal shows formatted email before creating invite', () => {
  const view = finalizeEmailPreviewModal({
    caseRecord: baseCase,
    scheduleInput: {
      startDate: '2026-05-20',
      startTime: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'jamal@example.com'],
    },
    renderedTemplate: {
      subject: 'Interview for Support Specialist',
      plainBody: 'Hi Alex,\n\nDate: 2026-05-20\nTime: 09:30',
      body: '<p>Hi Alex</p>',
    },
  });

  const subjectBlock = view.blocks.find((block) => block.block_id === 'email_subject_block');
  const bodyBlock = view.blocks.find((block) => block.block_id === 'email_body_block');
  const metadata = JSON.parse(view.private_metadata);

  assert.equal(view.callback_id, 'finalize_email_preview_submit');
  assert.equal(view.submit.text, 'Create Invite');
  assert.equal(subjectBlock.element.initial_value, 'Interview for Support Specialist');
  assert.match(bodyBlock.element.initial_value, /Date: 2026-05-20/);
  assert.equal(metadata.caseId, 'case-1');
  assert.equal(metadata.scheduleInput.zoomLink, 'https://zoom.us/j/demo');
});

test('custom invite intake contains only generic event fields', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: 'custom-invite',
      eventTypeOption: { text: { type: 'plain_text', text: 'Custom Invite' }, value: 'custom-invite' },
      customInviteTitle: 'Client intro',
      customInviteRecipientsRaw: 'Alex <alex@example.com>\nteam@example.com',
      customInviteSubject: 'Invitation: Client intro',
      customInviteBody: '[greeting]\n\nJoin [event_title].',
    },
  });

  const inputBlocks = view.blocks.filter((block) => block.type === 'input');
  const blockIds = inputBlocks.map((block) => block.block_id);

  assert.deepEqual(blockIds, [
    'event_type_block',
    'custom_title_block',
    'custom_recipients_block',
    'custom_subject_block',
    'custom_body_block',
    'custom_meeting_link_block',
    'notes_block',
    'timezone_block',
  ])
  assert.doesNotMatch(JSON.stringify(view.blocks), /Candidate|JazzHR|Recruiter|Hiring Manager|Resume|Stage/)
});

test('check availability modal keeps target window fields', () => {
  const view = schedulingModal(baseCase, {
    phase: 1,
    attendees: [],
    stageKey: '1st-interview',
  });
  const inputBlocks = view.blocks.filter((block) => block.type === 'input');
  const blockIds = inputBlocks.map((block) => block.block_id);

  assert.ok(blockIds.includes('schedule_window_start_block'));
  assert.ok(blockIds.includes('schedule_window_end_block'));
});

test('custom invite intake starts with event type and supports multiple recipients', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: 'custom-invite',
      eventTypeOption: { text: { type: 'plain_text', text: 'Custom Invite' }, value: 'custom-invite' },
      customInviteTitle: 'Client intro',
      customInviteRecipientsRaw: 'Alex <alex@example.com>\nteam@example.com',
    },
  });
  const inputBlocks = view.blocks.filter((block) => block.type === 'input');
  const eventTypeBlock = inputBlocks[0];
  const titleBlock = inputBlocks.find((block) => block.block_id === 'custom_title_block');
  const recipientsBlock = inputBlocks.find((block) => block.block_id === 'custom_recipients_block');

  assert.equal(eventTypeBlock.block_id, 'event_type_block');
  assert.deepEqual(eventTypeBlock.element.options.map((option) => option.text.text), [
    '1st Interview',
    '2nd Interview',
    'Final Interview',
    'Job Offer',
    'Custom Invite',
  ]);
  assert.equal(titleBlock.element.initial_value, 'Client intro');
  assert.equal(recipientsBlock.element.multiline, true);
  assert.match(recipientsBlock.element.initial_value, /team@example\.com/);
});

test('intake modal candidate details hides JazzHR resume and rating fields', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      applicantId: 'applicant-demo-1',
      applicantOption: { text: { type: 'plain_text', text: 'Alex Reyes - alex@example.com' }, value: 'applicant-demo-1' },
      showDetails: true,
      applicant: {
        email: 'alex@example.com',
        jobTitle: 'Support Specialist',
      },
      applicantDetail: {
        rating: '5',
        resumeUrl: 'https://jazzhr.example.com/resume',
        resumeText: 'Resume text that should not be shown',
        linkedinUrl: 'https://linkedin.example.com/alex',
      },
    },
  });

  const text = JSON.stringify(view.blocks);
  assert.doesNotMatch(text, /Rating/);
  assert.doesNotMatch(text, /View resume in JazzHR/);
  assert.doesNotMatch(text, /Resume text that should not be shown/);
  assert.match(text, /LinkedIn profile/);
});

test('standard interview intake keeps the resume file upload field', () => {
  const view = intakeModal({
    templates: [
      {
        id: 'demo-template',
        label: 'Demo Template',
        subject: 'Subject',
        body: 'Body',
      },
    ],
    draft: {
      eventType: '1st-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '1st Interview' }, value: '1st-interview' },
    },
  });

  const resumeBlock = view.blocks.find((block) => block.block_id === 'resume_block');
  assert.ok(resumeBlock);
  assert.equal(resumeBlock.element.type, 'file_input');
  assert.equal(resumeBlock.element.action_id, 'resume_file');
  assert.equal(resumeBlock.element.max_files, 1);
  assert.deepEqual(resumeBlock.element.filetypes, ['pdf', 'doc', 'docx']);
  assert.equal(resumeBlock.optional, true);
});

test('custom invite intake omits interview-specific controls', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: 'custom-invite',
      eventTypeOption: { text: { type: 'plain_text', text: 'Custom Invite' }, value: 'custom-invite' },
    },
  });

  const blockIds = view.blocks.map((block) => block.block_id).filter(Boolean)
  for (const blockId of [
    'candidate_search_block',
    'applicant_block',
    'recruiter_block',
    'hm_block',
    'stage_block',
    'resume_block',
  ]) {
    assert.equal(blockIds.includes(blockId), false)
  }
});

test('custom invite meeting link is optional and labeled generically', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: 'custom-invite',
      eventTypeOption: { text: { type: 'plain_text', text: 'Custom Invite' }, value: 'custom-invite' },
    },
  });

  const meetingLinkBlock = view.blocks.find((block) => block.block_id === 'custom_meeting_link_block')
  assert.equal(meetingLinkBlock.label.text, 'Meeting link')
  assert.equal(meetingLinkBlock.optional, true)
  assert.match(meetingLinkBlock.element.placeholder.text, /Zoom, Meet, Teams/)
});

test('standard intake modal uses unified recruiter and hiring manager checkboxes', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: '2nd-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '2nd Interview' }, value: '2nd-interview' },
      stageKey: '2nd-interview',
      roleId: 'job-1',
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
      recruiterId: 'rec-mara',
      hiringManagerId: 'hm-ana',
      recruiterOption: { text: { type: 'plain_text', text: 'Mara Santos' }, value: 'rec-mara' },
      hiringManagerOption: { text: { type: 'plain_text', text: 'Ana Cruz' }, value: 'hm-ana' },
      additionalRecruiterOptions: [
        { text: { type: 'plain_text', text: 'Jamal Al Badi' }, value: 'rec-jam' },
      ],
      additionalHiringManagerOptions: [
        { text: { type: 'plain_text', text: 'Lee Morgan' }, value: 'hm-lee' },
      ],
      showAdditionalRecruiters: true,
      showAdditionalHiringManagers: true,
      selectedRecruiters: [
        { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', zoomLink: 'https://zoom.us/j/mara' },
        { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jam@example.com', zoomLink: 'https://zoom.us/j/jam' },
      ],
      selectedHiringManagers: [
        { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' },
        { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com' },
      ],
      suggestedHiringManagers: [
        { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' },
        { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com' },
      ],
      recruiterIds: ['rec-mara', 'rec-jam'],
      hiringManagerIds: ['hm-ana', 'hm-lee'],
      zoomLink: 'https://zoom.us/j/mara',
      zoomLinkOption: { text: { type: 'plain_text', text: 'Mara Santos' }, value: 'https://zoom.us/j/mara' },
    },
  })

  const inputBlockIds = view.blocks.filter((block) => block.type === 'input').map((block) => block.block_id)
  assert.deepEqual(inputBlockIds.slice(0, 2), ['event_type_block', 'role_block'])
  const recruiterBlock = view.blocks.find((block) => block.block_id === 'recruiters_block')
  const managerBlock = view.blocks.find((block) => block.block_id === 'hiring_managers_block')
  assert.equal(recruiterBlock.element.type, 'checkboxes')
  assert.deepEqual(recruiterBlock.element.initial_options.map((option) => option.value), ['rec-mara', 'rec-jam'])
  assert.equal(managerBlock.element.type, 'checkboxes')
  assert.deepEqual(managerBlock.element.initial_options.map((option) => option.value), ['hm-ana', 'hm-lee'])
  assert.equal(view.blocks.some((block) => block.block_id === 'additional_recruiters_block'), false)
  assert.equal(view.blocks.some((block) => block.block_id === 'additional_hms_block'), false)
  assert.equal(view.blocks.find((block) => block.block_id === 'zoom_choice_block').element.options.length, 2)
  assert.equal(view.blocks.find((block) => block.block_id?.startsWith('zoom_block')).element.initial_value, 'https://zoom.us/j/mara')
  assert.equal(inputBlockIds.includes('stage_block'), false)
  assert.equal(inputBlockIds.includes('recruiter_email_block'), false)
})

test('completed cases hide reschedule cancel and reminder actions', () => {
  const actions = visibleCaseActions({
    ...baseCase,
    status: 'Completed',
    calendarEventId: 'event-1',
    resumeLink: 'https://example.com/resume.pdf',
  })

  assert.deepEqual(actions, ['view_resume', 'view_calendar_details'])
})

test('checkbox options keep selections first and filter remaining people by search', () => {
  const people = [
    { id: 'p-a', name: 'Alex', email: 'alex@example.com' },
    { id: 'p-b', name: 'Blair', email: 'blair@example.com' },
    { id: 'p-c', name: 'Casey', email: 'casey@example.com' },
  ]

  assert.deepEqual(
    peopleCheckboxOptions(people, ['p-c', 'p-a'], 'blair').map((option) => option.value),
    ['p-c', 'p-a', 'p-b'],
  )
  assert.deepEqual(
    orderedCheckboxSelection(['p-c', 'p-a'], ['p-a', 'p-b']),
    ['p-a', 'p-b'],
  )
})

test('checkbox lists expose search for large directories and cap visible options at ten', () => {
  const people = Array.from({ length: 12 }, (_, index) => ({
    id: `person-${index + 1}`,
    name: `Person ${String(index + 1).padStart(2, '0')}`,
    email: `person${index + 1}@example.com`,
  }))
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: '1st-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '1st Interview' }, value: '1st-interview' },
      stageKey: '1st-interview',
      roleId: 'job-1',
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
      recruiterIds: ['person-12', 'person-11'],
      recruiterId: 'person-12',
      selectedRecruiters: [people[11], people[10]],
      availableRecruiters: people,
      recruiterSearchQuery: 'person',
    },
  })

  const search = view.blocks.find((block) => block.block_id === 'recruiter_search_block')
  const checkboxes = view.blocks.find((block) => block.block_id === 'recruiters_block')
  assert.equal(search.element.action_id, 'recruiter_people_search')
  assert.equal(checkboxes.element.options.length, 10)
  assert.deepEqual(checkboxes.element.options.slice(0, 2).map((option) => option.value), ['person-12', 'person-11'])

  const noMatchView = intakeModal({
    templates: [],
    draft: {
      eventType: '1st-interview',
      stageKey: '1st-interview',
      roleId: 'job-1',
      availableRecruiters: people,
      recruiterSearchQuery: 'nobody matches',
    },
  })
  assert.ok(noMatchView.blocks.find((block) => block.block_id === 'recruiter_search_block'))
  assert.match(JSON.stringify(noMatchView.blocks), /No recruiters match/)
})

test('standard hiring manager checkboxes reset when the selected role changes', () => {
  const firstRoleView = intakeModal({
    templates: [],
    draft: {
      eventType: '2nd-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '2nd Interview' }, value: '2nd-interview' },
      stageKey: '2nd-interview',
      roleId: 'job-1',
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
      hiringManagerId: 'hm-ana',
      hiringManagerIds: ['hm-ana'],
      selectedHiringManagers: [{ id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' }],
      suggestedHiringManagers: [{ id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com' }],
    },
  })
  const secondRoleView = intakeModal({
    templates: [],
    draft: {
      eventType: '2nd-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '2nd Interview' }, value: '2nd-interview' },
      stageKey: '2nd-interview',
      roleId: 'job-2',
      roleOption: { text: { type: 'plain_text', text: 'Sales Specialist' }, value: 'job-2' },
      suggestedHiringManagers: [{ id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com' }],
      hiringManagerIds: [],
    },
  })

  const firstHmBlock = firstRoleView.blocks.find((block) => block.block_id === 'hiring_managers_block')
  const secondHmBlock = secondRoleView.blocks.find((block) => block.block_id === 'hiring_managers_block')

  assert.deepEqual(firstHmBlock.element.initial_options.map((option) => option.value), ['hm-ana'])
  assert.equal('initial_options' in secondHmBlock.element, false)
})

test('standard first interview intake omits hiring manager selector', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: '1st-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '1st Interview' }, value: '1st-interview' },
      stageKey: '1st-interview',
      roleId: 'job-1',
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
      recruiterId: 'rec-mara',
      recruiterIds: ['rec-mara'],
      recruiterOption: { text: { type: 'plain_text', text: 'Mara Santos' }, value: 'rec-mara' },
      selectedRecruiters: [
        { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com' },
      ],
      hiringManagerOptions: [
        { text: { type: 'plain_text', text: 'Ana Cruz - ana@example.com' }, value: 'hm-ana' },
      ],
    },
  })

  const inputBlockIds = view.blocks.filter((block) => block.type === 'input').map((block) => block.block_id)
  assert.deepEqual(inputBlockIds.slice(0, 7), [
    'event_type_block',
    'role_block',
    'role_title_block_job-1',
    'recruiters_block',
    'recruiter_name_block_rec-mara',
    'recruiter_email_block_rec-mara',
    'candidate_search_block',
  ])
  assert.equal(inputBlockIds.includes('hm_block'), false)
})

test('intake modal shows remote loading state and editable autofill fields', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      eventType: '2nd-interview',
      eventTypeOption: { text: { type: 'plain_text', text: '2nd Interview' }, value: '2nd-interview' },
      stageKey: '2nd-interview',
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
      recruiterId: 'rec-mara',
      recruiterName: 'Mara Santos',
      recruiterEmail: 'mara@example.com',
      recruiterOption: { text: { type: 'plain_text', text: 'Mara Santos' }, value: 'rec-mara' },
      hiringManagerId: 'hm-ana',
      hiringManagerName: 'Ana Cruz',
      hiringManagerEmail: 'ana@example.com',
      hiringManagerOption: { text: { type: 'plain_text', text: 'Ana Cruz' }, value: 'hm-ana' },
      remoteUpdateStatus: 'loading',
      remoteUpdateMessage: 'Loading candidates from JazzHR.',
    },
  })

  assert.match(JSON.stringify(view.blocks), /Updating form/)
  assert.match(JSON.stringify(view.blocks), /Loading candidates from JazzHR/)
  assert.equal(view.blocks.find((block) => block.block_id === 'role_title_block_job-1').element.initial_value, 'Support Specialist')
  assert.equal(view.blocks.find((block) => block.block_id === 'recruiter_name_block_rec-mara').element.initial_value, 'Mara Santos')
  assert.equal(view.blocks.find((block) => block.block_id === 'recruiter_email_block_rec-mara').element.initial_value, 'mara@example.com')
  assert.equal(view.blocks.find((block) => block.block_id === 'hm_name_block_hm-ana').element.initial_value, 'Ana Cruz')
  assert.equal(view.blocks.find((block) => block.block_id === 'hm_email_block_hm-ana').element.initial_value, 'ana@example.com')
})

test('recruiter Zoom resolution auto-fills one unique link and requires a choice for different links', () => {
  assert.equal(resolveZoomLinkForRecruiters([
    { zoomLink: 'https://zoom.us/j/mara' },
    { zoomLink: 'https://zoom.us/j/mara' },
  ]), 'https://zoom.us/j/mara')
  assert.equal(resolveZoomLinkForRecruiters([
    { zoomLink: 'https://zoom.us/j/mara' },
    { zoomLink: 'https://zoom.us/j/jam' },
  ]), '')
  assert.equal(resolveZoomLinkForRecruiters([{ zoomLink: '' }]), '')
})

test('role mapping uses exact JazzHR job and enriches its hiring lead from recruiter contact data', () => {
  setRoleAssignments([
    {
      roleId: '',
      roleKey: 'junior-valuation-analyst',
      roleTitle: 'Junior Valuation Analyst',
      recruiter: null,
      hiringManager: {
        id: 'hm-veanne',
        name: 'Veanne Reyes',
        email: 'veanne@example.com',
        role: 'hiring_manager',
      },
    },
  ])
  setJazzhrJobs([
    {
      id: 'job-open',
      title: 'Junior Valuation Analyst',
      status: 'Open',
      hiringLeadId: 'user-allen',
    },
  ])
  setRecruiters([
    {
      id: 'rec-user-allen',
      name: 'Allen Guevarra',
      email: 'allen@opglobal.example',
      role: 'recruiter',
    },
  ])
  setTalentRecruiters([
    {
      id: 'sheet-allen',
      name: 'Allen Guevarra',
      email: 'allen@freedom.example',
      role: 'recruiter',
      zoomLink: 'https://zoom.us/j/allen',
    },
  ])

  assert.deepEqual(mappedRecruitersForRole('job-open').map((person) => ({
    id: person.id,
    zoomLink: person.zoomLink,
  })), [{ id: 'sheet-allen', zoomLink: 'https://zoom.us/j/allen' }])
  assert.deepEqual(mappedHiringManagersForRole('job-open').map((person) => person.name), ['Veanne Reyes'])

  setJazzhrJobs([])
})

test('role mapping resolves a unique fuzzy Open Roles title', () => {
  setRoleAssignments([
    {
      roleId: '',
      roleTitle: 'Senior Loan Associate - Parabroker / Senior Credit Specialist',
      hiringManager: {
        id: 'hm-arvind',
        name: 'Arvind Tamilarasan',
        email: 'arvind@example.com',
        role: 'hiring_manager',
      },
    },
  ])
  setJazzhrJobs([
    {
      id: 'job-loans',
      roleId: 'job-loans',
      title: 'Senior Loan Associate Parabroker Senior Credit Spec.',
      status: 'Open',
    },
  ])

  const result = resolveRoleAssignmentsForRole('job-loans')
  assert.equal(result.matchType, 'fuzzy')
  assert.equal(result.matchedTitle, 'Senior Loan Associate - Parabroker / Senior Credit Specialist')
  assert.deepEqual(mappedHiringManagersForRole('job-loans').map((person) => person.name), ['Arvind Tamilarasan'])

  setJazzhrJobs([])
})

test('unmatched roles keep the full manager directory available for manual selection', () => {
  setHiringManagers([
    { id: 'hm-manual', name: 'Manual Manager', email: 'manual@example.com', role: 'hiring_manager' },
  ])
  setRoleAssignments([
    {
      roleId: '',
      roleTitle: 'Completely Different Role',
      hiringManager: { id: 'hm-sheet', name: 'Sheet Manager', email: 'sheet@example.com', role: 'hiring_manager' },
    },
  ])
  setJazzhrJobs([{ id: 'job-unmatched', roleId: 'job-unmatched', title: 'Video Producer', status: 'Open' }])

  assert.deepEqual(mappedHiringManagersForRole('job-unmatched'), [])
  assert.deepEqual(selectableHiringManagersForRole('job-unmatched').map((person) => person.name), ['Manual Manager'])
  setJazzhrJobs([])
})

test('second and final interviews show mapped manager suggestions without selecting them', () => {
  const suggestions = [
    { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
    { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com', role: 'hiring_manager' },
  ]

  for (const eventType of ['2nd-interview', 'final-interview']) {
    const view = intakeModal({
      templates: [],
      draft: {
        eventType,
        eventTypeOption: { text: { type: 'plain_text', text: eventType }, value: eventType },
        stageKey: eventType,
        roleId: 'job-1',
        roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-1' },
        suggestedHiringManagers: suggestions,
        selectedHiringManagers: [],
      },
    })
    const viewText = JSON.stringify(view.blocks)
    const hmBlock = view.blocks.find((block) => block.block_id === 'hiring_managers_block')

    assert.match(viewText, /Suggested hiring managers for this role/)
    assert.match(viewText, /Ana Cruz/)
    assert.match(viewText, /Lee Morgan/)
    assert.match(viewText, /not invited automatically/)
    assert.equal(hmBlock.optional, false)
    assert.equal('initial_options' in hmBlock.element, false)
  }
})

test('second interview submission rejects an unselected suggested manager', async () => {
  setApplicants([
    {
      id: 'candidate-1',
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support Specialist',
    },
  ])
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter' },
      hiringManager: { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
    },
  ])
  setJazzhrJobs([{ id: 'job-1', roleId: 'job-1', title: 'Support Specialist', status: 'Open' }])

  const views = new Map()
  const app = {
    action() {},
    command() {},
    event() {},
    message() {},
    options() {},
    view(id, handler) {
      views.set(id, handler)
    },
  }
  registerSlackHandlers(app, {
    config: {
      slack: {},
      google: {},
      jazzhr: { liveSearch: {} },
      scheduling: { timeZones: ['Asia/Manila'] },
    },
    store: {},
    logger: { info() {}, warn() {}, error() {} },
  })

  let ackPayload
  await views.get('schedule_intake_submit')({
    ack: async (payload) => {
      ackPayload = payload
    },
    body: { user: { id: 'U1' }, view: { private_metadata: '{}' } },
    view: {
      private_metadata: '{}',
      state: {
        values: {
          event_type_block: { event_type_select: { selected_option: { value: '2nd-interview' } } },
          role_block: { role_select: { selected_option: { value: 'job-1' } } },
          recruiter_block: { recruiter_select: { selected_option: { value: 'rec-mara' } } },
          applicant_block: { applicant_select: { selected_option: { value: 'candidate-1' } } },
          zoom_block: { zoom_link: { value: 'https://zoom.us/j/demo' } },
          timezone_block: { timezone_select: { selected_option: { value: 'Asia/Manila' } } },
          resume_block: { resume_file: { files: [{ id: 'F1', permalink: 'https://slack.example/resume' }] } },
        },
      },
    },
    client: {},
  })

  assert.equal(ackPayload.response_action, 'errors')
  assert.match(Object.values(ackPayload.errors).join(' '), /Choose a hiring manager/)
  setJazzhrJobs([])
})

test('role changes clear stale managers while preserving unrelated typed values', () => {
  setJazzhrJobs([{ id: 'job-2', roleId: 'job-2', title: 'Sales Specialist', status: 'Open' }])
  const draft = buildIntakeDraft(
    {
      event_type_block: { event_type_select: { selected_option: { value: 'final-interview' } } },
      notes_block: { notes: { value: 'Keep this scheduling note.' } },
      hm_block_old: { hm_select: { selected_option: { value: 'hm-old' } } },
      hm_email_block_old: { hm_email_override: { value: 'old@example.com' } },
    },
    [],
    {
      roleId: 'job-2',
      roleTitle: 'Sales Specialist',
      hiringManagerIds: [],
      hiringManagerName: '',
      hiringManagerEmail: '',
    },
  )

  assert.equal(draft.roleId, 'job-2')
  assert.equal(draft.notes, 'Keep this scheduling note.')
  assert.deepEqual(draft.hiringManagerIds, [])
  assert.equal(draft.hiringManager, null)
  setJazzhrJobs([])
})

test('job offer hides managers and includes every resolved recruiter only', () => {
  setTalentRecruiters([
    { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter' },
    { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
  ])
  setHiringManagers([
    { id: 'hm-stale', name: 'Stale Manager', email: 'stale@example.com', role: 'hiring_manager' },
  ])
  setRoleAssignments([
    {
      roleId: 'job-offer-role',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter' },
      hiringManager: { id: 'hm-stale', name: 'Stale Manager', email: 'stale@example.com', role: 'hiring_manager' },
    },
    {
      roleId: 'job-offer-role',
      roleTitle: 'Support Specialist',
      recruiter: { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
      hiringManager: null,
    },
  ])
  setJazzhrJobs([
    {
      id: 'job-offer-role',
      roleId: 'job-offer-role',
      title: 'Support Specialist',
      status: 'Open',
    },
  ])

  const draft = buildIntakeDraft({}, [], {
    eventType: 'job-offer',
    roleId: 'job-offer-role',
    roleTitle: 'Support Specialist',
    recruiterIds: ['rec-mara'],
    hiringManagerIds: ['hm-stale'],
    hiringManagerEmail: 'stale@example.com',
    applicantRecord: {
      id: 'candidate-1',
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support Specialist',
    },
  })
  const view = intakeModal({
    templates: [],
    draft: {
      ...draft,
      eventTypeOption: { text: { type: 'plain_text', text: 'Job Offer' }, value: 'job-offer' },
      roleOption: { text: { type: 'plain_text', text: 'Support Specialist' }, value: 'job-offer-role' },
    },
  })
  const inputIds = view.blocks.filter((block) => block.type === 'input').map((block) => block.block_id)
  const viewText = JSON.stringify(view.blocks)

  assert.deepEqual(draft.recruiterIds, ['rec-mara', 'rec-jam'])
  assert.equal(draft.hiringManager, null)
  assert.deepEqual(draft.hiringManagerIds, [])
  assert.deepEqual(draft.extraAttendees.map((attendee) => attendee.email), ['jamal@example.com'])
  assert.match(viewText, /Recruiters/)
  assert.deepEqual(
    view.blocks.find((block) => block.block_id === 'recruiters_block').element.initial_options.map((option) => option.value),
    ['rec-mara', 'rec-jam'],
  )
  assert.doesNotMatch(viewText, /Suggested hiring managers|Stale Manager/)
  assert.equal(inputIds.some((id) => id?.startsWith('hm_')), false)
  assert.equal(inputIds.includes('additional_recruiters_block'), false)

  setJazzhrJobs([])
})

test('builds standard intake draft from mapped role recruiters HMs and Zoom', () => {
  setApplicants(SAMPLE_APPLICANTS)
  setTalentRecruiters([
    {
      id: 'rec-mara',
      name: 'Mara Santos',
      email: 'mara@example.com',
      role: 'recruiter',
      zoomLink: 'https://zoom.us/j/mara',
    },
    {
      id: 'rec-jam',
      name: 'Jamal Al Badi',
      email: 'jamal@example.com',
      role: 'recruiter',
      zoomLink: 'https://zoom.us/j/jam',
    },
  ])
  setHiringManagers([
    {
      id: 'hm-ana',
      name: 'Ana Cruz',
      email: 'ana@example.com',
      role: 'hiring_manager',
    },
    {
      id: 'hm-lee',
      name: 'Lee Morgan',
      email: 'lee@example.com',
      role: 'hiring_manager',
    },
  ])
  setRoleAssignments([
    {
      roleId: 'job-1',
      roleKey: 'job-1',
      roleTitle: 'Customer Support Specialist',
      recruiter: { id: 'rec-mara', name: 'Mara Santos', email: 'mara@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/mara' },
      hiringManager: { id: 'hm-ana', name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
    },
    {
      roleId: 'job-1',
      roleKey: 'job-1',
      roleTitle: 'Customer Support Specialist',
      recruiter: { id: 'rec-jam', name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter', zoomLink: 'https://zoom.us/j/jam' },
      hiringManager: { id: 'hm-lee', name: 'Lee Morgan', email: 'lee@example.com', role: 'hiring_manager' },
    },
  ])

  const draft = buildIntakeDraft(
    {
      event_type_block: { event_type_select: { selected_option: { value: '2nd-interview' } } },
      role_block: { role_select: { selected_option: { value: 'job-1' } } },
      role_title_block: { role_title_override: { value: 'Customer Success Specialist' } },
      recruiter_block: { recruiter_select: { selected_option: { value: 'rec-mara' } } },
      recruiter_name_block: { recruiter_name_override: { value: 'Mara S.' } },
      recruiter_email_block: { recruiter_email_override: { value: 'mara.override@example.com' } },
      additional_recruiters_block: { additional_recruiter_select: { selected_options: [{ value: 'rec-jam' }] } },
      hm_block: { hm_select: { selected_option: { value: 'hm-ana' } } },
      hm_name_block: { hm_name_override: { value: 'Ana C.' } },
      hm_email_block: { hm_email_override: { value: 'ana.override@example.com' } },
      additional_hms_block: { additional_hm_select: { selected_options: [{ value: 'hm-lee' }] } },
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-demo-1' } } },
      applicant_name_block: { applicant_name_override: { value: 'Edited Candidate' } },
      applicant_email_block: { applicant_email: { value: 'edited.candidate@example.com' } },
      applicant_phone_block: { applicant_phone_override: { value: '+61 400 000 000' } },
      zoom_block: { zoom_link: { value: 'https://zoom.us/j/manual' } },
    },
    [],
  )

  assert.equal(draft.eventType, '2nd-interview')
  assert.equal(draft.stageKey, '2nd-interview')
  assert.equal(draft.templateId, '2nd-or-Final-invite')
  assert.equal(draft.roleId, 'job-1')
  assert.equal(draft.roleTitle, 'Customer Success Specialist')
  assert.deepEqual(draft.recruiterIds, ['rec-mara', 'rec-jam'])
  assert.deepEqual(draft.hiringManagerIds, ['hm-ana', 'hm-lee'])
  assert.equal(draft.recruiter.name, 'Mara S.')
  assert.equal(draft.recruiter.email, 'mara.override@example.com')
  assert.equal(draft.hiringManager.name, 'Ana C.')
  assert.equal(draft.hiringManager.email, 'ana.override@example.com')
  assert.equal(draft.applicant.firstName, 'Edited')
  assert.equal(draft.applicant.lastName, 'Candidate')
  assert.equal(draft.applicant.email, 'edited.candidate@example.com')
  assert.equal(draft.applicant.phone, '+61 400 000 000')
  assert.equal(draft.applicant.jobTitle, 'Customer Success Specialist')
  assert.equal(draft.zoomLink, 'https://zoom.us/j/manual')
  assert.deepEqual(draft.extraAttendees.map((attendee) => attendee.email), ['jamal@example.com', 'lee@example.com'])
})

test('builds intake draft emails from selected people and overrides', () => {
  setApplicants(SAMPLE_APPLICANTS);
  const recruiters = SAMPLE_PEOPLE.filter((p) => p.role === 'recruiter');
  const managers = SAMPLE_PEOPLE.filter((p) => p.role === 'hiring_manager');
  setRecruiters(recruiters);
  setHiringManagers(managers);

  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-demo-1' } } },
      recruiter_block: { recruiter_select: { selected_option: { value: 'rec-jam' } } },
      applicant_email_block: { applicant_email: { value: 'custom-applicant@example.com' } },
      'recruiter_email_block_rec-jam': { 'recruiter_email_rec-jam': { value: 'custom-recruiter@example.com' } },
      hm_block: { hm_select: { selected_option: { value: 'hm-ana' } } },
      'hm_email_block_hm-ana': { 'hm_email_hm-ana': { value: 'custom-hm@example.com' } },
      stage_block: { stage_select: { selected_option: { value: 'final-interview' } } },
      notes_block: { notes: { value: 'Notes' } },
      resume_block: {
        resume_file: {
          files: [
            {
              id: 'F123',
              name: 'resume.pdf',
              permalink: 'https://files.slack.com/files-pri/T123-F123/resume.pdf',
            },
          ],
        },
      },
    },
    [
      {
        id: '2nd-or-Final-invite',
        label: '2nd/final interview invite',
        subject: 'Subject',
        body: 'Body',
      },
    ],
  );

  assert.equal(draft.applicantEmail, 'custom-applicant@example.com');
  assert.equal(draft.recruiterEmail, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManagerEmail, 'custom-hm@example.com');
  assert.equal(draft.applicant.email, 'custom-applicant@example.com');
  assert.equal(draft.recruiter.email, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManager.email, 'custom-hm@example.com');
  assert.equal(draft.stageKey, 'final-interview');
  assert.equal(draft.templateId, '2nd-or-Final-invite');
  assert.equal(draft.notes, 'Notes');
  assert.equal(draft.resumeLink, 'https://files.slack.com/files-pri/T123-F123/resume.pdf');
  assert.equal(draft.interviewWindowStartDate, '');
  assert.equal(draft.interviewWindowEndDate, '');
});

test('builds intake draft resume reference from Slack file fallbacks', () => {
  setApplicants(SAMPLE_APPLICANTS);
  setRecruiters([]);
  setHiringManagers([]);

  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-demo-1' } } },
      resume_block: {
        resume_file: {
          files: [
            {
              id: 'F456',
              name: 'resume.docx',
              url_private: 'https://files.slack.com/files-pri/T123-F456/resume.docx',
            },
          ],
        },
      },
    },
    [],
  );

  assert.equal(draft.resumeLink, 'https://files.slack.com/files-pri/T123-F456/resume.docx');
});

test('builds intake draft resume reference from Slack file id when no URL is available', () => {
  setApplicants(SAMPLE_APPLICANTS);
  setRecruiters([]);
  setHiringManagers([]);

  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-demo-1' } } },
      resume_block: {
        resume_file: {
          files: [{ id: 'F789', name: 'resume.pdf' }],
        },
      },
    },
    [],
  );

  assert.equal(draft.resumeLink, 'F789');
});

test('builds generic custom invite draft without applicant or recruiter records', () => {
  setApplicants([]);
  setRecruiters([]);
  setHiringManagers([]);

  const draft = buildIntakeDraft(
    {
      event_type_block: { event_type_select: { selected_option: { value: 'custom-invite' } } },
      custom_title_block: { custom_title: { value: 'Client introduction' } },
      custom_recipients_block: {
        custom_recipients: { value: 'Maria Santos <MARIA@example.com>\nteam@example.com' },
      },
      custom_subject_block: { custom_subject: { value: 'Invitation: [event_title]' } },
      custom_body_block: { custom_body: { value: '[greeting]\n\nJoin us on [date].' } },
      custom_meeting_link_block: { custom_meeting_link: { value: '' } },
    },
    [],
  );

  assert.equal(draft.applicantId, '');
  assert.equal(draft.applicant, null);
  assert.equal(draft.recruiter, null);
  assert.equal(draft.stageKey, null);
  assert.equal(draft.customInviteTitle, 'Client introduction');
  assert.deepEqual(draft.customInviteRecipients, [
    { name: 'Maria Santos', email: 'maria@example.com' },
    { name: '', email: 'team@example.com' },
  ]);
  assert.equal(draft.customInviteMeetingLink, '');
});

test('builds intake draft recruiter from the selected applicant', () => {
  setApplicants([
    {
      id: 'applicant-jazz-1',
      firstName: 'Nina',
      lastName: 'Dela Cruz',
      email: 'nina@example.com',
      jobTitle: 'Support Specialist',
      recruiterId: '123',
    },
  ]);
  setRecruiters([
    {
      id: 'rec-123',
      name: 'Mara Santos',
      email: 'mara@example.com',
      role: 'recruiter',
    },
  ]);
  setHiringManagers([]);

  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-jazz-1' } } },
      manual_applicant_name_block: { manual_applicant_name: { value: 'Stale Manual Name' } },
      manual_applicant_role_block: { manual_applicant_role: { value: 'Stale Role' } },
      applicant_email_block: { applicant_email: { value: '' } },
      recruiter_email_block: { recruiter_email: { value: '' } },
    },
    [],
  );

  assert.equal(draft.recruiterId, '123');
  assert.equal(draft.recruiter.name, 'Mara Santos');
  assert.equal(draft.recruiterEmail, 'mara@example.com');
  assert.equal(draft.recruiterOption.value, 'rec-123');
  assert.equal(draft.recruiterOption.text.text, 'Mara Santos');
  assert.equal(draft.recruiterOption.description.text, 'mara@example.com');
  assert.equal(draft.manualCandidateMode, false);
  assert.equal(draft.manualApplicantName, '');
  assert.equal(draft.applicant.jobTitle, 'Support Specialist');
});

test('builds intake draft selection email from Slack profile override', () => {
  setApplicants([]);
  setRecruiters([
    {
      id: 'U-REC',
      slackUserId: 'U-REC',
      name: 'Local Recruiter',
      email: 'local-recruiter@example.com',
      role: 'recruiter',
    },
  ]);
  setHiringManagers([
    {
      id: 'U-HM',
      slackUserId: 'U-HM',
      name: 'Local HM',
      email: 'local-hm@example.com',
      role: 'hiring_manager',
    },
  ]);

  const draft = buildIntakeDraft(
    {
      stage_block: { stage_select: { selected_option: { value: 'final-interview' } } },
      recruiter_block: { recruiter_select: { selected_option: { value: 'U-REC' } } },
      hm_block: { hm_select: { selected_option: { value: 'U-HM' } } },
      recruiter_email_block: { recruiter_email: { value: 'stale-recruiter@example.com' } },
      hm_email_block: { hm_email: { value: 'stale-hm@example.com' } },
    },
    [],
    {
      recruiter: 'U-REC',
      recruiterPerson: {
        id: 'U-REC',
        slackUserId: 'U-REC',
        name: 'Slack Recruiter',
        email: 'slack-recruiter@example.com',
        role: 'recruiter',
      },
      recruiterEmail: 'slack-recruiter@example.com',
      hiringManager: 'U-HM',
      hiringManagerPerson: {
        id: 'U-HM',
        slackUserId: 'U-HM',
        name: 'Slack HM',
        email: 'slack-hm@example.com',
        role: 'hiring_manager',
      },
      hiringManagerEmail: 'slack-hm@example.com',
    },
  );

  assert.equal(draft.recruiter.name, 'Slack Recruiter');
  assert.equal(draft.recruiterEmail, 'slack-recruiter@example.com');
  assert.equal(draft.hiringManager.name, 'Slack HM');
  assert.equal(draft.hiringManagerEmail, 'slack-hm@example.com');
});

test('builds intake draft ignores stale hidden HM values for 1st interviews', () => {
  setApplicants([]);
  setRecruiters([]);
  setHiringManagers([
    {
      id: 'U-HM',
      slackUserId: 'U-HM',
      name: 'Local HM',
      email: 'local-hm@example.com',
      role: 'hiring_manager',
    },
  ]);

  const draft = buildIntakeDraft(
    {
      stage_block: { stage_select: { selected_option: { value: '1st-interview' } } },
      hm_block: { hm_select: { selected_option: { value: 'U-HM' } } },
      hm_email_block: { hm_email: { value: 'stale-hm@example.com' } },
    },
    [],
  );

  assert.equal(draft.stageKey, '1st-interview');
  assert.equal(draft.hiringManagerId, '');
  assert.equal(draft.hiringManager, null);
  assert.equal(draft.hiringManagerEmail, '');
});

test('finalize form omits additional attendees while reschedule keeps one selector', () => {
  const finalize = finalizeModal(baseCase);
  const reschedule = rescheduleModal({
    ...baseCase,
    status: 'Scheduled',
    calendarEventId: 'event-1',
  });

  const finalizeLabels = finalize.blocks
    .filter((block) => block.type === 'input')
    .map((block) => block.label.text);
  const rescheduleLabels = reschedule.blocks
    .filter((block) => block.type === 'input')
    .map((block) => block.label.text);

  assert.equal(finalizeLabels.includes('Attendees'), false);
  assert.ok(rescheduleLabels.includes('Attendees'));
  assert.equal(finalizeLabels.includes('Internal guests'), false);
  assert.equal(finalizeLabels.includes('External guest emails'), false);
  assert.equal(rescheduleLabels.includes('Internal guests'), false);
  assert.equal(rescheduleLabels.includes('External guest emails'), false);
});

test('add attendee modal fills email and role from selected active user', () => {
  const view = externalAttendeeModal(baseCase, [], {
    attendeeOption: { text: { type: 'plain_text', text: 'Ana Cruz - ana@example.com' }, value: 'hm-ana' },
    email: 'ana@example.com',
    role: 'Operations Manager',
  });

  const attendeeBlock = view.blocks.find((block) => block.block_id === 'attendee_select_block');
  const emailBlock = view.blocks.find((block) => block.block_id === 'ext_email_block');
  const roleBlock = view.blocks.find((block) => block.block_id === 'ext_role_block');

  assert.equal(view.title.text, '➕ Add Attendee');
  assert.equal(attendeeBlock.element.type, 'external_select');
  assert.equal(attendeeBlock.element.action_id, 'attendee_select');
  assert.equal(emailBlock.element.initial_value, 'ana@example.com');
  assert.equal(roleBlock.element.type, 'plain_text_input');
  assert.equal(roleBlock.element.initial_value, 'Operations Manager');
});

test('builds a reminder email from the current schedule', () => {
  const email = buildReminderEmail({
    applicant: {
      firstName: 'Alex',
      email: 'alex@example.com',
      jobTitle: 'Support Specialist',
    },
    recruiter: {
      name: 'Jamal Al Badi',
      email: 'jamal@example.com',
    },
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      durationMinutes: 55,
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
    resumeLink: 'https://example.com/resume.pdf',
  });

  assert.equal(email.to, 'alex@example.com');
  assert.match(email.subject, /Reminder/);
  assert.match(email.body, /2026-05-20/);
  assert.match(email.body, /09:30/);
  assert.match(email.htmlBody, /line-height: 1\.6/);
  assert.match(email.htmlBody, /background-color: #f5f5f5/);
  assert.match(email.htmlBody, /<strong>Interview details:<\/strong>/);
});

test('buildTemplateVariables fills scheduled invite dynamic fields', () => {
  const variables = buildTemplateVariables({
    templateId: '2nd-or-Final-invite',
    stageKey: 'final-interview',
    applicant: {
      firstName: 'Alex',
      jobTitle: 'Support Specialist',
    },
    hiringManager: {
      name: 'Ana Cruz',
      positionTitle: 'Operations Manager',
    },
    recruiter: {
      name: 'Jamal Al Badi',
      phone: '+63 900 111 2222',
    },
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      durationMinutes: 55,
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
    resumeLink: 'https://example.com/resume.pdf',
  });

  assert.equal(variables.applicant_first_name, 'Alex');
  assert.equal(variables.job_title, 'Support Specialist');
  assert.equal(variables.interview_stage, 'Final Interview');
  assert.equal(variables.date, '2026-05-20');
  assert.equal(variables.time, '09:30');
  assert.equal(variables.link, 'https://zoom.us/j/demo');
  assert.equal(variables.hiring_manager_name, 'Ana Cruz');
  assert.equal(variables.position_title, 'Operations Manager');
  assert.equal(variables.interview_duration_minutes, '55');
  assert.equal(variables.interview_duration_text, '55-minute');
  assert.equal(variables.resume_link, '<a href="https://example.com/resume.pdf">[Resume]Support Specialist - Alex</a>');
  assert.equal(variables.resume_link_plain, '[Resume]Support Specialist - Alex: https://example.com/resume.pdf');
  assert.match(variables.guest_list_text, /Alex Reyes: alex@example\.com/);
  assert.match(variables.guest_list_text, /Jamal Al Badi: jamal@example\.com/);
  assert.match(variables.guest_list_text, /Ana Cruz: ana@example\.com/);
  assert.equal(variables.recruiter_phone_line, 'Jamal Al Badi: +63 900 111 2222');
});

test('2nd/final candidate email describes the resume attachment and includes all meeting guests', async () => {
  const email = await buildScheduledCandidateEmail({
    ...baseCase,
    templateId: '2nd-or-Final-invite',
    stageKey: 'final-interview',
    resumeLink: 'https://example.com/resume.pdf',
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
  });

  assert.match(email.body, /The applicant's resume is attached to this email/);
  assert.match(email.plainBody, /The applicant's resume is attached to this email/);
  assert.doesNotMatch(email.body, /files\.slack\.com|example\.com\/resume/);
  assert.match(email.body, /Meeting guests:/);
  assert.match(email.body, /Alex Reyes: alex@example\.com/);
  assert.match(email.body, /Jamal Al Badi: jamal@example\.com/);
  assert.match(email.body, /Ana Cruz: ana@example\.com/);
});

test('1st interview candidate email includes all meeting guests', async () => {
  const email = await buildScheduledCandidateEmail({
    ...baseCase,
    templateId: '1st-interview-invite',
    stageKey: '1st-interview',
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
  });

  assert.match(email.body, /Meeting guests:/);
  assert.match(email.body, /Alex Reyes: alex@example\.com/);
  assert.match(email.body, /Jamal Al Badi: jamal@example\.com/);
  assert.match(email.body, /Ana Cruz: ana@example\.com/);
});

test('scheduled candidate email renders selected duration from stage overrides', async () => {
  const email = await buildScheduledCandidateEmail({
    ...baseCase,
    templateId: '1st-interview-invite',
    stageKey: '1st-interview',
    stageOverrides: { durationMinutes: 25 },
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
    },
  });

  assert.match(email.body, /25-minute Zoom first interview/);
  assert.doesNotMatch(email.body, /15-20 minute/);
});

test('reschedule and reminder emails include stored schedule duration', () => {
  const scheduledCase = {
    ...baseCase,
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      durationMinutes: 40,
    },
  };
  const reschedule = buildRescheduleEmail(scheduledCase, {
    reason: 'Conflict',
    date: '2026-05-21',
    time: '10:00',
    zoomLink: 'https://zoom.us/j/demo',
    durationMinutes: 40,
    note: 'Candidate asked for this note to be included',
  });
  const reminder = buildReminderEmail(scheduledCase);

  assert.match(reschedule.plainBody, /Duration: 40 minutes/);
  assert.doesNotMatch(reschedule.plainBody, /Additional note/);
  assert.doesNotMatch(reschedule.htmlBody, /Additional note/);
  assert.doesNotMatch(reschedule.htmlBody, /Candidate asked for this note to be included/);
  assert.match(reminder.plainBody, /Duration: 40 minutes/);
  assert.match(reschedule.htmlBody, /background-color: #f5f5f5/);
  assert.match(reschedule.htmlBody, /<strong>Duration:<\/strong> 40 minutes/);
  assert.match(reminder.htmlBody, /<strong>Duration:<\/strong> 40 minutes/);
});

test('buildTemplateVariables falls back to recruiter and coordinator emails without recruiter phone', () => {
  const variables = buildTemplateVariables({
    recruiter: {
      name: 'Jamal Al Badi',
      email: 'jamal@example.com',
    },
    autofill: {
      coordinatorEmail: 'coordinator@example.com',
    },
  });

  assert.equal(variables.recruiter_phone_line, 'Jamal Al Badi: jamal@example.com | Coordinator: coordinator@example.com');
});

test('buildTemplateVariables renders recruiter phone first and includes coordinator fallback', () => {
  const variables = buildTemplateVariables({
    recruiter: {
      name: 'Jamal Al Badi',
      email: 'jamal@example.com',
      phone: '+63 900 111 2222',
    },
    autofill: {
      coordinatorEmail: 'coordinator@example.com',
    },
  });

  assert.equal(variables.recruiter_phone_line, 'Jamal Al Badi: +63 900 111 2222 | Coordinator: coordinator@example.com');
});

test('attendee invite emails are personalized and exclude candidate and recruiter', () => {
  const caseRecord = {
    ...baseCase,
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
  };

  const recipients = attendeeInviteRecipients(caseRecord);
  const email = buildAttendeeInviteEmail(caseRecord, recipients[0]);
  const variables = buildTemplateVariables(caseRecord);

  assert.deepEqual(recipients.map((recipient) => recipient.email), ['ana@example.com']);
  assert.deepEqual(variables.recruiter_phone_line, 'Jamal Al Badi: jamal@example.com');
  assert.equal(email.to, 'ana@example.com');
  assert.match(email.plainBody, /Hi Ana Cruz/);
  assert.match(email.plainBody, /Alex Reyes/);
  assert.match(email.plainBody, /Support Specialist/);
  assert.match(email.plainBody, /https:\/\/zoom\.us\/j\/demo/);
  assert.match(email.plainBody, /Outsourced Pro Global Limited/);
  assert.match(email.htmlBody, /background-color: #f5f5f5/);
  assert.match(email.htmlBody, /<strong>Interview details:<\/strong>/);
  assert.match(email.htmlBody, /cid:opg-logo/);
});

test('candidate live search restart recovers a missing pagination session', () => {
  const events = [];
  const liveCandidateSearch = {
    get(sessionId) {
      assert.equal(sessionId, 'missing-session');
      return null;
    },
    start({ query, userId }) {
      return {
        id: 'new-session',
        query,
        userId,
        pageSize: 20,
        resultCount: 0,
        complete: false,
        error: '',
      };
    },
  };

  const session = recoverLiveCandidateSearchSession({
    liveCandidateSearch,
    sessionId: 'missing-session',
    query: 'j',
    userId: 'U123',
    requestedPage: 1,
    logger: {
      warn(event, data) {
        events.push({ event, data });
      },
    },
  });

  assert.equal(session.id, 'new-session');
  assert.equal(session.query, 'j');
  assert.deepEqual(events, [{
    event: 'candidate_live_search_session_restarted',
    data: {
      previousSessionId: 'missing-session',
      sessionId: 'new-session',
      query: 'j',
      requestedPage: 1,
    },
  }]);
});

test('scheduled candidate email cc includes recruiter and attendee recipients', async () => {
  const email = await buildScheduledCandidateEmail({
    ...baseCase,
    templateId: '1st-interview-invite',
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
      attendees: ['alex@example.com', 'jamal@example.com', 'ana@example.com'],
      attendeeDetails: [
        { name: 'Alex Reyes', email: 'alex@example.com', role: 'candidate' },
        { name: 'Jamal Al Badi', email: 'jamal@example.com', role: 'recruiter' },
        { name: 'Ana Cruz', email: 'ana@example.com', role: 'hiring_manager' },
      ],
    },
  });

  assert.equal(email.to, 'alex@example.com');
  assert.deepEqual(email.cc, ['jamal@example.com', 'ana@example.com']);
});

test('slack case views hide backend application id and show calendar link', () => {
  const view = homeView({
    myCases: [{
      ...baseCase,
      status: 'Scheduled',
      calendarEventId: 'event-1',
      calendarEventHtmlLink: 'https://calendar.google.com/event?eid=abc',
      applicant: {
        ...baseCase.applicant,
        jazzhrApplicationId: 'backend-only-id',
      },
      currentSchedule: {
        date: '2026-05-20',
        time: '09:30',
      },
    }],
    teamCases: [],
  });

  const text = JSON.stringify(view.blocks);
  assert.doesNotMatch(text, /Application ID:/);
  assert.doesNotMatch(text, /backend-only-id/);
  assert.match(text, /Calendar event/);
  assert.match(text, /https:\/\/calendar\.google\.com\/event\?eid=abc/);
});

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
  buildScheduledCandidateEmail,
  buildTemplateVariables,
  ccRecipientsFromAttendees,
} from '../src/slack/handlers.js';
import { actionButtonsForCase, externalAttendeeModal, finalizeEmailPreviewModal, finalizeModal, homeView, intakeModal, rescheduleModal, schedulingModal, scheduleTrackerModal } from '../src/slack/views.js';
import { setApplicants, setRecruiters, setHiringManagers } from '../src/data/cache.js';
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

test('intake modal includes optional target window fields', () => {
  const view = intakeModal({
    templates: [
      {
        id: 'demo-template',
        label: 'Demo Template',
        subject: 'Subject',
        body: 'Body',
      },
    ],
  });

  const inputBlocks = view.blocks.filter((block) => block.type === 'input');
  const blockIds = inputBlocks.map((block) => block.block_id);

  assert.ok(blockIds.includes('window_start_block'));
  assert.ok(blockIds.includes('window_end_block'));
  assert.equal(inputBlocks.find((block) => block.block_id === 'window_start_block').optional, true);
  assert.equal(inputBlocks.find((block) => block.block_id === 'window_end_block').optional, true);
});

test('intake modal uses stage selection instead of template selection', () => {
  const view = intakeModal({ templates: [] });
  const inputBlocks = view.blocks.filter((block) => block.type === 'input');
  const stageBlock = inputBlocks.find((block) => block.block_id === 'stage_block');

  assert.ok(stageBlock);
  assert.equal(stageBlock.label.text, 'Stage');
  assert.equal(stageBlock.element.action_id, 'stage_select');
  assert.equal(stageBlock.dispatch_action, true);
  assert.deepEqual(stageBlock.element.options.map((option) => option.text.text), [
    '1st Interview',
    '2nd Interview',
    'Final Interview',
  ]);
  assert.equal(inputBlocks.some((block) => block.block_id === 'template_block'), false);
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

test('intake modal includes a resume link field', () => {
  const view = intakeModal({
    templates: [
      {
        id: 'demo-template',
        label: 'Demo Template',
        subject: 'Subject',
        body: 'Body',
      },
    ],
  });

  const resumeBlock = view.blocks.find((block) => block.block_id === 'resume_block');
  assert.ok(resumeBlock);
  assert.equal(resumeBlock.element.type, 'plain_text_input');
  assert.equal(resumeBlock.element.action_id, 'resume_link');
  assert.equal(resumeBlock.optional, true);
});

test('intake modal hides HM fields before a later-stage interview is selected', () => {
  const recruiters = SAMPLE_PEOPLE.filter((p) => p.role === 'recruiter');
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
      applicantOption: { text: { type: 'plain_text', text: 'Alex Reyes - alex@example.com' }, value: 'applicant-demo-1' },
      applicantEmail: 'alex@example.com',
      recruiterOption: { text: { type: 'plain_text', text: 'Jamal Al Badi - jamal@example.com' }, value: 'rec-jam' },
      recruiterEmail: 'jamal@example.com',
    },
    recruiters,
  });

  const applicantNameBlock = view.blocks.find((block) => block.block_id === 'applicant_block');
  const manualApplicantNameBlock = view.blocks.find((block) => block.block_id === 'manual_applicant_name_block');
  const applicantEmailBlock = view.blocks.find((block) => block.block_id === 'applicant_email_block');
  const recruiterNameBlock = view.blocks.find((block) => block.block_id === 'recruiter_block');
  const recruiterEmailBlock = view.blocks.find((block) => block.block_id === 'recruiter_email_block');
  const hmNameBlock = view.blocks.find((block) => block.block_id === 'hm_block');
  const hmEmailBlock = view.blocks.find((block) => block.block_id === 'hm_email_block');

  assert.equal(applicantNameBlock.element.type, 'external_select');
  assert.equal(applicantNameBlock.optional, true);
  assert.equal(manualApplicantNameBlock.element.type, 'plain_text_input');
  assert.equal(manualApplicantNameBlock.element.action_id, 'manual_applicant_name');
  assert.equal(manualApplicantNameBlock.optional, true);
  assert.equal(recruiterNameBlock.element.type, 'external_select');
  assert.equal(applicantEmailBlock.element.type, 'plain_text_input');
  assert.equal(applicantEmailBlock.element.initial_value, 'alex@example.com');
  assert.equal(recruiterEmailBlock.element.initial_value, 'jamal@example.com');
  assert.equal(hmNameBlock, undefined);
  assert.equal(hmEmailBlock, undefined);
  assert.equal(applicantNameBlock.element.initial_option.value, 'applicant-demo-1');
  assert.equal(recruiterNameBlock.element.initial_option.value, 'rec-jam');
});

test('intake modal requires HM fields and resume link for later-stage interviews', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      stageKey: 'final-interview',
      stageOption: { text: { type: 'plain_text', text: 'Final Interview' }, value: 'final-interview' },
      hiringManagerId: 'hm-ana',
      hiringManagerOption: { text: { type: 'plain_text', text: 'Ana Cruz - ana@example.com' }, value: 'hm-ana' },
      hiringManagerEmail: 'ana@example.com',
    },
  });

  const hmNameBlock = view.blocks.find((block) => block.block_id === 'hm_block');
  const hmEmailBlock = view.blocks.find((block) => block.block_id === 'hm_email_block_hm-ana');
  const resumeBlock = view.blocks.find((block) => block.block_id === 'resume_block');

  assert.equal(hmNameBlock.element.type, 'external_select');
  assert.equal(hmNameBlock.optional, false);
  assert.equal(hmEmailBlock.element.type, 'plain_text_input');
  assert.equal(hmEmailBlock.optional, false);
  assert.equal(hmNameBlock.element.initial_option.value, 'hm-ana');
  assert.equal(resumeBlock.element.type, 'plain_text_input');
  assert.equal(resumeBlock.element.action_id, 'resume_link');
  assert.equal(resumeBlock.optional, false);
});

test('intake modal refreshes recruiter and HM email fields after selection', () => {
  const view = intakeModal({
    templates: [],
    draft: {
      stageKey: 'final-interview',
      recruiterId: 'rec-jam',
      recruiterOption: { text: { type: 'plain_text', text: 'Jamal Al Badi - jamal@example.com' }, value: 'rec-jam' },
      recruiterEmail: 'jamal@example.com',
      hiringManagerId: 'hm-ana',
      hiringManagerOption: { text: { type: 'plain_text', text: 'Ana Cruz - ana@example.com' }, value: 'hm-ana' },
      hiringManagerEmail: 'ana@example.com',
    },
  });

  const recruiterEmailBlock = view.blocks.find((block) => block.block_id === 'recruiter_email_block_rec-jam');
  const hmEmailBlock = view.blocks.find((block) => block.block_id === 'hm_email_block_hm-ana');

  assert.equal(recruiterEmailBlock.block_id, 'recruiter_email_block_rec-jam');
  assert.equal(recruiterEmailBlock.element.action_id, 'recruiter_email_rec-jam');
  assert.equal(recruiterEmailBlock.element.initial_value, 'jamal@example.com');
  assert.equal(hmEmailBlock.block_id, 'hm_email_block_hm-ana');
  assert.equal(hmEmailBlock.element.action_id, 'hm_email_hm-ana');
  assert.equal(hmEmailBlock.element.initial_value, 'ana@example.com');
});

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
      applicant_email_block: { applicant_email: { value: '' } },
      'recruiter_email_block_rec-jam': { 'recruiter_email_rec-jam': { value: 'custom-recruiter@example.com' } },
      hm_block: { hm_select: { selected_option: { value: 'hm-ana' } } },
      'hm_email_block_hm-ana': { 'hm_email_hm-ana': { value: 'custom-hm@example.com' } },
      stage_block: { stage_select: { selected_option: { value: 'final-interview' } } },
      notes_block: { notes: { value: 'Notes' } },
      resume_block: { resume_link: { value: 'https://example.com/resume.pdf' } },
      window_start_block: { window_start: { selected_date: '2026-05-20' } },
      window_end_block: { window_end: { selected_date: '2026-05-21' } },
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

  assert.equal(draft.applicantEmail, 'alex.reyes@example.com');
  assert.equal(draft.recruiterEmail, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManagerEmail, 'custom-hm@example.com');
  assert.equal(draft.applicant.email, 'alex.reyes@example.com');
  assert.equal(draft.recruiter.email, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManager.email, 'custom-hm@example.com');
  assert.equal(draft.stageKey, 'final-interview');
  assert.equal(draft.templateId, '2nd-or-Final-invite');
  assert.equal(draft.notes, 'Notes');
  assert.equal(draft.resumeLink, 'https://example.com/resume.pdf');
  assert.equal(draft.interviewWindowStartDate, '2026-05-20');
  assert.equal(draft.interviewWindowEndDate, '2026-05-21');
});

test('builds intake draft from a manually entered candidate name', () => {
  setApplicants([]);
  setRecruiters([]);
  setHiringManagers([]);

  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: null } },
      manual_applicant_name_block: { manual_applicant_name: { value: 'Maria Santos' } },
      applicant_email_block: { applicant_email: { value: 'maria@example.com' } },
      stage_block: { stage_select: { selected_option: { value: '1st-interview' } } },
    },
    [],
  );

  assert.equal(draft.applicantId, '');
  assert.equal(draft.manualApplicantName, 'Maria Santos');
  assert.equal(draft.applicant.firstName, 'Maria');
  assert.equal(draft.applicant.lastName, 'Santos');
  assert.equal(draft.applicant.email, 'maria@example.com');
  assert.equal(draft.applicant.source, 'Manual entry');
  assert.equal(draft.applicantEmail, 'maria@example.com');
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
      applicant_email_block: { applicant_email: { value: '' } },
      recruiter_email_block: { recruiter_email: { value: '' } },
    },
    [],
  );

  assert.equal(draft.recruiterId, '123');
  assert.equal(draft.recruiter.name, 'Mara Santos');
  assert.equal(draft.recruiterEmail, 'mara@example.com');
  assert.equal(draft.recruiterOption.value, 'rec-123');
  assert.equal(draft.recruiterOption.text.text, 'Mara Santos - mara@example.com');
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

test('finalize and reschedule forms use a single attendees selector', () => {
  const finalize = finalizeModal(baseCase);
  const reschedule = rescheduleModal({
    ...baseCase,
    status: 'Scheduled',
    calendarEventId: 'event-1',
  });

  for (const view of [finalize, reschedule]) {
    const labels = view.blocks
      .filter((block) => block.type === 'input')
      .map((block) => block.label.text);

    assert.ok(labels.includes('Attendees'));
    assert.equal(labels.includes('Internal guests'), false);
    assert.equal(labels.includes('External guest emails'), false);
  }
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
  assert.equal(variables.resume_link, 'https://example.com/resume.pdf');
  assert.match(variables.guest_list_text, /Alex Reyes: alex@example\.com/);
  assert.match(variables.guest_list_text, /Jamal Al Badi: jamal@example\.com/);
  assert.match(variables.guest_list_text, /Ana Cruz: ana@example\.com/);
  assert.equal(variables.recruiter_phone_line, 'Jamal Al Badi: +63 900 111 2222');
});

test('2nd/final candidate email includes resume link and all meeting guests', async () => {
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

  assert.match(email.body, /Resume: https:\/\/example\.com\/resume\.pdf/);
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

  assert.match(email.body, /25-minute Zoom chat/);
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
  });
  const reminder = buildReminderEmail(scheduledCase);

  assert.match(reschedule.plainBody, /Duration: 40 minutes/);
  assert.match(reminder.plainBody, /Duration: 40 minutes/);
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
  assert.match(email.htmlBody, /cid:opg-logo/);
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

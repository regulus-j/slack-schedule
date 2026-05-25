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
import { buildIntakeDraft, buildTemplateVariables } from '../src/slack/handlers.js';
import { actionButtonsForCase, externalAttendeeModal, finalizeModal, homeView, intakeModal, rescheduleModal, scheduleTrackerModal } from '../src/slack/views.js';
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

test('intake modal includes a resume file upload field', () => {
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
  assert.equal(resumeBlock.element.type, 'file_input');
  assert.equal(resumeBlock.element.action_id, 'resume_file');
  assert.deepEqual(resumeBlock.element.filetypes, ['pdf', 'doc', 'docx']);
  assert.equal(resumeBlock.element.max_files, 1);
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
  const applicantEmailBlock = view.blocks.find((block) => block.block_id === 'applicant_email_block');
  const recruiterNameBlock = view.blocks.find((block) => block.block_id === 'recruiter_block');
  const recruiterEmailBlock = view.blocks.find((block) => block.block_id === 'recruiter_email_block');
  const hmNameBlock = view.blocks.find((block) => block.block_id === 'hm_block');
  const hmEmailBlock = view.blocks.find((block) => block.block_id === 'hm_email_block');

  assert.equal(applicantNameBlock.element.type, 'external_select');
  assert.equal(recruiterNameBlock.element.type, 'external_select');
  assert.equal(applicantEmailBlock.element.type, 'plain_text_input');
  assert.equal(applicantEmailBlock.element.initial_value, 'alex@example.com');
  assert.equal(recruiterEmailBlock.element.initial_value, 'jamal@example.com');
  assert.equal(hmNameBlock, undefined);
  assert.equal(hmEmailBlock, undefined);
  assert.equal(applicantNameBlock.element.initial_option.value, 'applicant-demo-1');
  assert.equal(recruiterNameBlock.element.initial_option.value, 'rec-jam');
});

test('intake modal requires HM fields and resume upload for later-stage interviews', () => {
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
  assert.equal(resumeBlock.element.type, 'file_input');
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
      resume_block: { resume_file: { files: [{ id: 'F123', url_private: 'https://files.slack.com/resume.pdf' }] } },
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
  assert.equal(draft.resumeLink, 'https://files.slack.com/resume.pdf');
  assert.equal(draft.interviewWindowStartDate, '2026-05-20');
  assert.equal(draft.interviewWindowEndDate, '2026-05-21');
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
    },
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
    currentSchedule: {
      date: '2026-05-20',
      time: '09:30',
      zoomLink: 'https://zoom.us/j/demo',
    },
  });

  assert.equal(variables.applicant_first_name, 'Alex');
  assert.equal(variables.job_title, 'Support Specialist');
  assert.equal(variables.interview_stage, 'Final Interview');
  assert.equal(variables.date, '2026-05-20');
  assert.equal(variables.time, '09:30');
  assert.equal(variables.link, 'https://zoom.us/j/demo');
  assert.equal(variables.hiring_manager_name, 'Ana Cruz');
  assert.equal(variables.position_title, 'Operations Manager');
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

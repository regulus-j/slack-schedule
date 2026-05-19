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
import { buildIntakeDraft } from '../src/slack/handlers.js';
import { actionButtonsForCase, homeView, intakeModal } from '../src/slack/views.js';

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
  assert.ok(labels.includes('Reschedule interview'));
  assert.ok(!labels.includes('Create calendar invite'));
});

test('cases with uploaded resumes show a view resume action', () => {
  const caseWithResume = {
    ...baseCase,
    resumeLink: 'https://example.com/resume.pdf',
  };

  const actions = visibleCaseActions(caseWithResume);
  const labels = actionButtonsForCase(caseWithResume).map((item) => item.text.text);

  assert.ok(actions.includes('view_resume'));
  assert.ok(labels.includes('View resume'));
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
  assert.equal(resumeBlock.optional, true);
});

test('intake modal separates person names from emails', () => {
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
      hiringManagerOption: { text: { type: 'plain_text', text: 'Ana Cruz - ana@example.com' }, value: 'hm-ana' },
      hiringManagerEmail: 'ana@example.com',
    },
  });

  const applicantNameBlock = view.blocks.find((block) => block.block_id === 'applicant_block');
  const applicantEmailBlock = view.blocks.find((block) => block.block_id === 'applicant_email_block');
  const recruiterNameBlock = view.blocks.find((block) => block.block_id === 'recruiter_block');
  const recruiterEmailBlock = view.blocks.find((block) => block.block_id === 'recruiter_email_block');
  const hmNameBlock = view.blocks.find((block) => block.block_id === 'hm_block');
  const hmEmailBlock = view.blocks.find((block) => block.block_id === 'hm_email_block');

  assert.equal(applicantNameBlock.element.type, 'external_select');
  assert.equal(applicantEmailBlock.element.type, 'plain_text_input');
  assert.equal(applicantEmailBlock.element.initial_value, 'alex@example.com');
  assert.equal(recruiterEmailBlock.element.initial_value, 'jamal@example.com');
  assert.equal(hmEmailBlock.element.initial_value, 'ana@example.com');
  assert.equal(applicantNameBlock.element.initial_option.value, 'applicant-demo-1');
  assert.equal(recruiterNameBlock.element.initial_option.value, 'rec-jam');
  assert.equal(hmNameBlock.element.initial_option.value, 'hm-ana');
});

test('builds intake draft emails from selected people and overrides', () => {
  const draft = buildIntakeDraft(
    {
      applicant_block: { applicant_select: { selected_option: { value: 'applicant-demo-1' } } },
      recruiter_block: { recruiter_select: { selected_option: { value: 'rec-jam' } } },
      hm_block: { hm_select: { selected_option: { value: 'hm-ana' } } },
      applicant_email_block: { applicant_email: { value: '' } },
      recruiter_email_block: { recruiter_email: { value: 'custom-recruiter@example.com' } },
      hm_email_block: { hm_email: { value: '' } },
      template_block: { template_select: { selected_option: { value: 'demo-template' } } },
      notes_block: { notes: { value: 'Notes' } },
      resume_block: { resume_link: { value: 'https://example.com/resume.pdf' } },
      window_start_block: { window_start: { selected_date: '2026-05-20' } },
      window_end_block: { window_end: { selected_date: '2026-05-21' } },
    },
    [
      {
        id: 'demo-template',
        label: 'Demo Template',
        subject: 'Subject',
        body: 'Body',
      },
    ],
  );

  assert.equal(draft.applicantEmail, 'alex.reyes@example.com');
  assert.equal(draft.recruiterEmail, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManagerEmail, 'ana.cruz@example.com');
  assert.equal(draft.applicant.email, 'alex.reyes@example.com');
  assert.equal(draft.recruiter.email, 'custom-recruiter@example.com');
  assert.equal(draft.hiringManager.email, 'ana.cruz@example.com');
  assert.equal(draft.templateId, 'demo-template');
  assert.equal(draft.notes, 'Notes');
  assert.equal(draft.resumeLink, 'https://example.com/resume.pdf');
  assert.equal(draft.interviewWindowStartDate, '2026-05-20');
  assert.equal(draft.interviewWindowEndDate, '2026-05-21');
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

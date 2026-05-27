import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_DAY_END,
  BUSINESS_DAY_START,
  SYDNEY_TIME_ZONE,
  buildCalendarEventDraft,
  formatSydneyDateTime,
  isTimeWithinBusinessHours,
  isValidDateRange,
} from '../src/time.js';

test('builds a 30-minute calendar event with attendees', () => {
  const event = buildCalendarEventDraft({
    candidateName: 'Alex Reyes',
    jobTitle: 'Support Specialist',
    startDate: '2026-05-20',
    startTime: '09:30',
    zoomLink: 'https://zoom.us/j/demo',
    attendees: ['alex@example.com', 'ana@example.com'],
  });

  assert.equal(event.summary, 'Alex Reyes - Support Specialist Interview');
  assert.equal(event.start.timeZone, 'Asia/Manila');
  assert.equal(event.attendees.length, 2);
  assert.equal(
    new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime(),
    30 * 60 * 1000,
  );
});

test('formats dates in the Sydney timezone', () => {
  const formatted = formatSydneyDateTime('2026-05-14T02:00:00Z');
  assert.match(formatted, /Thursday/);
  assert.match(formatted, /May/);
  assert.match(formatted, /2026/);
});

test('checks Sydney business hour boundaries inclusively', () => {
  assert.equal(isTimeWithinBusinessHours(BUSINESS_DAY_START), true);
  assert.equal(isTimeWithinBusinessHours('12:00'), true);
  assert.equal(isTimeWithinBusinessHours(BUSINESS_DAY_END), true);
  assert.equal(isTimeWithinBusinessHours('06:59'), false);
  assert.equal(isTimeWithinBusinessHours('16:01'), false);
});

test('validates date ranges in order', () => {
  assert.equal(isValidDateRange('2026-05-14', '2026-05-15'), true);
  assert.equal(isValidDateRange('2026-05-15', '2026-05-14'), false);
  assert.equal(isValidDateRange('2026-05-14', ''), false);
});

export const PH_TIME_ZONE = 'Asia/Manila';
export const SYDNEY_TIME_ZONE = 'Australia/Sydney';
export const BUSINESS_DAY_START = '07:00';
export const BUSINESS_DAY_END = '16:00';

export function formatDateTimeInTimeZone(dateLike, timeZone) {
  const date = new Date(dateLike);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatDateInTimeZone(dateLike, timeZone) {
  const date = new Date(dateLike)
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatTimeInTimeZone(dateLike, timeZone) {
  const date = new Date(dateLike)
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

export function formatTimeZoneShortName(dateLike, timeZone) {
  const date = new Date(dateLike)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date)
  return parts.find((part) => part.type === 'timeZoneName')?.value || timeZone
}

export function formatDateForInput(dateLike, timeZone = PH_TIME_ZONE) {
  const date = new Date(dateLike)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function formatTimeForInput(dateLike, timeZone = PH_TIME_ZONE) {
  const date = new Date(dateLike)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function formatPhDateTime(dateLike) {
  return formatDateTimeInTimeZone(dateLike, PH_TIME_ZONE);
}

export function formatSydneyDateTime(dateLike) {
  return formatDateTimeInTimeZone(dateLike, SYDNEY_TIME_ZONE);
}

export function isTimeWithinBusinessHours(time, { startTime = BUSINESS_DAY_START, endTime = BUSINESS_DAY_END } = {}) {
  const selectedMinutes = parseTimeToMinutes(time);
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (selectedMinutes === null || startMinutes === null || endMinutes === null) return false;
  return selectedMinutes >= startMinutes && selectedMinutes <= endMinutes;
}

export function isValidDateRange(startDate, endDate) {
  if (!startDate || !endDate) return false;
  return String(startDate) <= String(endDate);
}

export function localDateTimeToUtc(date, time, timeZone = PH_TIME_ZONE) {
  const { year, month, day } = parseDateParts(date);
  const { hour, minute } = parseTimeParts(time);
  const localMillis = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcMillis = localMillis;

  for (let index = 0; index < 2; index += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMillis), timeZone);
    utcMillis = localMillis - offsetMinutes * 60 * 1000;
  }

  return new Date(utcMillis);
}

export function convertLocalDateTimeToZone({
  date,
  time,
  fromTimeZone = PH_TIME_ZONE,
  toTimeZone = PH_TIME_ZONE,
}) {
  const utcDate = localDateTimeToUtc(date, time, fromTimeZone)
  return {
    date: formatDateForInput(utcDate, toTimeZone),
    time: formatTimeForInput(utcDate, toTimeZone),
  }
}

export function buildCalendarEventDraft({
  candidateName,
  jobTitle,
  startDate,
  startTime,
  durationMinutes = 30,
  zoomLink,
  attendees = [],
  timeZone = PH_TIME_ZONE,
}) {
  const start = localDateTimeToUtc(startDate, startTime, timeZone);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  return {
    summary: `${candidateName} - ${jobTitle} Interview`,
    description: ['Interview scheduled by the Slack scheduling assistant.', zoomLink ? `Zoom: ${zoomLink}` : '']
      .filter(Boolean)
      .join('\n'),
    location: zoomLink || 'Zoom',
    start: {
      dateTime: start.toISOString(),
      timeZone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone,
    },
    attendees: attendees.map((email) => ({ email })),
  };
}

function parseDateParts(date) {
  const [year, month, day] = String(date || '').split('-').map((part) => Number(part));
  if (!year || !month || !day) {
    throw new Error(`Invalid date: ${date}`);
  }
  return { year, month, day };
}

function parseTimeParts(time) {
  const [hour, minute] = String(time || '').split(':').map((part) => Number(part));
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Invalid time: ${time}`);
  }
  return { hour, minute };
}

function parseTimeToMinutes(time) {
  const [hour, minute] = String(time || '').split(':').map((part) => Number(part));
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

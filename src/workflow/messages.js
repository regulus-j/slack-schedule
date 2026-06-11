import { generateSignatureHTML, signaturePlainText } from '../signature.js'

const GENERATED_EMAIL_BODY_STYLE = 'font-family: Arial, Helvetica, sans-serif; color: #222222; font-size: 14px; line-height: 1.6; margin: 0; padding: 0;'
const EMAIL_PARAGRAPH_STYLE = 'margin: 0 0 14px 0;'
const EMAIL_DETAIL_BLOCK_STYLE = 'margin: 0 0 14px 0; padding: 12px 16px; background-color: #f5f5f5; border-left: 3px solid #cccccc; line-height: 2;'
const INTERVIEW_PREPARATION_TIPS = [
  'Review the job description and take some time to learn more about our client company, Freedom Property Investors.',
  'Test your internet connection, camera, and microphone before the interview to avoid any technical issues.',
  'Choose a quiet, professional, and distraction-free environment where you can focus comfortably.',
  'Join the meeting 5-10 minutes early to ensure you are ready to begin on time.',
  'Be prepared to discuss your experience, achievements, and how your skills align with the role.',
  'Have a few thoughtful questions ready to demonstrate your interest and learn more about the opportunity.',
]

export function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeEmailAttribute(value) {
  return escapeEmailHtml(value).replace(/"/g, '&quot;')
}

export function emailLink(url, fallbackText = url) {
  const href = String(url || '').trim()
  const text = escapeEmailHtml(fallbackText || href || 'TBD')
  if (!href || href === 'TBD' || href.startsWith('[')) return text
  return `<a href="${escapeEmailAttribute(href)}" style="color: #1155cc;">${text}</a>`
}

export function emailParagraph(content) {
  return `<p style="${EMAIL_PARAGRAPH_STYLE}">${content}</p>`
}

export function emailDetailsBlock(title, rows) {
  const renderedRows = rows
    .filter((row) => row?.value !== undefined && row.value !== null && String(row.value).trim() !== '')
    .map((row) => `<strong>${escapeEmailHtml(row.label)}:</strong> ${row.value}`)
    .join('<br>')

  if (!renderedRows) return ''

  return [
    `<p style="margin: 0 0 8px 0;"><strong>${escapeEmailHtml(title)}</strong></p>`,
    `<div style="${EMAIL_DETAIL_BLOCK_STYLE}">${renderedRows}</div>`,
  ].join('\n')
}

export function generatedEmailHtml(parts) {
  return [
    `<html><body style="${GENERATED_EMAIL_BODY_STYLE}">`,
    ...parts.filter(Boolean),
    generateSignatureHTML(),
    `</body></html>`,
  ].join('\n')
}

export function generatedEmailPlainText(lines) {
  return [
    ...lines,
    '',
    signaturePlainText(),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function buildRescheduleEmail(caseRecord, request) {
  const candidateName = caseRecord.applicant?.firstName || 'there'
  const jobTitle = caseRecord.applicant?.jobTitle || 'the role'
  const durationText = formatEmailDuration(request.durationMinutes || caseRecord.currentSchedule?.durationMinutes)
  const durationPlainLine = durationText ? [`Duration: ${durationText}`] : []
  const timeText = `${request.time || 'TBD'} ${caseRecord.interviewTimezone || ''}`.trim()
  const zoomLink = request.zoomLink || 'TBD'
  const htmlBody = generatedEmailHtml([
    emailParagraph(`Hi <strong>${escapeEmailHtml(candidateName)}</strong>,`),
    emailParagraph(`We need to reschedule your interview for the <strong>${escapeEmailHtml(jobTitle)}</strong> role at Outsourced Pro Global.`),
    request.reason ? emailParagraph(`<strong>Reason:</strong> ${escapeEmailHtml(request.reason)}`) : '',
    emailDetailsBlock('New interview details:', [
      { label: 'Date', value: escapeEmailHtml(request.date || 'TBD') },
      { label: 'Time', value: escapeEmailHtml(timeText) },
      durationText ? { label: 'Duration', value: escapeEmailHtml(durationText) } : null,
      { label: 'Zoom Link', value: emailLink(zoomLink) },
    ]),
    emailParagraph('Please let us know if this updated schedule works well for you.'),
  ])

  const plainBody = generatedEmailPlainText([
    `Hi ${candidateName},`,
    '',
    `We need to reschedule your interview for the ${jobTitle} role at Outsourced Pro Global.`,
    '',
    request.reason ? `Reason: ${request.reason}` : '',
    '',
    'New interview details:',
    `Date: ${request.date || 'TBD'}`,
    `Time: ${timeText}`,
    ...durationPlainLine,
    `Zoom Link: ${zoomLink}`,
    '',
    'Please let us know if this updated schedule works well for you.',
  ])

  return {
    to: caseRecord.applicant?.email,
    from: caseRecord.recruiter?.email,
    subject: `Updated Interview Schedule for ${jobTitle}`,
    body: htmlBody,
    htmlBody,
    plainBody,
  }
}

export function buildReminderEmail(caseRecord) {
  const candidateName = caseRecord.applicant?.firstName || 'there'
  const currentSchedule = caseRecord.currentSchedule || {}
  const jobTitle = caseRecord.applicant?.jobTitle || 'Interview'
  const durationText = formatEmailDuration(currentSchedule.durationMinutes)
  const durationPlainLine = durationText ? [`Duration: ${durationText}`] : []
  const timeText = `${currentSchedule.time || '[time]'} ${caseRecord.interviewTimezone || ''}`.trim()
  const zoomLink = currentSchedule.zoomLink || caseRecord.autofill?.zoomLink || '[zoom_link]'
  const htmlBody = generatedEmailHtml([
    emailParagraph(`Hi <strong>${escapeEmailHtml(candidateName)}</strong>,`),
    emailParagraph(`This is a friendly reminder about your upcoming interview for the <strong>${escapeEmailHtml(jobTitle)}</strong> role at Outsourced Pro Global.`),
    emailDetailsBlock('Interview details:', [
      { label: 'Date', value: escapeEmailHtml(currentSchedule.date || '[date]') },
      { label: 'Time', value: escapeEmailHtml(timeText) },
      durationText ? { label: 'Duration', value: escapeEmailHtml(durationText) } : null,
      { label: 'Zoom Link', value: emailLink(zoomLink) },
    ]),
    emailParagraph('To help you feel confident and prepared, here are a few tips for a smooth and successful interview:'),
    `<ul style="margin: 0 0 14px 0; padding-left: 20px;">${INTERVIEW_PREPARATION_TIPS
      .map((tip) => `<li style="margin-bottom: 8px;">${escapeEmailHtml(tip)}</li>`)
      .join('')}</ul>`,
    emailParagraph('Please let us know if you need any support before the interview.'),
  ])

  const plainBody = generatedEmailPlainText([
    `Hi ${candidateName},`,
    '',
    `This is a friendly reminder about your upcoming interview for the ${jobTitle} role at Outsourced Pro Global.`,
    '',
    'Interview details:',
    `Date: ${currentSchedule.date || '[date]'}`,
    `Time: ${timeText}`,
    ...durationPlainLine,
    `Zoom Link: ${zoomLink}`,
    '',
    'To help you feel confident and prepared, here are a few tips for a smooth and successful interview:',
    ...INTERVIEW_PREPARATION_TIPS.map((tip) => `- ${tip}`),
    '',
    'Please let us know if you need any support before the interview.',
  ])

  return {
    to: caseRecord.applicant?.email,
    from: caseRecord.recruiter?.email,
    subject: `Reminder: ${jobTitle} interview`,
    body: htmlBody,
    htmlBody,
    plainBody,
  }
}

export function buildFeedbackRequestEmail(caseRecord, feedbackFormUrl) {
  const candidateName = caseRecord.applicant?.firstName || 'there'
  const fullName = [
    caseRecord.applicant?.firstName,
    caseRecord.applicant?.lastName,
  ].filter(Boolean).join(' ') || 'Candidate'
  const jobTitle = caseRecord.applicant?.jobTitle || 'the role'
  const eventLabel = caseRecord.stageKey === 'job-offer-discussion'
    ? 'job offer discussion'
    : 'interview'
  const htmlBody = generatedEmailHtml([
    emailParagraph(`Hi <strong>${escapeEmailHtml(candidateName)}</strong>,`),
    emailParagraph(`Thank you for taking the time to complete your ${escapeEmailHtml(eventLabel)} for the <strong>${escapeEmailHtml(jobTitle)}</strong> role.`),
    emailParagraph('We would appreciate your feedback about your experience. Your comments help us improve the candidate journey.'),
    `<p style="margin: 0 0 14px 0;"><a href="${escapeEmailAttribute(feedbackFormUrl)}" style="display: inline-block; padding: 10px 16px; background-color: #1155cc; color: #ffffff; text-decoration: none; border-radius: 4px;">Share your feedback</a></p>`,
    emailParagraph('Thank you again for your time and interest in Outsourced Pro Global.'),
  ])
  const plainBody = generatedEmailPlainText([
    `Hi ${candidateName},`,
    '',
    `Thank you for taking the time to complete your ${eventLabel} for the ${jobTitle} role.`,
    '',
    'We would appreciate your feedback about your experience. Your comments help us improve the candidate journey.',
    '',
    `Share your feedback: ${feedbackFormUrl}`,
    '',
    'Thank you again for your time and interest in Outsourced Pro Global.',
  ])
  return {
    to: caseRecord.applicant?.email,
    from: caseRecord.recruiter?.email,
    subject: `We value your feedback, ${fullName}`,
    body: htmlBody,
    htmlBody,
    plainBody,
  }
}

function formatEmailDuration(minutes) {
  const normalized = Number(minutes)
  if (!Number.isFinite(normalized) || normalized <= 0) return ''
  if (normalized === 60) return '1 hour'
  return `${normalized} minutes`
}

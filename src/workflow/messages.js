import { generateSignatureHTML, signaturePlainText } from '../signature.js'
import { stripHtmlBody } from '../templates.js'

export function buildRescheduleEmail(caseRecord, request) {
  const candidateName = caseRecord.applicant?.firstName || 'there'
  const jobTitle = caseRecord.applicant?.jobTitle || 'the role'
  const reasonLine = request.reason ? `<p><strong>Reason:</strong> ${request.reason}</p>` : ''
  const noteLine = request.note ? `<p><strong>Additional note:</strong> ${request.note}</p>` : ''
  const durationText = formatEmailDuration(request.durationMinutes || caseRecord.currentSchedule?.durationMinutes)
  const durationHtmlLine = durationText ? `Duration: ${durationText}<br>` : ''
  const durationPlainLine = durationText ? [`Duration: ${durationText}`] : []

  const signatureHtml = generateSignatureHTML()

  const htmlBody = [
    `<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:14px;">`,
    `<p><strong>Hi ${candidateName},</strong></p>`,
    `<p>We need to reschedule your interview for the <strong>${jobTitle}</strong> role at Outsourced Pro Global.</p>`,
    reasonLine,
    `<p><strong>New interview details:</strong><br>`,
    `Date: ${request.date}<br>`,
    `Time: ${request.time} ${caseRecord.interviewTimezone || ''}<br>`,
    durationHtmlLine,
    `Zoom Link: <a href="${request.zoomLink}">${request.zoomLink}</a></p>`,
    noteLine,
    `<p>Please let us know if this updated schedule works well for you.</p>`,
    signatureHtml,
    `</body></html>`,
  ].filter(Boolean).join('\n')

  const plainBody = [
    `Hi ${candidateName},`,
    '',
    `We need to reschedule your interview for the ${jobTitle} role at Outsourced Pro Global.`,
    '',
    request.reason ? `Reason: ${request.reason}` : '',
    '',
    'New interview details:',
    `Date: ${request.date}`,
    `Time: ${request.time} ${caseRecord.interviewTimezone || ''}`,
    ...durationPlainLine,
    `Zoom Link: ${request.zoomLink}`,
    '',
    request.note ? `Additional note: ${request.note}` : '',
    '',
    'Please let us know if this updated schedule works well for you.',
    '',
    signaturePlainText(),
  ].filter(Boolean).join('\n')

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
  const durationHtmlLine = durationText ? `Duration: ${durationText}<br>` : ''
  const durationPlainLine = durationText ? [`Duration: ${durationText}`] : []

  const signatureHtml = generateSignatureHTML()

  const htmlBody = [
    `<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:14px;">`,
    `<p><strong>Hi ${candidateName},</strong></p>`,
    `<p>This is a friendly reminder about your upcoming interview for the <strong>${jobTitle}</strong> role at Outsourced Pro Global.</p>`,
    `<p><strong>Interview details:</strong><br>`,
    `Date: ${currentSchedule.date || '[date]'}<br>`,
    `Time: ${currentSchedule.time || '[time]'} ${caseRecord.interviewTimezone || ''}<br>`,
    durationHtmlLine,
    `Zoom Link: <a href="${currentSchedule.zoomLink || caseRecord.autofill?.zoomLink || '#'}">${currentSchedule.zoomLink || caseRecord.autofill?.zoomLink || '[zoom_link]'}</a></p>`,
    `<p>Please let us know if you need any support before the interview.</p>`,
    signatureHtml,
    `</body></html>`,
  ].join('\n')

  const plainBody = [
    `Hi ${candidateName},`,
    '',
    `This is a friendly reminder about your upcoming interview for the ${jobTitle} role at Outsourced Pro Global.`,
    '',
    'Interview details:',
    `Date: ${currentSchedule.date || '[date]'}`,
    `Time: ${currentSchedule.time || '[time]'} ${caseRecord.interviewTimezone || ''}`,
    ...durationPlainLine,
    `Zoom Link: ${currentSchedule.zoomLink || caseRecord.autofill?.zoomLink || '[zoom_link]'}`,
    '',
    'Please let us know if you need any support before the interview.',
    '',
    signaturePlainText(),
  ].join('\n')

  return {
    to: caseRecord.applicant?.email,
    from: caseRecord.recruiter?.email,
    subject: `Reminder: ${jobTitle} interview`,
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

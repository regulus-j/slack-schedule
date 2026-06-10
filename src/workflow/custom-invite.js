import { plainTextToHtml } from '../templates.js'

const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const FINAL_DELIVERY_STATUSES = new Set(['sent', 'mocked'])

export function parseCustomInviteRecipients(value) {
  const lines = String(value || '').split(/\r?\n/)
  const recipients = []
  const seen = new Set()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue

    const namedMatch = line.match(/^(.+?)\s*<([^<>]+)>$/)
    const name = namedMatch ? normalizeName(namedMatch[1]) : ''
    const rawEmail = namedMatch ? namedMatch[2].trim() : line
    const email = normalizeEmail(rawEmail)

    if ((line.includes('<') || line.includes('>')) && !namedMatch) {
      throw new Error(`Line ${index + 1} must use Name <email> or email.`)
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new Error(`Line ${index + 1} has an invalid email address.`)
    }
    if (seen.has(email)) {
      throw new Error(`Duplicate recipient: ${email}`)
    }

    seen.add(email)
    recipients.push({ name, email })
  }

  if (recipients.length === 0) {
    throw new Error('Enter at least one recipient.')
  }

  return recipients
}

export function validateCustomInviteDraft(draft) {
  const errors = {}
  if (!String(draft?.customInviteTitle || '').trim()) {
    errors.custom_title_block = 'Enter an event purpose or title.'
  }
  if (!String(draft?.customInviteSubject || '').trim()) {
    errors.custom_subject_block = 'Enter an email subject.'
  }
  if (!String(draft?.customInviteBody || '').trim()) {
    errors.custom_body_block = 'Enter an email body.'
  }
  if (
    String(draft?.customInviteMeetingLink || '').trim() &&
    !isHttpUrl(draft.customInviteMeetingLink)
  ) {
    errors.custom_meeting_link_block = 'Enter a valid http or https meeting URL.'
  }
  if (draft?.customInviteRecipientError) {
    errors.custom_recipients_block = draft.customInviteRecipientError
  } else if (!Array.isArray(draft?.customInviteRecipients) || draft.customInviteRecipients.length === 0) {
    errors.custom_recipients_block = 'Enter at least one recipient.'
  }
  return errors
}

export function isCustomInviteCase(caseRecord) {
  const stored = caseRecord?.customInvite
  const hasStoredMetadata = Boolean(
    stored &&
    typeof stored === 'object' &&
    Object.keys(stored).length > 0
  )
  return Boolean(
    hasStoredMetadata ||
    caseRecord?.eventType === 'custom-invite' ||
    caseRecord?.autofill?.customInvitePurpose
  )
}

export function normalizeCustomInviteMetadata(caseRecord) {
  const stored = caseRecord?.customInvite || {}
  const fallbackRecipients = [
    ...(Array.isArray(caseRecord?.externalAttendees) ? caseRecord.externalAttendees : []),
    caseRecord?.applicant,
  ]
    .map((person) => ({
      name: normalizeName(
        person?.name ||
        [person?.firstName, person?.lastName].filter(Boolean).join(' ')
      ),
      email: normalizeEmail(person?.email),
    }))
    .filter((recipient) => EMAIL_PATTERN.test(recipient.email))

  const recipients = dedupeRecipients(
    Array.isArray(stored.recipients) && stored.recipients.length > 0
      ? stored.recipients
      : fallbackRecipients
  )
  const title = String(
    stored.title ||
    caseRecord?.autofill?.customInvitePurpose ||
    caseRecord?.applicant?.jobTitle ||
    'Custom Event'
  ).trim()

  return {
    title,
    subject: String(stored.subject || `Invitation: ${title}`).trim(),
    body: String(
      stored.body ||
      '[greeting]\n\nYou are invited to [event_title].\n\nDate: [date]\nTime: [time] [timezone]\nMeeting link: [meeting_link]'
    ).trim(),
    recipients,
    meetingLink: String(stored.meetingLink || caseRecord?.autofill?.zoomLink || '').trim(),
    deliveryStatus: stored.deliveryStatus && typeof stored.deliveryStatus === 'object'
      ? stored.deliveryStatus
      : {},
  }
}

export function customInviteExternalAttendees(recipients) {
  return (recipients || []).map((recipient) => ({
    id: `recipient-${normalizeEmail(recipient.email)}`,
    name: normalizeName(recipient.name) || normalizeEmail(recipient.email),
    email: normalizeEmail(recipient.email),
    role: 'recipient',
    required: true,
    included: true,
    source: 'custom_invite',
  }))
}

export function buildCustomInviteEmail(caseRecord, recipient, overrides = {}) {
  const metadata = {
    ...normalizeCustomInviteMetadata(caseRecord),
    ...overrides,
  }
  const schedule = caseRecord?.currentSchedule || {}
  const name = normalizeName(recipient?.name)
  const greeting = name ? `Hello ${name},` : 'Hello,'
  const variables = {
    greeting,
    name,
    recipient_name: name,
    email: normalizeEmail(recipient?.email),
    recipient_email: normalizeEmail(recipient?.email),
    event_title: metadata.title,
    title: metadata.title,
    date: schedule.date || caseRecord?.selectedInterviewDate || '',
    time: schedule.time || caseRecord?.selectedInterviewTime || '',
    timezone: caseRecord?.interviewTimezone || '',
    meeting_link: schedule.zoomLink || metadata.meetingLink || '',
    link: schedule.zoomLink || metadata.meetingLink || '',
  }
  const subject = replaceInviteVariables(metadata.subject, variables)
  let plainBody = replaceInviteVariables(metadata.body, variables).trim()
  if (!plainBody.toLowerCase().startsWith(greeting.toLowerCase())) {
    plainBody = `${greeting}\n\n${plainBody}`.trim()
  }
  const htmlBody = `<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:14px;">${plainTextToHtml(plainBody)}</body></html>`

  return {
    to: variables.email,
    from: caseRecord?.autofill?.coordinatorEmail || '',
    subject,
    body: htmlBody,
    htmlBody,
    plainBody,
  }
}

export function hasPendingCustomInviteDeliveries(caseRecord) {
  const metadata = normalizeCustomInviteMetadata(caseRecord)
  return metadata.recipients.some((recipient) => {
    const status = metadata.deliveryStatus[recipient.email]?.status
    return !FINAL_DELIVERY_STATUSES.has(status)
  })
}

export function isFinalCustomInviteDeliveryStatus(status) {
  return FINAL_DELIVERY_STATUSES.has(status)
}

function replaceInviteVariables(value, variables) {
  return String(value || '').replace(/\[([^\]]+)\]/g, (match, key) => {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, '_')
    return normalized in variables ? variables[normalized] : match
  })
}

function dedupeRecipients(recipients) {
  const byEmail = new Map()
  for (const recipient of recipients || []) {
    const email = normalizeEmail(recipient?.email)
    if (!EMAIL_PATTERN.test(email) || byEmail.has(email)) continue
    byEmail.set(email, {
      name: normalizeName(recipient?.name),
      email,
    })
  }
  return [...byEmail.values()]
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

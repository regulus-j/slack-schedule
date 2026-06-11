import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATE_METADATA,
  loadSchedulingTemplates,
  loadTemplates,
  normalizeTemplateText,
  parseTemplate,
  renderTemplate,
  replaceVariables,
  signedEmailBodiesFromPlainText,
  stripHtmlBody,
  stripSignatureHtml,
  templateRequiresResume,
} from '../src/templates.js'
import { buildScheduledCandidateEmail } from '../src/slack/handlers.js'
import { candidateMessageModal } from '../src/slack/views.js'

test('normalizes mojibake and subject typo', () => {
  const normalized = normalizeTemplateText('Subeject: Letâ€™s Talk\n\nBody:\nHiÂ there')
  assert.match(normalized, /^Subject: Let's Talk/)
  assert.match(normalized, /Hi there/)
})

test('parses and renders template variables', () => {
  const template = parseTemplate('demo', 'Subject: Hi [applicant_first_name]\n\nBody:\nRole: [job_title]')
  const rendered = renderTemplate(template, {
    applicant_first_name: 'Alex',
    job_title: 'Support Specialist',
  })

  assert.equal(rendered.subject, 'Hi Alex')
  assert.equal(rendered.body, 'Role: Support Specialist')
})

test('parses HTML template body', () => {
  const template = parseTemplate('html-demo',
    'Subject: Hello [applicant_first_name]\n\n' +
    'Body:\n<html><body><p>Hi <strong>[applicant_first_name]</strong></p><p>Role: [job_title]</p>[signature]</body></html>'
  )

  assert.match(template.body, /<html>/)
  assert.match(template.body, /\[signature\]/)
  assert.match(template.subject, /Hello/)
})

test('renderTemplate resolves [signature] to HTML signature block', () => {
  const template = parseTemplate('sig-test',
    'Subject: Test\n\nBody:\n<html><body><p>Hello</p>[signature]</body></html>'
  )
  const rendered = renderTemplate(template, {
    applicant_first_name: 'Alex',
  })

  assert.match(rendered.body, /Outsourced Pro Global/)
  assert.match(rendered.body, /<table/)
  assert.match(rendered.body, /recruitment@opglobal\.com\.hk/)
  assert.match(rendered.body, /cid:opg-logo/)
  assert.match(rendered.body, /data-opg-signature="true"/)
  assert.match(rendered.body, /font-size:14px;line-height:1\.6/)
  assert.match(rendered.body, /<span style="display:block;margin-top:14px;">Best Regards,<\/span>/)
  assert.doesNotMatch(rendered.body, /font-size:small/)
  assert.doesNotMatch(rendered.body, /font-size:medium/)
  assert.doesNotMatch(rendered.body, /<font\b/)
  assert.match(rendered.body, /IMPORTANT: The contents of this email/)
})

test('renderTemplate computes plainBody by stripping HTML', () => {
  const template = parseTemplate('plain-test',
    'Subject: Test\n\nBody:\n<html><body><p>Hello <strong>[applicant_first_name]</strong></p><p>Role: [job_title]</p>[signature]</body></html>'
  )
  const rendered = renderTemplate(template, {
    applicant_first_name: 'Alex',
    job_title: 'Support Specialist',
  })

  assert.ok(rendered.plainBody)
  assert.equal(typeof rendered.plainBody, 'string')
  assert.match(rendered.plainBody, /Hello Alex/)
  assert.match(rendered.plainBody, /Role: Support Specialist/)
  assert.match(rendered.plainBody, /Outsourced Pro Global/)
  assert.match(rendered.plainBody, /Best Regards/)
  // plain body should NOT contain HTML tags
  assert.doesNotMatch(rendered.plainBody, /<html>/)
  assert.doesNotMatch(rendered.plainBody, /<table>/)
  assert.doesNotMatch(rendered.plainBody, /<strong>/)
})

test('signedEmailBodiesFromPlainText appends plain signature and restores HTML signature', () => {
  const email = signedEmailBodiesFromPlainText('Hi Alex,\n\nInterview details here.')

  assert.match(email.plainBody, /Hi Alex/)
  assert.match(email.plainBody, /Outsourced Pro Global Limited/)
  assert.match(email.plainBody, /IMPORTANT: The contents of this email/)
  assert.match(email.htmlBody, /Hi Alex/)
  assert.match(email.htmlBody, /^<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:14px;">/)
  assert.match(email.htmlBody, /<table/)
  assert.match(email.htmlBody, /cid:opg-logo/)
  assert.match(email.htmlBody, /data-opg-signature="true"/)
  assert.match(email.htmlBody, /IMPORTANT: The contents of this email/)
})

test('signedEmailBodiesFromPlainText does not duplicate existing signature', () => {
  const once = signedEmailBodiesFromPlainText('Hi Alex')
  const twice = signedEmailBodiesFromPlainText(once.plainBody)

  assert.equal(twice.plainBody, once.plainBody)
  assert.equal((twice.plainBody.match(/Outsourced Pro Global Limited/g) || []).length, 1)
})

test('stripHtmlBody removes tags and decodes entities', () => {
  const html = '<p><strong>Hi Alex</strong></p><p>Role: Support Specialist</p><p>& more</p>'
  const plain = stripHtmlBody(html)

  assert.match(plain, /Hi Alex/)
  assert.match(plain, /Role: Support Specialist/)
  assert.match(plain, /& more/)
  assert.doesNotMatch(plain, /<p>/)
  assert.doesNotMatch(plain, /<strong>/)
})

test('replaceVariables handles signature specially', () => {
  const result = replaceVariables('<p>Hello</p>[signature]', {})
  assert.match(result, /<table/)
  assert.match(result, /Outsourced Pro Global/)
})

test('replaceVariables passes through other variables', () => {
  const result = replaceVariables('<p>[applicant_first_name] - [job_title]</p>[signature]', {
    applicant_first_name: 'Alex',
    job_title: 'Support Specialist',
  })

  assert.match(result, /Alex/)
  assert.match(result, /Support Specialist/)
  assert.match(result, /Outsourced Pro Global/)
})

test('replaceVariables returns placeholder for missing variables', () => {
  const result = replaceVariables('<p>[nonexistent_var]</p>[signature]', {})
  assert.match(result, /\[nonexistent_var\]/)
})

test('template metadata marks final interview resumes as required', () => {
  assert.equal(TEMPLATE_METADATA['2nd-or-Final-invite'].resumeRequired, true)
  assert.equal(TEMPLATE_METADATA['1st-interview-invite'].resumeRequired, false)
  assert.equal(templateRequiresResume('2nd-or-Final-invite'), true)
  assert.equal(templateRequiresResume('1st-interview-invite'), false)
})

test('replaceVariables renders recruiter phone line', () => {
  const result = replaceVariables('<p>[recruiter_phone_line]</p>', {
    recruiter_phone_line: 'Christiana Dela Cruz: +63 900 111 2222',
  })

  assert.equal(result, '<p>Christiana Dela Cruz: +63 900 111 2222</p>')
})

test('loadSchedulingTemplates only exposes interview invite templates', async () => {
  const templates = await loadSchedulingTemplates()
  assert.deepEqual(templates.map((template) => template.id).sort(), [
    '1st-interview-invite',
    '2nd-or-Final-invite',
    'job-offer-discussion',
  ])
  assert.ok(!templates.some((template) => template.id.endsWith('.eml')))
})

test('all operational email templates use the shared Arial 14px formatting standard', async () => {
  const templates = await loadTemplates()
  const operationalTemplates = templates.filter((template) => Object.hasOwn(TEMPLATE_METADATA, template.id))

  assert.deepEqual(
    operationalTemplates.map((template) => template.id).sort(),
    Object.keys(TEMPLATE_METADATA).sort(),
  )
  for (const template of operationalTemplates) {
    assert.match(template.body, /font-family:Arial,Helvetica,sans-serif/, template.id)
    assert.match(template.body, /font-size:14px/, template.id)
    assert.match(template.body, /line-height:1\.38/, template.id)
    assert.match(template.body, /margin-bottom:16px/, template.id)
    assert.match(template.body, /\[signature\]/, template.id)
  }
})

test('stripSignatureHtml removes signature and wrapper tags from rendered template body', () => {
  const template = parseTemplate('sig-test',
    'Subject: Test\n\nBody:\n<html><body style="font-family:Arial;"><p>Hi <strong>Alex</strong></p><p>Interview details here.</p>[signature]</body></html>'
  )
  const rendered = renderTemplate(template, { applicant_first_name: 'Alex' })

  const result = stripSignatureHtml(rendered.body)

  assert.match(result, /Hi.*Alex/)
  assert.match(result, /Interview details here/)
  assert.doesNotMatch(result, /Best Regards/)
  assert.doesNotMatch(result, /<table/)
  assert.doesNotMatch(result, /IMPORTANT: The contents of this email/)
  assert.doesNotMatch(result, /<html/)
  assert.doesNotMatch(result, /<body/)
})

test('stripSignatureHtml returns content unchanged when no signature present', () => {
  const result = stripSignatureHtml('<html><body><p>Plain content</p></body></html>')

  assert.match(result, /Plain content/)
  assert.doesNotMatch(result, /<html/)
  assert.doesNotMatch(result, /<body/)
})

test('stripSignatureHtml returns empty string for empty input', () => {
  assert.equal(stripSignatureHtml(''), '')
  assert.equal(stripSignatureHtml(null), '')
})

test('final interview invite subject renders Final Interview', async () => {
  const email = await buildScheduledCandidateEmail({
    templateId: '2nd-or-Final-invite',
    stageKey: 'final-interview',
    applicant: {
      firstName: 'Alex',
      lastName: 'Reyes',
      email: 'alex@example.com',
      jobTitle: 'Support Specialist',
    },
    recruiter: { email: 'recruiter@example.com' },
    hiringManager: { name: 'Hiring Manager', positionTitle: 'Operations Lead' },
    currentSchedule: {
      date: '2026-06-01',
      time: '10:00',
      zoomLink: 'https://zoom.test/final',
      attendees: [],
    },
    interviewTimezone: 'Asia/Manila',
    stageOverrides: {},
  })

  assert.match(email.subject, /Final Interview/)
  assert.doesNotMatch(email.subject, /2nd Interview/)
})

test('candidate message modal does not include SMS blocks', () => {
  const modal = candidateMessageModal({
    caseRecord: {
      id: 'case-1',
      status: 'Draft',
      applicant: { firstName: 'Alex', lastName: 'Reyes', jobTitle: 'Support Specialist' },
    },
    renderedTemplate: { subject: 'Subject', plainBody: 'Body' },
  })

  const text = JSON.stringify(modal)
  assert.doesNotMatch(text, /sms_block/)
  assert.doesNotMatch(text, /SMS copy/)
})

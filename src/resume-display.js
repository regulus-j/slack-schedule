export function resumeDisplayText(caseRecord) {
  const role = clean(caseRecord?.applicant?.jobTitle) || 'Role'
  const name = clean([
    caseRecord?.applicant?.firstName,
    caseRecord?.applicant?.lastName,
  ].filter(Boolean).join(' ')) || clean(caseRecord?.applicant?.fullName) || 'Name'
  return `[Resume]${role} - ${name}`
}

export function resumeSlackLink(caseRecord) {
  const url = clean(caseRecord?.resumeLink)
  const text = resumeDisplayText(caseRecord)
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return text
  return `<${url}|${text}>`
}

export function resumeHtmlLink(caseRecord) {
  const url = clean(caseRecord?.resumeLink)
  const text = escapeHtml(resumeDisplayText(caseRecord))
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return text
  return `<a href="${escapeHtmlAttribute(url)}">${text}</a>`
}

export function resumePlainLink(caseRecord) {
  const url = clean(caseRecord?.resumeLink)
  const text = resumeDisplayText(caseRecord)
  if (!url) return ''
  return /^https?:\/\//i.test(url) ? `${text}: ${url}` : text
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

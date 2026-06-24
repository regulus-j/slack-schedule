const EMAIL_PATTERN = /^[^\s<>,;:@]+@[^\s<>,;:@]+\.[^\s<>,;:@]+$/

export function buildSafeEmailHeaders({ to, cc, from, subject }) {
  return {
    to: formatAddressList(to, 'To'),
    cc: formatAddressList(cc, 'Cc', { optional: true }),
    from: formatAddressList(from, 'From'),
    subject: encodeHeaderText(assertSafeHeaderValue(subject, 'Subject')),
  }
}

export function assertSafeHeaderValue(value, field = 'header') {
  const text = String(value || '').trim()
  if (/[\r\n\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} contains prohibited control characters.`)
  }
  return text
}

export function formatAddressList(value, field = 'address', { optional = false } = {}) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',')
  const formatted = values.map((item) => formatAddress(item, field)).filter(Boolean)
  if (!optional && formatted.length === 0) throw new Error(`${field} requires a valid email address.`)
  return formatted.join(', ')
}

function formatAddress(value, field) {
  const text = assertSafeHeaderValue(value, field)
  if (!text) return ''
  const named = text.match(/^(.*?)\s*<([^<>]+)>$/)
  if (!named) {
    if (!EMAIL_PATTERN.test(text)) throw new Error(`${field} contains an invalid email address.`)
    return text
  }
  const displayName = assertSafeHeaderValue(named[1].replace(/^"|"$/g, ''), field)
  const email = named[2].trim()
  if (!EMAIL_PATTERN.test(email)) throw new Error(`${field} contains an invalid email address.`)
  return displayName ? `${encodeHeaderText(displayName)} <${email}>` : email
}

function encodeHeaderText(value) {
  const text = String(value || '')
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

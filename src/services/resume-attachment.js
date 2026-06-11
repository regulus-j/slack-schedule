const DEFAULT_MIME_TYPE = 'application/octet-stream'

export async function resolveResumeAttachment({
  caseRecord,
  client,
  botToken,
  maxBytes = 15 * 1024 * 1024,
  fetchImpl = fetch,
}) {
  const stored = normalizeResumeFile(caseRecord?.resumeFile, caseRecord?.resumeLink)
  if (!stored.id && !stored.downloadUrl) {
    throw new Error('The required resume file is missing. Upload the resume again before sending.')
  }

  let file = stored
  if (file.id && client?.files?.info) {
    const result = await client.files.info({ file: file.id })
    file = normalizeResumeFile(result?.file, file.downloadUrl || caseRecord?.resumeLink)
  } else if ((!file.downloadUrl || !file.name || !file.mimeType) && file.id) {
    if (!client?.files?.info) {
      throw new Error('Slack file metadata is unavailable. Upload the resume again before sending.')
    }
  }

  if (!file.downloadUrl) {
    throw new Error('Slack did not provide a downloadable resume URL. Check the app files:read scope.')
  }

  const response = await fetchImpl(file.downloadUrl, {
    headers: isSlackFileUrl(file.downloadUrl) && botToken
      ? { authorization: `Bearer ${botToken}` }
      : {},
  })
  if (!response.ok) {
    throw new Error(`Resume download failed with HTTP ${response.status}. Check the Slack files:read scope.`)
  }

  const declaredSize = Number(response.headers?.get?.('content-length') || file.size || 0)
  if (declaredSize > maxBytes) {
    throw new Error(`The resume is larger than the ${formatMegabytes(maxBytes)} MB attachment limit.`)
  }

  const content = Buffer.from(await response.arrayBuffer())
  if (content.length > maxBytes) {
    throw new Error(`The resume is larger than the ${formatMegabytes(maxBytes)} MB attachment limit.`)
  }

  return {
    filename: sanitizeFilename(file.name || 'resume'),
    mimeType: file.mimeType || DEFAULT_MIME_TYPE,
    content,
  }
}

export function normalizeResumeFile(file, fallbackUrl = '') {
  const source = file && typeof file === 'object' ? file : {}
  const downloadUrl = clean(
    source.downloadUrl ||
    source.url_private_download ||
    source.url_private ||
    fallbackUrl,
  )
  return {
    id: clean(source.id || slackFileId(downloadUrl)),
    name: clean(source.name || filenameFromUrl(downloadUrl) || 'resume'),
    mimeType: clean(source.mimeType || source.mimetype || DEFAULT_MIME_TYPE),
    size: Number(source.size || 0) || 0,
    permalink: clean(source.permalink),
    downloadUrl,
  }
}

export function slackFileId(value) {
  const match = String(value || '').match(/(?:^|[-/])(F[A-Z0-9]+)(?:[/?-]|$)/i)
  return match?.[1] || ''
}

function filenameFromUrl(value) {
  try {
    const pathname = new URL(value).pathname
    return decodeURIComponent(pathname.split('/').pop() || '')
  } catch {
    return ''
  }
}

function sanitizeFilename(value) {
  return String(value || 'resume')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/]/g, '-')
    .trim() || 'resume'
}

function isSlackFileUrl(value) {
  try {
    return new URL(value).hostname.endsWith('slack.com')
  } catch {
    return false
  }
}

function formatMegabytes(bytes) {
  return Math.floor(Number(bytes || 0) / (1024 * 1024))
}

function clean(value) {
  return String(value || '').trim()
}

const DEFAULT_MIME_TYPE = 'application/octet-stream'

export async function resolveResumeAttachment({
  caseRecord,
  client,
  botToken,
  maxBytes = 15 * 1024 * 1024,
  fetchImpl = fetch,
}) {
  const resumeFile = caseRecord?.resumeFile
  const stored = normalizeResumeFile(resumeFile, caseRecord?.resumeLink)
  if (!stored.id && !stored.downloadUrl) {
    throw new Error('The required resume file is missing. Upload the resume again before sending.')
  }

  let file = stored
  if (file.id && client?.files?.info) {
    try {
      const result = await client.files.info({ file: file.id })
      file = normalizeResumeFile(result?.file, file.downloadUrl || caseRecord?.resumeLink)
    } catch (error) {
      if (error?.data?.error === 'missing_scope') {
        throw new Error('The Slack app is missing the files:read scope. Reinstall the app in the workspace, then retry scheduling.')
      }
      throw error
    }
  } else if (file.id && !file.downloadUrl) {
    throw new Error('Slack file metadata is unavailable. Upload the resume again before sending.')
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
  validateResumeContent({
    content,
    contentType: response.headers?.get?.('content-type') || '',
    filename: file.name,
    mimeType: file.mimeType,
  })

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

function validateResumeContent({ content, contentType, filename, mimeType }) {
  const normalizedContentType = clean(contentType).toLowerCase()
  const textPrefix = content.subarray(0, 1024).toString('utf8').trimStart().toLowerCase()
  if (
    normalizedContentType.includes('text/html') ||
    textPrefix.startsWith('<!doctype html') ||
    textPrefix.startsWith('<html') ||
    textPrefix.includes('this browser is no longer supported')
  ) {
    throw new Error('Slack returned a sign-in page instead of the resume file. Verify files:read access and upload the resume again.')
  }

  const extension = extensionFromFilename(filename)
  const normalizedMimeType = clean(mimeType).toLowerCase()
  if ((extension === 'pdf' || normalizedMimeType === 'application/pdf') && !content.includes(Buffer.from('%PDF-'))) {
    throw new Error('The downloaded resume is not a valid PDF. Upload the original PDF again before sending.')
  }
  if (
    (extension === 'docx' || normalizedMimeType.includes('officedocument.wordprocessingml.document')) &&
    !hasZipSignature(content)
  ) {
    throw new Error('The downloaded resume is not a valid DOCX file. Upload the original document again before sending.')
  }
  if (
    (extension === 'doc' || normalizedMimeType === 'application/msword') &&
    !content.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    throw new Error('The downloaded resume is not a valid DOC file. Upload the original document again before sending.')
  }
}

function extensionFromFilename(value) {
  const match = clean(value).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

function hasZipSignature(content) {
  const signature = content.subarray(0, 4)
  return (
    signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  )
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

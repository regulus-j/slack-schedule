import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveResumeAttachment } from '../src/services/resume-attachment.js'

test('downloads a private Slack resume with bot authentication', async () => {
  let authorization = ''
  const attachment = await resolveResumeAttachment({
    caseRecord: {
      resumeFile: {
        id: 'F123',
        name: 'candidate.pdf',
        mimetype: 'application/pdf',
        url_private_download: 'https://files.slack.com/files-pri/T123-F123/candidate.pdf',
      },
    },
    botToken: 'xoxb-test',
    maxBytes: 1024,
    fetchImpl: async (url, options) => {
      assert.match(url, /files\.slack\.com/)
      authorization = options.headers.Authorization
      return new Response(Buffer.from('%PDF-1.7\nresume bytes'), {
        status: 200,
        headers: {
          'content-length': '21',
          'content-type': 'application/pdf',
        },
      })
    },
  })

  assert.equal(authorization, 'Bearer xoxb-test')
  assert.equal(attachment.filename, 'candidate.pdf')
  assert.equal(attachment.mimeType, 'application/pdf')
  assert.equal(attachment.content.toString(), '%PDF-1.7\nresume bytes')
})

test('resolves missing Slack file metadata through files.info', async () => {
  let requestedFile = ''
  const attachment = await resolveResumeAttachment({
    caseRecord: { resumeFile: { id: 'F456' } },
    client: {
      files: {
        async info({ file }) {
          requestedFile = file
          return {
            file: {
              id: file,
              name: 'candidate.docx',
              mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              url_private_download: 'https://files.slack.com/files-pri/T123-F456/candidate.docx',
            },
          }
        },
      },
    },
    botToken: 'xoxb-test',
    fetchImpl: async () => new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]), { status: 200 }),
  })

  assert.equal(requestedFile, 'F456')
  assert.equal(attachment.filename, 'candidate.docx')
})

test('refreshes complete stored metadata through files.info before downloading', async () => {
  let filesInfoCalled = false
  let downloadedUrl = ''
  const attachment = await resolveResumeAttachment({
    caseRecord: {
      resumeFile: {
        id: 'F456',
        name: 'candidate.pdf',
        mimeType: 'application/pdf',
        downloadUrl: 'https://files.slack.com/files-pri/T123-F456/candidate.pdf',
      },
    },
    client: {
      files: {
        async info({ file }) {
          filesInfoCalled = true
          assert.equal(file, 'F456')
          return {
            file: {
              id: file,
              name: 'candidate.pdf',
              mimetype: 'application/pdf',
              url_private_download: 'https://files.slack.com/files-pri/T123-F456/refreshed.pdf',
            },
          }
        },
      },
    },
    botToken: 'xoxb-test',
    fetchImpl: async (url) => {
      downloadedUrl = url
      return new Response(Buffer.from('%PDF-1.7\ncontent'), { status: 200 })
    },
  })

  assert.equal(filesInfoCalled, true)
  assert.match(downloadedUrl, /refreshed\.pdf$/)
  assert.equal(attachment.filename, 'candidate.pdf')
})

test('falls back to stored download URL when files:read scope is missing', async () => {
  const attachment = await resolveResumeAttachment({
    caseRecord: {
      resumeFile: {
        id: 'F456',
        name: 'candidate.pdf',
        mimeType: 'application/pdf',
        downloadUrl: 'https://example.com/candidate.pdf',
      },
    },
    client: {
      files: {
        async info() {
          const error = new Error('An API error occurred: missing_scope')
          error.data = { error: 'missing_scope', needed: 'files:read' }
          throw error
        },
      },
    },
    botToken: 'xoxb-test',
    fetchImpl: async () => new Response(Buffer.from('%PDF-1.7\nresume bytes'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }),
  })

  assert.equal(attachment.filename, 'candidate.pdf')
  assert.equal(attachment.mimeType, 'application/pdf')
  assert.equal(attachment.content.toString(), '%PDF-1.7\nresume bytes')
})

test('rejects Slack private download URLs when files:read scope is missing', async () => {
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          id: 'F456',
          name: 'candidate.pdf',
          mimeType: 'application/pdf',
          downloadUrl: 'https://files.slack.com/files-pri/T123-F456/candidate.pdf',
        },
      },
      client: {
        files: {
          async info() {
            const error = new Error('An API error occurred: missing_scope')
            error.data = { error: 'missing_scope', needed: 'files:read' }
            throw error
          },
        },
      },
      botToken: 'xoxb-test',
      fetchImpl: async () => {
        throw new Error('Slack private URL should not be fetched without files:read')
      },
    }),
    /missing files:read access/i,
  )
})

test('returns null when files:read is missing and no stored download URL', async () => {
  const result = await resolveResumeAttachment({
    caseRecord: { resumeFile: { id: 'F456' } },
    client: {
      files: {
        async info() {
          const error = new Error('An API error occurred: missing_scope')
          error.data = { error: 'missing_scope', needed: 'files:read' }
          throw error
        },
      },
    },
    botToken: 'xoxb-test',
  })

  assert.equal(result, null)
})

test('rejects expired Slack private download URLs when files:read is missing', async () => {
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          id: 'F456',
          name: 'candidate.pdf',
          mimeType: 'application/pdf',
          downloadUrl: 'https://files.slack.com/files-pri/T123-F456/expired.pdf',
        },
      },
      client: {
        files: {
          async info() {
            const error = new Error('An API error occurred: missing_scope')
            error.data = { error: 'missing_scope', needed: 'files:read' }
            throw error
          },
        },
      },
      botToken: 'xoxb-test',
      fetchImpl: async () => new Response('Not found', { status: 404 }),
    }),
    /missing files:read access/i,
  )
})

test('rejects resumes larger than the configured source limit', async () => {
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          id: 'F789',
          name: 'large.pdf',
          mimeType: 'application/pdf',
          url_private_download: 'https://files.slack.com/files-pri/T123-F789/large.pdf',
        },
      },
      botToken: 'xoxb-test',
      maxBytes: 4,
      fetchImpl: async () => new Response(Buffer.from('too large'), { status: 200 }),
    }),
    /larger than the 0 MB attachment limit/,
  )
})

test('rejects a Slack browser page returned with HTTP 200 instead of a PDF', async () => {
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          id: 'F999',
          name: 'candidate.pdf',
          mimeType: 'application/pdf',
          url_private_download: 'https://files.slack.com/files-pri/T123-F999/candidate.pdf',
        },
      },
      botToken: 'xoxb-test',
      fetchImpl: async () => new Response(
        Buffer.from('<!DOCTYPE html><html><body>This browser is no longer supported</body></html>'),
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
    }),
    /sign-in page instead of the resume file/i,
  )
})

test('rejects non-PDF bytes labeled as a PDF', async () => {
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          name: 'candidate.pdf',
          mimeType: 'application/pdf',
          downloadUrl: 'https://example.com/candidate.pdf',
        },
      },
      fetchImpl: async () => new Response(Buffer.from('not a PDF'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    }),
    /not a valid PDF/i,
  )
})

test('retries with a fresh files.info URL when first download returns HTML', async () => {
  let filesInfoCalls = 0
  let downloadedUrls = []
  const attachment = await resolveResumeAttachment({
    caseRecord: {
      id: 'case-1',
      resumeFile: {
        id: 'F123',
        name: 'candidate.pdf',
        mimeType: 'application/pdf',
        downloadUrl: 'https://files.slack.com/files-pri/T123-F123/stale.pdf',
      },
    },
    client: {
      files: {
        async info({ file }) {
          filesInfoCalls += 1
          return {
            file: {
              id: file,
              name: 'candidate.pdf',
              mimetype: 'application/pdf',
              url_private_download: filesInfoCalls === 1
                ? 'https://files.slack.com/files-pri/T123-F123/stale.pdf'
                : 'https://files.slack.com/files-pri/T123-F123/fresh.pdf',
            },
          }
        },
      },
    },
    botToken: 'xoxb-test',
    fetchImpl: async (url) => {
      downloadedUrls.push(url)
      if (url.includes('stale.pdf')) {
        return new Response(
          Buffer.from('<!DOCTYPE html><html><body>Sign in to Slack</body></html>'),
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      }
      return new Response(Buffer.from('%PDF-1.7\nfresh content'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
    },
    logger: { warn() {} },
  })

  assert.equal(filesInfoCalls, 2)
  assert.equal(downloadedUrls.length, 2)
  assert.match(downloadedUrls[1], /fresh\.pdf$/)
  assert.equal(attachment.filename, 'candidate.pdf')
  assert.equal(attachment.content.toString(), '%PDF-1.7\nfresh content')
})

test('throws original error after retry also returns HTML', async () => {
  let filesInfoCalls = 0
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        id: 'case-2',
        resumeFile: {
          id: 'F456',
          name: 'resume.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          downloadUrl: 'https://files.slack.com/files-pri/T123-F456/broken.pdf',
        },
      },
      client: {
        files: {
          async info() {
            filesInfoCalls += 1
            return {
              file: {
                id: 'F456',
                name: 'resume.docx',
                mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                url_private_download: 'https://files.slack.com/files-pri/T123-F456/also-broken.pdf',
              },
            }
          },
        },
      },
      botToken: 'xoxb-test',
      fetchImpl: async () => new Response(
        Buffer.from('<html><body>This browser is no longer supported</body></html>'),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
      logger: { warn() {} },
    }),
    /sign-in page instead of the resume file/i,
  )
  assert.equal(filesInfoCalls, 2)
})

test('retry is skipped when files.info was never called (no hasFreshUrl)', async () => {
  let fetchCount = 0
  await assert.rejects(
    resolveResumeAttachment({
      caseRecord: {
        resumeFile: {
          name: 'candidate.pdf',
          mimeType: 'application/pdf',
          downloadUrl: 'https://files.slack.com/files-pri/T123-F999/candidate.pdf',
        },
      },
      botToken: 'xoxb-test',
      fetchImpl: async () => {
        fetchCount += 1
        return new Response(
          Buffer.from('<!DOCTYPE html><html><body>Sign in</body></html>'),
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      },
      logger: { warn() {} },
    }),
    /sign-in page instead of the resume file/i,
  )
  // No client was provided, so files.info was never called.
  // Should fail immediately without retrying.
  assert.equal(fetchCount, 1)
})

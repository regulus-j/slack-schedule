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
      authorization = options.headers.authorization
      return new Response(Buffer.from('resume bytes'), {
        status: 200,
        headers: { 'content-length': '12' },
      })
    },
  })

  assert.equal(authorization, 'Bearer xoxb-test')
  assert.equal(attachment.filename, 'candidate.pdf')
  assert.equal(attachment.mimeType, 'application/pdf')
  assert.equal(attachment.content.toString(), 'resume bytes')
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
    fetchImpl: async () => new Response(Buffer.from('docx'), { status: 200 }),
  })

  assert.equal(requestedFile, 'F456')
  assert.equal(attachment.filename, 'candidate.docx')
})

test('uses complete stored metadata without calling files.info', async () => {
  let filesInfoCalled = false
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
        async info() {
          filesInfoCalled = true
          throw new Error('files.info should not be called')
        },
      },
    },
    botToken: 'xoxb-test',
    fetchImpl: async () => new Response(Buffer.from('pdf'), { status: 200 }),
  })

  assert.equal(filesInfoCalled, false)
  assert.equal(attachment.filename, 'candidate.pdf')
})

test('explains that missing files:read requires a Slack app reinstall', async () => {
  await assert.rejects(
    resolveResumeAttachment({
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
    }),
    /missing the files:read scope.*Reinstall the app/i,
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

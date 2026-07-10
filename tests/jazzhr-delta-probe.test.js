import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProbeConfig,
  interpretProbeResults,
  runJazzhrDeltaProbe,
  summarizeResponse,
} from '../scripts/jazzhr-delta-probe.js'

test('buildProbeConfig defaults to a seven day probe window and safe page caps', () => {
  const config = buildProbeConfig({
    JAZZHR_API_KEY: 'key',
    JAZZHR_PROBE_TO_DATE: '2026-06-25',
  })

  assert.equal(config.apiKey, 'key')
  assert.equal(config.fromDate, '2026-06-18')
  assert.equal(config.toDate, '2026-06-25')
  assert.equal(config.fullScanPages, 3)
  assert.equal(config.jobSampleLimit, 3)
})

test('summarizeResponse extracts candidate identifiers without retaining full PII fields', () => {
  const summary = summarizeResponse({
    path: '/activities',
    status: 200,
    ok: true,
    durationMs: 5,
    textLength: 100,
    body: [
      {
        applicant_id: 'prospect-1',
        category: 'workflow',
        email: 'person@example.com',
        updated_at: '2026-06-25T01:02:03Z',
      },
    ],
  }, { kind: 'activities' })

  assert.deepEqual(summary.candidateIds, ['prospect-1'])
  assert.deepEqual(summary.detectedDateFields, ['updated_at'])
  assert.ok(summary.sample[0].keys.includes('email'))
  assert.equal(summary.sample[0].email, undefined)
})

test('runJazzhrDeltaProbe recommends activity delta sync when activities expose applicant ids', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname
    const search = new URL(String(url)).search
    requested.push(`${path}${search.replace(/apikey=[^&]+/, 'apikey=[redacted]')}`)
    if (path === '/v1/activities') {
      return jsonResponse([{ applicant_id: 'prospect-1', updated_at: '2026-06-25' }])
    }
    if (path === '/v1/applicants') {
      return jsonResponse([{ id: 'prospect-new', apply_date: '2026-06-24' }])
    }
    if (path === '/v1/jobs') {
      return jsonResponse([{ id: 'job-open', status: 'Open' }])
    }
    if (path === '/v1/jobs/job-open') {
      return jsonResponse({ id: 'job-open', job_applicants: [{ prospect_id: 'prospect-1' }] })
    }
    if (path === '/v1/applicants/page/2' || path === '/v1/applicants/page/3') {
      return jsonResponse([])
    }
    throw new Error(`Unexpected path ${path}`)
  }

  const result = await runJazzhrDeltaProbe({
    config: {
      apiKey: 'key',
      baseUrl: 'https://api.resumatorapi.com/v1',
      fromDate: '2026-06-18',
      toDate: '2026-06-25',
      fullScanPages: 2,
      jobSampleLimit: 1,
      timeoutMs: 1000,
    },
    fetchImpl,
  })

  assert.equal(result.decision.recommendation, 'activity_delta_sync')
  assert.equal(result.decision.activitiesUseful, true)
  assert.equal(result.openJobSync.sampledJobs[0].applicantRefs, 1)
  assert.ok(requested.some((path) => path.startsWith('/v1/activities?from_date=2026-06-18')))
})

test('interpretProbeResults falls back to scheduled full sync when no efficient delta path is proven', () => {
  const result = interpretProbeResults({
    lookback: { fromDate: '2026-06-18', toDate: '2026-06-25' },
    activities: { ok: true, candidateIds: [], count: 0 },
    applicantDateFilters: { ok: true, count: 0 },
    openJobSync: { ok: true, openJobs: 0 },
    fullScanBaseline: { estimatedRequestsForFullScan: 'at least 3' },
  })

  assert.equal(result.decision.recommendation, 'scheduled_full_sync')
  assert.equal(result.decision.activitiesUseful, false)
})

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body)
    },
  }
}

// Phase 0 probe: verify /applicants?job_id={jobId} behaviour before Phase 1 refactor.
// Usage: node scripts/jazzhr-job-applicants-probe.js
// Requires: JAZZHR_API_KEY (or JAZZHR_ACCOUNT_KEYS + JAZZHR_API_KEY_<KEY>) in env.

import { loadConfig } from '../src/config.js'

const BASE = 'https://api.resumatorapi.com/v1'

async function main() {
  const config = loadConfig()
  const accounts = config.jazzhr.accounts || []

  if (accounts.length === 0) {
    console.error('No JazzHR accounts configured.')
    process.exit(1)
  }

  const account = accounts[0]
  const apiKey = account.apiKey
  console.log(`Using account: ${account.key} (${account.displayName})`)

  // Step 1: find an open job to test with
  console.log('\n--- Step 1: fetch open jobs ---')
  const jobsRes = await fetch(`${BASE}/jobs?apikey=${encodeURIComponent(apiKey)}`)
  if (!jobsRes.ok) {
    console.error(`/jobs returned ${jobsRes.status}: ${await jobsRes.text().catch(() => '')}`)
    process.exit(1)
  }
  const allJobs = await jobsRes.json()
  const jobs = Array.isArray(allJobs) ? allJobs : (allJobs.jobs || allJobs.data || [])
  const openJobs = jobs.filter((j) => {
    const s = String(j.status || '').trim().toLowerCase()
    return s === 'open' || s === 'active' || s === 'published'
  })
  console.log(`Found ${openJobs.length} open jobs out of ${jobs.length} total`)

  if (openJobs.length === 0) {
    console.log('No open jobs found — trying first job with applicants')
    const jobsWithApplicants = jobs.filter((j) => {
      const refs = Array.isArray(j.job_applicants) ? j.job_applicants : []
      return refs.length > 0
    })
    if (jobsWithApplicants.length === 0) {
      console.error('No jobs with applicants found.')
      process.exit(1)
    }
    openJobs.push(jobsWithApplicants[0])
  }

  // Pick a job with applicants
  let testJob = null
  for (const job of openJobs) {
    const refs = Array.isArray(job.job_applicants) ? job.job_applicants : []
    if (refs.length >= 5) {
      testJob = job
      break
    }
  }
  if (!testJob) testJob = openJobs[0]

  const jobId = testJob.id || testJob.job_id
  const jobTitle = testJob.title || testJob.job_title || ''
  const refs = Array.isArray(testJob.job_applicants) ? testJob.job_applicants : []
  console.log(`\nTest job: "${jobTitle}" (id=${jobId}), ${refs.length} applicant refs`)

  // Step 2: test /applicants?job_id={jobId}
  console.log('\n--- Step 2: test GET /applicants?job_id={jobId} ---')
  const page1Url = `${BASE}/applicants?job_id=${encodeURIComponent(jobId)}&apikey=${encodeURIComponent(apiKey)}&page=1`
  console.log(`Fetching page 1...`)
  const page1Res = await fetch(page1Url)
  console.log(`Status: ${page1Res.status}`)
  logRateLimitHeaders(page1Res)

  if (!page1Res.ok) {
    const body = await page1Res.text().catch(() => '')
    console.error(`Error body: ${body.slice(0, 500)}`)
    process.exit(1)
  }

  const page1Data = await page1Res.json()
  const page1Count = Array.isArray(page1Data) ? page1Data.length : 0
  console.log(`Page 1 results: ${page1Count}`)

  // Inspect first result shape
  const items = Array.isArray(page1Data) ? page1Data : []
  if (items.length > 0) {
    console.log('\n--- First applicant field inventory ---')
    const first = items[0]
    const fields = Object.keys(first).sort()
    console.log(`Fields (${fields.length}): ${fields.join(', ')}`)

    // Check critical fields
    const critical = [
      'id', 'first_name', 'last_name', 'email', 'phone',
      'job_title', 'title',
      'applicant_progress', 'stage', 'status', 'disposition',
      'workflow_step_id', 'workflow_step', 'workflow_category',
      'recruiter_id', 'recruiter_email', 'recruiter_name',
      'apply_date', 'applied_at', 'date_applied', 'date',
    ]
    console.log('\nCritical field values (first applicant):')
    for (const field of critical) {
      const val = first[field]
      if (val !== undefined) {
        const display = typeof val === 'string' ? val.slice(0, 80) : JSON.stringify(val).slice(0, 80)
        console.log(`  ${field}: ${display}`)
      }
    }

    // Check if there's a jobs array (nested)
    if (first.jobs) {
      const jobsArr = Array.isArray(first.jobs) ? first.jobs : []
      console.log(`\n  jobs array: ${jobsArr.length} entries`)
      if (jobsArr.length > 0) {
        console.log(`  First job fields: ${Object.keys(jobsArr[0]).join(', ')}`)
      }
    } else {
      console.log('\n  No nested "jobs" array — flat structure')
    }
  }

  // Step 3: check pagination
  console.log('\n--- Step 3: pagination ---')
  if (page1Count === 100) {
    console.log('Page 1 is full (100). Fetching page 2...')
    const page2Url = `${BASE}/applicants?job_id=${encodeURIComponent(jobId)}&apikey=${encodeURIComponent(apiKey)}&page=2`
    const page2Res = await fetch(page2Url)
    console.log(`Page 2 status: ${page2Res.status}`)
    logRateLimitHeaders(page2Res)
    const page2Data = await page2Res.json()
    const page2Count = Array.isArray(page2Data) ? page2Data.length : 0
    console.log(`Page 2 results: ${page2Count}${page2Count < 100 ? ' ← LAST PAGE (partial)' : ''}`)

    if (page2Count === 100) {
      console.log('Page 2 also full. Fetching page 3...')
      const page3Res = await fetch(`${BASE}/applicants?job_id=${encodeURIComponent(jobId)}&apikey=${encodeURIComponent(apiKey)}&page=3`)
      const page3Data = await page3Res.json()
      const page3Count = Array.isArray(page3Data) ? page3Data.length : 0
      console.log(`Page 3 results: ${page3Count}${page3Count < 100 ? ' ← LAST PAGE' : ''}`)
    }
  } else {
    console.log(`Page 1 is partial (${page1Count}/100) — no further pages.`)
  }

  // Summary
  const totalFromRefs = refs.length
  const totalFromPages = page1Count // we could sum pages but good enough for verification
  console.log(`\n=== SUMMARY ===`)
  console.log(`Applicant refs on /jobs response: ${totalFromRefs}`)
  console.log(`Applicants from /applicants?job_id= page 1: ${page1Count}`)
  console.log(`job_id filter works: ${page1Count > 0 ? 'YES ✓' : 'NO ✗ (or job has no applicants)'}`)
}

function logRateLimitHeaders(res) {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const limit = res.headers.get('x-ratelimit-limit')
  const reset = res.headers.get('x-ratelimit-reset')
  if (remaining || limit || reset) {
    console.log(`  Rate-limit headers: limit=${limit || '?'} remaining=${remaining || '?'} reset=${reset || '?'}`)
  } else {
    console.log('  No rate-limit headers found')
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message)
  process.exit(1)
})

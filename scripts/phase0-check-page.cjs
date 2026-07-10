// Quick check: does /applicants/page/N return richer fields than /applicants?job_id= ?
const BASE = 'https://api.resumatorapi.com/v1'

async function main() {
  const { loadConfig } = await import('../src/config.js')
  const config = loadConfig()
  const apiKey = config.jazzhr.accounts[0]?.apiKey
  if (!apiKey) { console.error('No API key'); process.exit(1) }

  // 1. /applicants?job_id=  (list endpoint with filter)
  const jobId = 'job_20260702011624_WQN7LJUCK52D4FAM' // from probe
  const listRes = await fetch(`${BASE}/applicants?job_id=${jobId}&apikey=${encodeURIComponent(apiKey)}&page=1`)
  const listData = await listRes.json()
  const listFirst = Array.isArray(listData) ? listData[0] : null

  // 2. /applicants/page/1  (paginated list, no filter)
  const pageRes = await fetch(`${BASE}/applicants/page/1?apikey=${encodeURIComponent(apiKey)}`)
  const pageData = await pageRes.json()
  const pageFirst = Array.isArray(pageData) ? pageData[0] : null

  // 3. /applicants/{id} detail
  let detailKeys = []
  if (listFirst) {
    const detailRes = await fetch(`${BASE}/applicants/${encodeURIComponent(listFirst.id)}?apikey=${encodeURIComponent(apiKey)}`)
    const detailData = await detailRes.json()
    detailKeys = Object.keys(detailData).sort()
  }

  console.log('=== /applicants?job_id= fields ===')
  console.log(listFirst ? Object.keys(listFirst).sort().join(', ') : 'no data')

  console.log('\n=== /applicants/page/1 fields ===')
  console.log(pageFirst ? Object.keys(pageFirst).sort().join(', ') : 'no data')

  console.log('\n=== /applicants/{id} fields ===')
  console.log(detailKeys.join(', '))

  // Key fields check
  console.log('\n=== Critical field comparison ===')
  const critical = ['email', 'applicant_progress', 'stage', 'disposition', 'workflow_step_id', 'workflow_step', 'workflow_category', 'recruiter_id', 'recruiter_email', 'recruiter_name']
  for (const f of critical) {
    const list = listFirst ? (listFirst[f] !== undefined ? listFirst[f] : 'MISSING') : 'N/A'
    const page = pageFirst ? (pageFirst[f] !== undefined ? pageFirst[f] : 'MISSING') : 'N/A'
    const detail = detailKeys.includes(f) ? 'PRESENT' : 'MISSING'
    console.log(`  ${f}:  ?job_id=${typeof list === 'string' ? list.slice(0,30) : list}  |  /page/N=${typeof page === 'string' ? page.slice(0,30) : page}  |  /{id}=${detail}`)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })

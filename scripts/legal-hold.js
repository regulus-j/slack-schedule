import { loadConfig } from '../src/config.js'
import { createStore } from '../src/store/index.js'

async function run() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1])
  }
  const caseId = args.get('--case')
  const mode = args.get('--mode')
  if (!caseId || !['enable', 'disable'].includes(mode)) {
    throw new Error('Usage: npm run legal-hold -- --case case-id --mode enable|disable')
  }
  const config = loadConfig()
  const store = await createStore(config)
  await store.init()
  try {
    const current = await store.getCase(caseId)
    if (!current) throw new Error(`Case not found: ${caseId}`)
    const updated = await store.updateCase(caseId, { legalHold: mode === 'enable' })
    await store.addAudit({
      caseId,
      actorSlackUserId: null,
      action: mode === 'enable' ? 'legal_hold_enabled' : 'legal_hold_disabled',
    })
    console.log(JSON.stringify({ event: 'legal_hold_updated', caseId, legalHold: updated.legalHold }))
  } finally {
    await store.close?.()
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ severity: 'ERROR', event: 'legal_hold_failed', error: error.message }))
  process.exitCode = 1
})

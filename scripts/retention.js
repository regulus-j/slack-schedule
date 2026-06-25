import { loadConfig } from '../src/config.js'
import { createStore } from '../src/store/index.js'

export async function runRetention({ dryRun = process.argv.includes('--dry-run') } = {}) {
  const config = loadConfig()
  const store = await createStore(config)
  await store.init()
  try {
    const result = await store.purgeRetention({
      ...config.retention,
      authorizedGoogleUserIds: [
        ...config.security.recruitmentUserIds,
        ...config.security.adminUserIds,
        config.google.authSlackUserId,
      ].filter(Boolean),
      dryRun,
    })
    console.log(JSON.stringify({ event: 'retention_completed', ...result }))
    return result
  } finally {
    await store.close?.()
  }
}

if (!process.env.NODE_TEST_CONTEXT) {
  runRetention().catch((error) => {
    console.error(JSON.stringify({
      severity: 'ERROR',
      event: 'retention_failed',
      error: error.message,
    }))
    process.exitCode = 1
  })
}

import { loadConfig } from '../src/config.js'
import { createStore } from '../src/store/index.js'

async function run() {
  const config = loadConfig()
  if (!config.security.kmsKeyName) throw new Error('GOOGLE_KMS_KEY_NAME is required')
  const store = await createStore(config)
  await store.init()
  try {
    const ids = await store.listGoogleTokenIds()
    let rewritten = 0
    for (const id of ids) {
      const token = await store.getGoogleToken(id)
      if (!token) continue
      await store.saveGoogleToken(id, token)
      rewritten += 1
    }
    console.log(JSON.stringify({ event: 'google_tokens_reencrypted', rewritten }))
  } finally {
    await store.close?.()
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ severity: 'ERROR', event: 'google_token_reencryption_failed', error: error.message }))
  process.exitCode = 1
})

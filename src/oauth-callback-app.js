import { App } from '@slack/bolt'
import { loadConfig, validateStartupConfig } from './config.js'
import { createHttpServer } from './http-server.js'
import { createStore } from './store/index.js'
import { logger } from './logger.js'

export async function main() {
  const config = loadConfig()
  validateStartupConfig(config, { role: 'oauth-callback' })

  const store = await createStore(config)
  const slackApp = new App({ token: config.slack.botToken })
  let storeReady = false
  const httpServer = createHttpServer({
    config,
    store,
    logger,
    slackClient: slackApp.client,
    isReady: () => storeReady,
  })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(config.port, () => {
      httpServer.removeListener('error', reject)
      logger.info('oauth_callback_server_started', { port: config.port })
      resolve()
    })
  })

  try {
    await store.init()
    storeReady = true
  } catch (error) {
    await new Promise((resolve) => httpServer.close(resolve))
    await store.close?.()
    throw error
  }

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('oauth_callback_shutdown_started', { reason: signal })
    await new Promise((resolve) => httpServer.close(resolve))
    await store.close?.()
    logger.info('oauth_callback_shutdown_completed', { reason: signal })
  }

  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => logger.error('oauth_callback_shutdown_failed', { error })))
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => logger.error('oauth_callback_shutdown_failed', { error })))

  return { config, httpServer, store, shutdown }
}

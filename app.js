import { App } from '@slack/bolt'
import { loadConfig, validateStartupConfig } from './src/config.js'
import { createHttpServer } from './src/http-server.js'
import { createStore } from './src/store/index.js'
import { registerSlackHandlers } from './src/slack/handlers.js'
import { logger } from './src/logger.js'
import { loadTalentDirectory } from './src/services/talent-directory.js'
import { applyTestDirectoryData } from './src/services/test-directory-data.js'
import { hydrateJazzhrCacheFromStore, refreshJazzhrCache, refreshJazzhrOpenJobs } from './src/services/jazzhr.js'
import { ensureSlackDirectory, slackApiErrorDetails } from './src/services/slack-directory.js'
import { startEventLoopLagMonitor } from './src/event-loop-monitor.js'
import { createSlackAlertDispatcher } from './src/observability/slack-alerts.js'
import {
  backfillNotificationJobs,
  startNotificationWorker,
} from './src/workflow/notifications.js'

export async function main() {
  const config = loadConfig()
  validateStartupConfig(config)

  logger.info('google_redirect_uri_resolved', {
    redirectUri: config.google.redirectUri || '(not set)',
    googleConfigured: Boolean(config.google.clientId && config.google.clientSecret && config.google.sharedCalendarId),
  })
  if (config.env === 'production' && /^https?:\/\/localhost[/:]/.test(config.google.redirectUri)) {
    logger.warn('google_redirect_uri_localhost_in_production', {
      redirectUri: config.google.redirectUri,
      hint: 'Set GOOGLE_REDIRECT_URI or PUBLIC_BASE_URL to match your production domain.',
    })
  }
  const stopEventLoopMonitor = startEventLoopLagMonitor({ logger })
  const store = await createStore(config)
  await store.init()

  await loadTalentDirectory(config, store)
  await refreshJazzhrOpenJobs({ config, logger })
  const jazzhrHydration = await hydrateJazzhrCacheFromStore({ store, logger })
  applyTestDirectoryData(config, logger)

  const app = new App({
    token: config.slack.botToken,
    socketMode: true,
    appToken: config.slack.appToken,
  })
  app.error(async (error) => {
    logger.error('slack_bolt_unhandled_error', { error })
  })
  logger.setAlertDispatcher(createSlackAlertDispatcher({
    client: app.client,
    config,
  }))
  registerSlackHandlers(app, { config, store, logger })

  const httpServer = createHttpServer({ config, store, logger, slackClient: app.client })
  const httpServerStarted = await listenHttpServer(httpServer, config.port, logger)

  logger.info('recruiter_phone_export_configured', {
    configured: Boolean(config.recruiterPhoneExport.url && config.recruiterPhoneExport.token),
  })
  logger.info('role_assignment_export_configured', {
    configured: Boolean(config.roleAssignmentExport.url && config.roleAssignmentExport.token),
  })

  await app.start()
  logger.info('slack_app_started', { status: 'started' })

  if (config.notifications.enabled) {
    const backfill = await backfillNotificationJobs({ store, logger })
    logger.info('notification_jobs_backfilled', backfill)
  }
  const notificationWorker = startNotificationWorker({ store, client: app.client, config, logger })

  ensureSlackDirectory({ client: app.client, config, logger }).catch((error) => {
    logger.warn('slack_directory_startup_preload_failed', slackApiErrorDetails(error))
  })

  if (config.jazzhr.refreshOnStartup || jazzhrHydration.records === 0) {
    refreshJazzhrCache({ config, logger, store, throwOnError: false })
  } else {
    logger.info('jazzhr_startup_refresh_skipped', {
      reason: 'persisted_cache_available',
      records: jazzhrHydration.records,
    })
  }

  let shuttingDown = false
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('application_shutdown_started', { reason: signal })
    notificationWorker.stop()
    stopEventLoopMonitor()
    if (httpServerStarted) await new Promise((resolve) => httpServer.close(resolve))
    await app.stop()
    await store.close?.()
    logger.info('application_shutdown_completed', { reason: signal })
    if (exitCode) process.exitCode = exitCode
  }

  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => logger.fatal('shutdown_failed', { error })))
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => logger.fatal('shutdown_failed', { error })))
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_promise_rejection', {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    })
  })
  process.on('uncaughtException', (error) => {
    logger.fatal('uncaught_exception', { error })
    shutdown('uncaughtException', 1).catch((shutdownError) => {
      logger.fatal('shutdown_failed', { error: shutdownError })
    })
  })

  return { app, config, httpServer, store, shutdown }
}

function listenHttpServer(server, port, logger) {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      server.off('error', onError)
    }
    const onError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error.code === 'EADDRINUSE') {
        logger.warn('health_server_port_in_use', {
          error: error.message,
          code: error.code,
          port,
        })
        resolve(false)
        return
      }
      reject(error)
    }

    server.once('error', onError)
    server.listen(port, () => {
      if (settled) return
      settled = true
      cleanup()
      logger.info('health_server_started', { status: 'listening', port })
      resolve(true)
    })
  })
}

main().catch((error) => {
  logger.fatal('application_startup_failed', { error })
  process.exitCode = 1
})

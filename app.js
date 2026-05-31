import { App } from '@slack/bolt';
import { loadConfig, validateStartupConfig } from './src/config.js';
import { createHttpServer } from './src/http-server.js';
import { createStore } from './src/store/index.js';
import { registerSlackHandlers } from './src/slack/handlers.js';
import { logger } from './src/logger.js';
import { loadTalentDirectory } from './src/services/talent-directory.js';
import { hydrateJazzhrCacheFromStore, refreshJazzhrCache } from './src/services/jazzhr.js';

const config = loadConfig();
validateStartupConfig(config);

const store = await createStore(config);
await store.init();

await loadTalentDirectory(config, store);

const jazzhrHydration = await hydrateJazzhrCacheFromStore({ store, logger });

const app = new App({
  token: config.slack.botToken,
  socketMode: true,
  appToken: config.slack.appToken,
});

registerSlackHandlers(app, { config, store, logger });

const httpServer = createHttpServer({ config, store, logger });
httpServer.listen(config.port, () => {
  logger.info('health_server_started', { port: config.port });
});

logger.info('recruiter_phone_export_configured', {
  configured: Boolean(config.recruiterPhoneExport.url && config.recruiterPhoneExport.token),
});

await app.start();
logger.info('slack_app_started', { socketMode: true });

if (config.jazzhr.refreshOnStartup || jazzhrHydration.records === 0) {
  refreshJazzhrCache({ config, logger, store, throwOnError: false });
} else {
  logger.info('jazzhr_startup_refresh_skipped', {
    reason: 'persisted_cache_available',
    records: jazzhrHydration.records,
  });
}

import { App } from '@slack/bolt';
import { loadConfig, validateStartupConfig } from './src/config.js';
import { createHttpServer } from './src/http-server.js';
import { createStore } from './src/store/index.js';
import { registerSlackHandlers } from './src/slack/handlers.js';
import { logger } from './src/logger.js';
import { loadTalentDirectory } from './src/services/talent-directory.js';
import { refreshJazzhrCache } from './src/services/jazzhr.js';

const config = loadConfig();
validateStartupConfig(config);

const store = await createStore(config);
await store.init();

loadTalentDirectory(config);

await refreshJazzhrCache({ config, logger, throwOnError: true });

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

await app.start();
logger.info('slack_app_started', { socketMode: true });

import { createJsonStore } from './json-store.js';
import { createPostgresStore } from './postgres-store.js';

export async function createStore(config) {
  if (config.databaseUrl) {
    return createPostgresStore(config.databaseUrl, config.security?.encryptionKey);
  }
  return createJsonStore(config.runtimeDir, config.security?.encryptionKey);
}

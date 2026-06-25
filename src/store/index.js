import { createJsonStore } from './json-store.js';
import { createPostgresStore } from './postgres-store.js';
import { createTokenCipher } from '../security/token-cipher.js';

export async function createStore(config) {
  const tokenCipher = await createTokenCipher(config)
  if (config.database?.backend === 'cloudsql' || config.databaseUrl) {
    return createPostgresStore(config, tokenCipher);
  }
  return createJsonStore(config.runtimeDir, tokenCipher);
}

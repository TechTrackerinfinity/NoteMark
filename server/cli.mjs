import path from 'node:path';
import { startServer } from './index.mjs';

function integer(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

try {
  const app = await startServer({
    host: process.env.HOST || '0.0.0.0',
    port: integer('PORT', 47821),
    dataDir: path.resolve(process.env.DATA_DIR || 'data'),
    allowVaultCreation: process.env.ALLOW_VAULT_CREATION !== 'false',
    trustProxy: process.env.TRUST_PROXY === 'true',
    maxVaults: integer('MAX_VAULTS', 100),
    maxNotesPerVault: integer('MAX_NOTES_PER_VAULT', 5000),
    maxVaultBytes: integer('MAX_VAULT_BYTES', 64 * 1024 * 1024),
    maxTotalBytes: integer('MAX_TOTAL_BYTES', 512 * 1024 * 1024),
    creationRateLimit: integer('CREATION_RATE_LIMIT', 10),
    authRateLimit: integer('AUTH_RATE_LIMIT', 120),
    onError: error => console.error(error.message),
  });
  console.log(`NoteMark sync protocol 1 listening on port ${app.port}`);
  for (const url of app.urls) console.log(url);
  console.log('Use HTTPS through a reverse proxy for internet connections.');
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(`Cannot start sync server: ${error.code || error.message}`);
  process.exitCode = 1;
}

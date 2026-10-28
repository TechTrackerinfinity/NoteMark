import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

// No note plaintext or encryption keys are accepted by this service.
export const PROTOCOL = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_HASH = createHash('sha256').update('unavailable vault').digest();
const DEFAULTS = {
  host: '127.0.0.1', port: 47821, dataDir: path.resolve('data'),
  allowVaultCreation: true, trustProxy: false,
  maxBodyBytes: 2 * 1024 * 1024, maxCiphertextBytes: 1024 * 1024 + 16,
  maxNotesPerVault: 5000, maxVaultBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024, maxVaults: 100,
  creationRateLimit: 10, creationWindowMs: 60 * 60 * 1000,
  authRateLimit: 120, authWindowMs: 60 * 1000,
};

class HttpError extends Error {
  constructor(status, error, details = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...details };
  }
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'invalid_id');
  return value.toLowerCase();
}

function base64url(value, minBytes, maxBytes, field) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, `invalid_${field}`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64url') !== value) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return value;
}

function shape(body, keys) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key))) {
    throw new HttpError(400, 'invalid_fields');
  }
}

function hashToken(value) {
  return createHash('sha256').update(value).digest();
}

async function readJson(req, maxBytes) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    req.resume();
    throw new HttpError(415, 'json_required');
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw new HttpError(413, 'body_too_large');
  }
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const clean = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onError = () => { clean(); reject(new HttpError(400, 'invalid_request')); };
    const onAborted = () => { clean(); reject(new HttpError(400, 'invalid_request')); };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        clean();
        req.resume();
        reject(new HttpError(413, 'body_too_large'));
      } else chunks.push(chunk);
    };
    const onEnd = () => { clean(); resolve(Buffer.concat(chunks)); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function makeLimiter(limit, windowMs) {
  const entries = new Map();
  return key => {
    const now = Date.now();
    if (entries.size >= 10_000) {
      for (const [key, value] of entries) if (value.until <= now) entries.delete(key);
    }
    const value = entries.get(key);
    if (!value || value.until <= now) {
      if (entries.size >= 10_000 && !value) throw new HttpError(429, 'rate_limited');
      entries.set(key, { count: 1, until: now + windowMs });
    } else if (value.count >= limit) {
      const error = new HttpError(429, 'rate_limited');
      error.retryAfter = Math.max(1, Math.ceil((value.until - now) / 1000));
      throw error;
    } else value.count++;
  };
}

function lockQueue() {
  const locks = new Map();
  return async (key, task) => {
    const pending = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    locks.set(key, pending);
    try { return await pending; }
    finally { if (locks.get(key) === pending) locks.delete(key); }
  };
}

async function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    // Directory fsync is unavailable on Windows. The file itself is flushed on all platforms.
    if (process.platform !== 'win32') {
      try {
        const directory = await open(path.dirname(filename), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* Some filesystems do not support directory fsync; the rename has committed. */ }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function publicUrls(host, port) {
  if (host !== '0.0.0.0' && host !== '::') return [`http://${host.includes(':') ? `[${host}]` : host}:${port}`];
  const addresses = new Set(['127.0.0.1']);
  for (const values of Object.values(networkInterfaces())) {
    for (const value of values ?? []) if (value.family === 'IPv4' && !value.internal) addresses.add(value.address);
  }
  return [...addresses].map(address => `http://${address}:${port}`);
}

/**
 * Start the protocol-1 ciphertext sync server. One process must own a dataDir.
 * Use a TLS reverse proxy for internet access. Returned close() waits for active writes.
 */
export async function startServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === 'number' && (!Number.isSafeInteger(config[key]) || config[key] < (key === 'port' ? 0 : 1))) {
      throw new TypeError(`Invalid server option: ${key}`);
    }
  }
  if (config.port > 65535 || typeof config.host !== 'string' || typeof config.dataDir !== 'string' ||
      typeof config.allowVaultCreation !== 'boolean' || typeof config.trustProxy !== 'boolean') throw new TypeError('Invalid server options');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const files = new Map();
  let totalBytes = 0;
  for (const entry of await readdir(config.dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !UUID.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json')) continue;
    const size = (await stat(path.join(config.dataDir, entry.name))).size;
    files.set(entry.name.slice(0, -5).toLowerCase(), size);
    totalBytes += size;
  }
  const vaults = new Map();
  const lock = lockQueue();
  const creationLimit = makeLimiter(config.creationRateLimit, config.creationWindowMs);
  const authLimit = makeLimiter(config.authRateLimit, config.authWindowMs);

  const clientIp = req => {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for']?.split(',')[0].trim();
      if (forwarded && isIP(forwarded)) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  const fileFor = vaultId => path.join(config.dataDir, `${vaultId}.json`);
  const persist = vault => lock('$storage', async () => {
    const bytes = Buffer.from(JSON.stringify(vault));
    const delta = bytes.length - (files.get(vault.id) ?? 0);
    if (bytes.length > config.maxVaultBytes) throw new HttpError(507, 'vault_storage_limit');
    if (totalBytes + delta > config.maxTotalBytes) throw new HttpError(507, 'server_storage_limit');
    await atomicWrite(fileFor(vault.id), bytes);
    files.set(vault.id, bytes.length);
    totalBytes += delta;
    vaults.set(vault.id, vault);
  });
  const load = async vaultId => {
    if (vaults.has(vaultId)) return vaults.get(vaultId);
    if (!files.has(vaultId)) return undefined;
    const vault = JSON.parse(await readFile(fileFor(vaultId), 'utf8'));
    if (vault.schema !== 1 || vault.id !== vaultId || !/^[a-f0-9]{64}$/.test(vault.tokenHash) ||
        vault.notes === null || typeof vault.notes !== 'object' || Array.isArray(vault.notes)) {
      throw new Error('Invalid vault file');
    }
    vaults.set(vaultId, vault);
    return vault;
  };
  const authorized = async (req, vaultId, task) => {
    authLimit(clientIp(req));
    return lock(vaultId, async () => {
      const vault = await load(vaultId);
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
      const provided = hashToken(match?.[1] ?? '');
      const expected = vault ? Buffer.from(vault.tokenHash, 'hex') : DUMMY_HASH;
      const equal = timingSafeEqual(provided, expected);
      if (!vault || !match || !equal) throw new HttpError(401, 'unauthorized');
      return task(vault);
    });
  };

  const activeRequests = new Set();
  const handleRequest = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Access-Control-Request-Private-Network');
    }
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    const send = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      if (status === 204) return res.end();
      const bytes = Buffer.from(JSON.stringify(body));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    };
    try {
      if (req.method === 'OPTIONS') return send(204);
      const url = new URL(req.url, 'http://localhost');
      if (url.search) throw new HttpError(400, 'query_not_supported');
      if (url.pathname === '/api/health' && req.method === 'GET') return send(200, { ok: true, protocol: PROTOCOL, capabilities: { permanentDelete: true } });
      if (url.pathname === '/api/vaults' && req.method === 'POST') {
        creationLimit(clientIp(req));
        if (!config.allowVaultCreation) throw new HttpError(403, 'vault_creation_disabled');
        const body = await readJson(req, config.maxBodyBytes);
        shape(body, ['id', 'token']);
        const vaultId = id(body.id);
        base64url(body.token, 32, 32, 'token');
        await lock('$create', async () => {
          if (files.has(vaultId)) throw new HttpError(409, 'vault_exists');
          if (files.size >= config.maxVaults) throw new HttpError(507, 'vault_count_limit');
          await persist({ schema: 1, id: vaultId, tokenHash: hashToken(body.token).toString('hex'), notes: {}, createdAt: new Date().toISOString() });
        });
        return send(201, { id: vaultId });
      }
      const route = /^\/api\/vaults\/([^/]+)\/notes(?:\/([^/]+))?$/.exec(url.pathname);
      if (!route) throw new HttpError(404, 'not_found');
      const vaultId = id(route[1]);
      if (req.method === 'GET' && !route[2]) {
        const result = await authorized(req, vaultId, vault => ({ notes: Object.values(vault.notes).sort((a, b) => a.id.localeCompare(b.id)) }));
        return send(200, result);
      }
      if (req.method === 'PUT' && route[2]) {
        const noteId = id(route[2]);
        // Authenticate before accepting a potentially large body, then again inside the write lock.
        await authorized(req, vaultId, () => undefined);
        const body = await readJson(req, config.maxBodyBytes);
        shape(body, ['baseRevision', 'iv', 'ciphertext', 'deleted']);
        if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || body.baseRevision >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, 'invalid_revision');
        if (typeof body.deleted !== 'boolean') throw new HttpError(400, 'invalid_deleted');
        base64url(body.iv, 12, 12, 'iv');
        base64url(body.ciphertext, 16, config.maxCiphertextBytes, 'ciphertext');
        // The credential cannot change, so this lock can reuse the authenticated vault.
        const record = await lock(vaultId, async () => {
          const vault = await load(vaultId);
          const current = vault.notes[noteId];
          if (current?.deleted) throw new HttpError(409, 'conflict', { current });
          if ((current?.revision ?? 0) !== body.baseRevision) throw new HttpError(409, 'conflict', { current: current ?? null });
          if (!current && Object.keys(vault.notes).length >= config.maxNotesPerVault) throw new HttpError(507, 'note_count_limit');
          const record = { id: noteId, revision: body.baseRevision + 1, iv: body.iv, ciphertext: body.ciphertext, deleted: body.deleted, updatedAt: new Date().toISOString() };
          await persist({ ...vault, notes: { ...vault.notes, [noteId]: record } });
          return record;
        });
        return send(200, record);
      }
      res.setHeader('Allow', route[2] ? 'PUT, OPTIONS' : 'GET, OPTIONS');
      throw new HttpError(405, 'method_not_allowed');
    } catch (error) {
      req.resume();
      if (error instanceof HttpError) {
        if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter ?? 60));
        if (error.status === 413) res.setHeader('Connection', 'close');
        send(error.status, error.body);
      } else {
        // Never log request headers, request bodies, credentials, or file contents.
        try { options.onError?.(new Error('Sync storage/request operation failed')); } catch { /* Logging must not interrupt a response. */ }
        send(500, { error: 'internal_error' });
      }
    }
  };
  const server = http.createServer((req, res) => {
    const pending = handleRequest(req, res);
    activeRequests.add(pending);
    void pending.finally(() => activeRequests.delete(pending));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  return {
    server, port, urls: publicUrls(config.host, port),
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...activeRequests]);
    },
  };
}

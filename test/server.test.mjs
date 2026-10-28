import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';

const token = () => randomBytes(32).toString('base64url');

function encrypted(text = 'Private note content', baseRevision = 0, deleted = false) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { baseRevision, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), deleted };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mira-sync-'));
  let app = await startServer({ port: 0, dataDir, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, bearer, raw, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, {
      method,
      headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const create = async (vaultId = randomUUID(), secret = token()) => {
    const result = await request('/api/vaults', { method: 'POST', body: { id: vaultId, token: secret } });
    assert.equal(result.status, 201);
    return { id: vaultId, token: secret, route: `/api/vaults/${vaultId}/notes` };
  };
  return {
    dataDir, request, create,
    restart: async () => { await app.close(); app = await startServer({ port: 0, dataDir, ...options }); },
  };
}

test('health and cross-origin browser preflight', async t => {
  const { request } = await fixture(t);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, protocol: 1, capabilities: { permanentDelete: true } });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const preflight = await request('/api/vaults/any/notes', { method: 'OPTIONS', headers: { Origin: 'https://notes.example', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const lanPreflight = await request('/api/vaults/any/notes', { method: 'OPTIONS', headers: { Origin: 'https://appassets.androidplatform.net', 'Access-Control-Request-Private-Network': 'true', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(lanPreflight.status, 204);
  assert.equal(lanPreflight.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(lanPreflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), null);
});

test('unknown vault and invalid credentials return the same unauthorized response', async t => {
  const { request, create } = await fixture(t);
  const vault = await create();
  for (const bearer of [undefined, token(), 'short']) {
    const result = await request(vault.route, { bearer });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'unauthorized' });
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
  }
  const unknown = await request(`/api/vaults/${randomUUID()}/notes`, { bearer: vault.token });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, { error: 'unauthorized' });
  assert.equal((await request(`${vault.route}?token=${vault.token}`)).status, 400);
  const blockedWrite = await request(`${vault.route}/${randomUUID()}`, { method: 'PUT', body: encrypted() });
  assert.equal(blockedWrite.status, 401);
});

test('ciphertext and token digest persist across restart without note plaintext', async t => {
  const { request, create, dataDir, restart } = await fixture(t);
  const vault = await create();
  const noteId = randomUUID();
  const plaintext = 'This private note must never be stored as plaintext';
  const payload = encrypted(plaintext);
  const result = await request(`${vault.route}/${noteId}`, { method: 'PUT', bearer: vault.token, body: payload });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, noteId);
  assert.equal(result.body.revision, 1);
  assert.equal(result.body.ciphertext, payload.ciphertext);
  assert.equal(result.body.iv, payload.iv);
  assert.equal(result.body.deleted, false);
  assert.equal(new Date(result.body.updatedAt).toISOString(), result.body.updatedAt);
  const files = await readdir(dataDir);
  assert.deepEqual(files, [`${vault.id}.json`]);
  const stored = await readFile(path.join(dataDir, files[0]), 'utf8');
  assert.ok(!stored.includes(plaintext));
  assert.ok(!stored.includes(vault.token));
  assert.match(JSON.parse(stored).tokenHash, /^[a-f0-9]{64}$/);
  await restart();
  const listed = await request(vault.route, { bearer: vault.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.notes, [result.body]);
});

test('simultaneous changes have exactly one winner and return its revision in conflicts', async t => {
  const { request, create } = await fixture(t, { authRateLimit: 1000 });
  const vault = await create();
  const noteId = randomUUID();
  const route = `${vault.route}/${noteId}`;
  const changes = Array.from({ length: 12 }, (_, index) => encrypted(`change ${index}`));
  const results = await Promise.all(changes.map(body => request(route, { method: 'PUT', bearer: vault.token, body })));
  const winners = results.filter(result => result.status === 200);
  const conflicts = results.filter(result => result.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 11);
  assert.equal(winners[0].body.revision, 1);
  for (const result of conflicts) assert.deepEqual(result.body, { error: 'conflict', current: winners[0].body });
  const nextResults = await Promise.all([1, 2].map(index => request(route, { method: 'PUT', bearer: vault.token, body: encrypted(`updated ${index}`, 1) })));
  assert.deepEqual(nextResults.map(result => result.status).sort(), [200, 409]);
  assert.equal(nextResults.find(result => result.status === 200).body.revision, 2);
});

test('concurrent writes to different notes and vaults all survive', async t => {
  const { request, create, restart } = await fixture(t);
  const vaults = await Promise.all([create(), create()]);
  const writes = await Promise.all(vaults.flatMap(vault => Array.from({ length: 5 }, () => request(`${vault.route}/${randomUUID()}`, { method: 'PUT', bearer: vault.token, body: encrypted() }))));
  assert.ok(writes.every(result => result.status === 200));
  await restart();
  for (const vault of vaults) {
    const result = await request(vault.route, { bearer: vault.token });
    assert.equal(result.body.notes.length, 5);
  }
});

test('deletion tombstones remain persisted and stale clients cannot overwrite them', async t => {
  const { request, create, restart } = await fixture(t);
  const vault = await create();
  const route = `${vault.route}/${randomUUID()}`;
  assert.equal((await request(route, { method: 'PUT', bearer: vault.token, body: encrypted() })).status, 200);
  const deletion = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('{}', 1, true) });
  assert.equal(deletion.status, 200);
  assert.equal(deletion.body.deleted, true);
  assert.equal(deletion.body.revision, 2);
  await restart();
  const stale = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('stale', 1) });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, deletion.body);
  for (const revision of [2, 100]) {
    const resurrection = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('resurrection', revision) });
    assert.equal(resurrection.status, 409); assert.deepEqual(resurrection.body.current, deletion.body);
  }
  assert.deepEqual((await request(vault.route, { bearer: vault.token })).body.notes, [deletion.body]);
});

test('invalid JSON, unexpected plaintext fields, identifiers, revisions and encodings fail', async t => {
  const { request, create } = await fixture(t);
  assert.equal((await request('/api/vaults', { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await request('/api/vaults', { method: 'POST', body: { id: '../escape', token: token() } })).status, 400);
  assert.equal((await request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: `${token()}=` } })).status, 400);
  assert.equal((await request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: token(), title: 'plaintext' } })).status, 400);
  const vault = await create();
  const good = encrypted();
  const invalid = [
    { ...good, baseRevision: -1 }, { ...good, baseRevision: 1.5 },
    { ...good, baseRevision: Number.MAX_SAFE_INTEGER }, { ...good, baseRevision: '0' },
    { ...good, deleted: 0 }, { ...good, iv: 'short' },
    { ...good, iv: `${good.iv}=` }, { ...good, ciphertext: 'short' },
    { ...good, ciphertext: `${good.ciphertext}=` }, { ...good, title: 'plaintext' },
    null, [],
  ];
  for (const body of invalid) {
    const result = await request(`${vault.route}/${randomUUID()}`, { method: 'PUT', bearer: vault.token, raw: JSON.stringify(body) });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal((await request(`${vault.route}/bad-id`, { method: 'PUT', bearer: vault.token, body: good })).status, 400);
  assert.equal((await request(`${vault.route}/${randomUUID()}`, { method: 'PUT', bearer: vault.token, raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(vault.route, { method: 'DELETE', bearer: vault.token })).status, 405);
  assert.equal((await request('/api/vaults')).status, 404);
  assert.equal((await request(vault.route, { bearer: vault.token })).body.notes.length, 0);
});

test('body, ciphertext and record count limits reject writes without changing stored notes', async t => {
  const { request, create } = await fixture(t, { maxBodyBytes: 512, maxCiphertextBytes: 64, maxNotesPerVault: 1 });
  const vault = await create();
  const route = `${vault.route}/${randomUUID()}`;
  const first = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('small') });
  assert.equal(first.status, 200);
  const extra = await request(`${vault.route}/${randomUUID()}`, { method: 'PUT', bearer: vault.token, body: encrypted('small') });
  assert.equal(extra.status, 507);
  assert.equal(extra.body.error, 'note_count_limit');
  const tooLargeCipher = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('a'.repeat(100), 1) });
  assert.equal(tooLargeCipher.status, 400);
  const tooLargeBody = await request(route, { method: 'PUT', bearer: vault.token, body: encrypted('a'.repeat(1000), 1) });
  assert.equal(tooLargeBody.status, 413);
  assert.deepEqual((await request(vault.route, { bearer: vault.token })).body.notes, [first.body]);
});

test('vault storage and global storage limits are enforced before atomic replacement', async t => {
  const small = await fixture(t, { maxVaultBytes: 500 });
  const vault = await small.create();
  const result = await small.request(`${vault.route}/${randomUUID()}`, { method: 'PUT', bearer: vault.token, body: encrypted('a'.repeat(500)) });
  assert.equal(result.status, 507);
  assert.equal(result.body.error, 'vault_storage_limit');
  assert.deepEqual((await small.request(vault.route, { bearer: vault.token })).body.notes, []);
  const global = await fixture(t, { maxTotalBytes: 1 });
  const creation = await global.request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: token() } });
  assert.equal(creation.status, 507);
  assert.equal(creation.body.error, 'server_storage_limit');
  assert.deepEqual(await readdir(global.dataDir), []);
});

test('vault creation can be disabled and duplicates do not reset credentials', async t => {
  const disabled = await fixture(t, { allowVaultCreation: false });
  const result = await disabled.request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: token() } });
  assert.equal(result.status, 403);
  const enabled = await fixture(t, { maxVaults: 1 });
  const vault = await enabled.create();
  assert.equal((await enabled.request('/api/vaults', { method: 'POST', body: { id: vault.id, token: token() } })).status, 409);
  assert.equal((await enabled.request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: token() } })).status, 507);
  assert.equal((await enabled.request(vault.route, { bearer: vault.token })).status, 200);
});

test('creation and authenticated routes are rate limited', async t => {
  const { request, create } = await fixture(t, { creationRateLimit: 1, authRateLimit: 2 });
  const vault = await create();
  assert.equal((await request('/api/vaults', { method: 'POST', body: { id: randomUUID(), token: token() } })).status, 429);
  assert.equal((await request(vault.route)).status, 401);
  assert.equal((await request(vault.route, { bearer: token() })).status, 401);
  const throttled = await request(vault.route, { bearer: vault.token });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

test('Android bridge responses drive encrypted sync without WebView fetch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mira-native-js-'));
  const server = await startServer({ port: 0, dataDir: directory });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const events = new EventTarget(), sent = [], realFetch = globalThis.fetch;
  globalThis.addEventListener = events.addEventListener.bind(events);
  globalThis.MiraAndroid = { postMessage: serialized => {
    const call = JSON.parse(serialized); sent.push(call);
    (async () => {
      if (call.op === 'simulate-timeout') return { id: call.id, error: 'Native connection timed out', code: 'timeout' };
      const { url, method, token, body } = call.args;
      const response = await realFetch(url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
      return { id: call.id, value: { status: response.status, data: await response.json() } };
    })().then(detail => events.dispatchEvent(new CustomEvent('mira-native-result', { detail })));
  } };
  globalThis.fetch = async () => { throw new Error('WebView networking must not be used on Android'); };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.MiraAndroid; delete globalThis.addEventListener; });
  const { Notebook, SyncEngine, createVault, checkVault } = await import('../web/core.mjs');
  const { androidNative, nativeCall } = await import('../web/native.mjs');
  assert.equal(androidNative, true);
  const config = await createVault('http://127.0.0.1:' + server.port);
  class Storage { data = new Map(); getItem(k) { return this.data.get(k) ?? null; } setItem(k, v) { this.data.set(k, v); } }
  const phone = new Notebook(new Storage()), pc = new Notebook(new Storage());
  phone.attach(config); pc.attach(config);
  const phoneEngine = new SyncEngine(phone), pcEngine = new SyncEngine(pc);
  const note = phone.create('note', { title: 'Native Android connection', body: 'A phone note reaches Windows.' });
  await phoneEngine.run(); await pcEngine.run(); assert.equal(phoneEngine.status, 'synced');
  assert.equal(pc.state.notes[note.id].body, 'A phone note reaches Windows.');
  pc.update(note.id, { body: 'The Windows edit returns to Android.' });
  await pcEngine.run(); await phoneEngine.run(); assert.equal(phone.state.notes[note.id].body, 'The Windows edit returns to Android.');
  await assert.rejects(checkVault({ ...config, token: Buffer.alloc(32, 4).toString('base64url') }), /key was rejected/);
  await assert.rejects(nativeCall('simulate-timeout'), error => error.name === 'TimeoutError');
  assert.ok(sent.some(call => call.args.method === 'PUT' && call.args.token === config.token));
  for (const call of sent.filter(call => call.args.method === 'PUT')) assert.equal(call.args.body.includes('phone note'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';
import { Notebook, SyncEngine, createVault, pairingCode, parsePairing, encryptNote, decryptNote, normalizeServer, probeServer, checkVault, payload } from '../web/core.mjs';
class MemoryStorage {
  data = new Map();
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, v); }
}
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mira-client-test-'));
  const server = await startServer({ port: 0, dataDir, authRateLimit: 10000 });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const config = await createVault('http://127.0.0.1:' + server.port);
  const a = new Notebook(new MemoryStorage()), b = new Notebook(new MemoryStorage());
  a.attach(config); b.attach(parsePairing(pairingCode(config)));
  return { a, b, ae: new SyncEngine(a), be: new SyncEngine(b), config, dataDir };
}
test('a note typed on mobile reaches desktop; desktop edit and trash/restore return to mobile', async t => {
  const { a, b, ae, be } = await setup(t);
  const n = a.create('task', { title: 'Phone shopping', tasks: [{ id: crypto.randomUUID(), text: 'Tea ☕', done: false }], color: 'sage', folder: 'Home', pinned: true });
  await ae.run(); await be.run(); assert.equal(be.status, 'synced'); assert.equal(b.state.notes[n.id].title, 'Phone shopping');
  b.update(n.id, { title: 'Edited at the desk', tasks: [{ ...n.tasks[0], done: true }] });
  await be.run(); await ae.run(); assert.equal(a.state.notes[n.id].title, 'Edited at the desk'); assert.equal(a.state.notes[n.id].tasks[0].done, true);
  b.update(n.id, { trashed: true }); await be.run(); await ae.run(); assert.equal(a.state.notes[n.id].trashed, true);
  a.update(n.id, { trashed: false }); await ae.run(); await be.run(); assert.equal(b.state.notes[n.id].trashed, false);
});
test('offline edits survive process restart and synchronize later', async t => {
  const { a, b, be } = await setup(t);
  const n = a.create('note', { title: 'Offline train ride', body: 'Still here after closing the app.' });
  const reopened = new Notebook(a.storage), engine = new SyncEngine(reopened);
  assert.equal(reopened.state.notes[n.id].dirty, true); await engine.run(); await be.run();
  assert.equal(b.state.notes[n.id].body, 'Still here after closing the app.'); assert.equal(reopened.state.notes[n.id].dirty, false);
});
test('simultaneous offline edits preserve both versions as a synced conflict copy', async t => {
  const { a, b, ae, be } = await setup(t);
  const n = a.create('note', { title: 'Shared plan', body: 'Original' }); await ae.run(); await be.run();
  a.update(n.id, { body: 'Desktop plan' }); b.update(n.id, { body: 'Phone plan' });
  await ae.run(); await be.run(); await be.run(); await ae.run();
  for (const book of [a, b]) {
    const notes = Object.values(book.state.notes); assert.equal(notes.length, 2);
    assert.deepEqual(new Set(notes.map(x => x.body)), new Set(['Desktop plan', 'Phone plan']));
    assert.equal(notes.filter(x => x.title.includes('conflict copy')).length, 1);
  }
});
test('edits typed while upload is in progress remain pending and upload next time', async t => {
  const { a, b, ae, be } = await setup(t);
  const n = a.create('note', { title: 'Live editing', body: 'Before request' });
  const originalFetch = globalThis.fetch; let edited = false;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!edited && options?.method === 'PUT') { edited = true; a.update(n.id, { body: 'Typed during upload' }); }
    return response;
  };
  try { await ae.run(); } finally { globalThis.fetch = originalFetch; }
  assert.equal(a.state.notes[n.id].dirty, true); assert.equal(a.state.notes[n.id].body, 'Typed during upload');
  await ae.run(); await be.run(); assert.equal(b.state.notes[n.id].body, 'Typed during upload');
});
test('lost successful response retries without duplicating a note', async t => {
  const { a, ae } = await setup(t); const n = a.create('note', { title: 'Ambiguous delivery', body: 'Do not duplicate me' });
  const originalFetch = globalThis.fetch; let dropped = false;
  globalThis.fetch = async (url, options) => { const response = await originalFetch(url, options); if (!dropped && options?.method === 'PUT') { dropped = true; throw new Error('Connection lost after commit'); } return response; };
  try { await ae.run(); } finally { globalThis.fetch = originalFetch; }
  assert.equal(ae.status, 'offline'); await ae.run(); assert.equal(ae.status, 'synced'); assert.equal(Object.keys(a.state.notes).length, 1); assert.equal(a.state.notes[n.id].dirty, false);
});
test('server stores ciphertext; wrong keys, swapped IDs and tampering cannot decrypt', async t => {
  const { a, ae, config, dataDir } = await setup(t);
  const n = a.create('note', { title: 'Private title 3487', body: 'Secret body 7091' }); await ae.run();
  const encrypted = await encryptNote(config, n), record = { id: n.id, revision: 1, ...encrypted };
  assert.equal((await decryptNote(config, record)).body, 'Secret body 7091');
  await assert.rejects(decryptNote({ ...config, key: Buffer.alloc(32, 7).toString('base64url') }, record));
  await assert.rejects(decryptNote(config, { ...record, id: crypto.randomUUID() }));
  const changed = Buffer.from(record.ciphertext, 'base64url'); changed[2] ^= 1;
  await assert.rejects(decryptNote(config, { ...record, ciphertext: changed.toString('base64url') }));
  const files = await readdir(dataDir, { recursive: true }); let disk = '';
  for (const file of files.filter(f => f.endsWith('.json'))) disk += await readFile(join(dataDir, file), 'utf8');
  assert.ok(!disk.includes(n.title) && !disk.includes(n.body) && !disk.includes(config.key) && !disk.includes(config.token));
});
test('long note encryption and backup import keep Unicode and checklist content', async t => {
  const { a, b, ae, be } = await setup(t);
  const body = 'A long thought 🧠 नमस्ते\n'.repeat(8000); const n = a.create('note', { title: 'A longer page', body });
  await ae.run(); assert.equal(ae.status, 'synced'); await be.run(); assert.equal(b.state.notes[n.id].body, body);
  const restored = new Notebook(new MemoryStorage()); assert.equal(restored.import(a.export()), 1); assert.equal(Object.values(restored.state.notes)[0].body, body);
});
test('invalid connection codes and insecure public HTTP addresses are rejected', () => {
  for (const address of ['http://example.com', 'http://10.evil.com', 'ftp://localhost', 'https://user:pass@example.com', 'https://example.com/?key=x']) assert.throws(() => normalizeServer(address));
  assert.equal(normalizeServer('http://192.168.1.10:47821/'), 'http://192.168.1.10:47821');
  assert.throws(() => parsePairing('bad-code')); assert.throws(() => parsePairing('mira1.ZmFrZQ'));
});
test('corrupt local storage is preserved for recovery instead of silently overwritten', () => {
  const storage = new MemoryStorage(); storage.setItem('mira.notes.v1', '{broken');
  const book = new Notebook(storage); assert.ok(book.loadError); assert.throws(() => book.create()); assert.equal(storage.getItem('mira.notes.v1'), '{broken');
});

test('phone health check distinguishes a reachable server from wrong credentials', async t => {
  const { config } = await setup(t);
  assert.deepEqual(await probeServer(config.server), { ok: true, protocol: 1, capabilities: { permanentDelete: true } });
  await assert.rejects(checkVault({ ...config, token: Buffer.alloc(32, 19).toString('base64url') }), /Connection key was rejected/);
});

test('a blocked phone-to-Windows connection explains the firewall repair without leaking keys', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException('signal timed out', 'TimeoutError'); };
  try {
    await assert.rejects(probeServer('http://192.168.1.50:47821'), error => {
      assert.equal(error.code, 'unreachable'); assert.match(error.message, /192\.168\.1\.50:47821/);
      assert.match(error.message, /Repair Wi-Fi access/); assert.match(error.message, /same Wi-Fi/); return true;
    });
  } finally { globalThis.fetch = savedFetch; }
});

test('health checks reject another application on the sync port', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, protocol: 99 }), { status: 200 });
  try { await assert.rejects(probeServer('http://127.0.0.1:47821'), /incompatible sync protocol/); }
  finally { globalThis.fetch = savedFetch; }
});

test('permanent deletion wipes contents, survives restart and defeats offline edits without conflict copies', async t => {
  const {a,b,ae,be,config}=await setup(t); const n=a.create('task',{title:'ERASE TITLE',body:'ERASE BODY',tasks:[{id:'x',text:'ERASE TASK',done:true}]});
  await ae.run(); await be.run(); b.update(n.id,{body:'Stale offline edit'});
  a.batchTrash([n.id],true); a.permanentlyDelete([n.id]);
  const saved=a.storage.getItem('mira.notes.v1'); for(const text of ['ERASE TITLE','ERASE BODY','ERASE TASK']) assert.ok(!saved.includes(text));
  const restarted=new Notebook(a.storage), de=new SyncEngine(restarted); assert.ok(restarted.state.deletions[n.id].dirty);
  await de.run(); await be.run(); assert.equal(be.status,'synced');
  for(const book of [restarted,b]) { assert.equal(Object.keys(book.state.notes).length,0); assert.equal(book.state.deletions[n.id].dirty,false); assert.equal(JSON.parse(book.export()).notes.length,0); }
  const response=await fetch(config.server+`/api/vaults/${config.id}/notes`,{headers:{Authorization:'Bearer '+config.token}}), data=await response.json();
  assert.equal(data.notes[0].deleted,true); const blank=await decryptNote(config,data.notes[0]); assert.equal(blank.title,''); assert.equal(blank.body,''); assert.deepEqual(blank.tasks,[]);
});
test('pending deletion retries a newer concurrent revision and an interrupted upload across restart',async t=>{
  const {a,b,ae,be}=await setup(t), n=a.create('note',{body:'Initial'}); await ae.run(); await be.run();
  a.batchTrash([n.id],true); a.permanentlyDelete([n.id]); b.update(n.id,{body:'New revision before deletion'}); await be.run();
  const real=globalThis.fetch; let lost=false;
  globalThis.fetch=async(url,options)=>{ const response=await real(url,options); if(options?.method==='PUT' && JSON.parse(options.body).deleted && response.ok && !lost){lost=true;throw new Error('Lost deletion response');} return response; };
  try {await ae.run();} finally{globalThis.fetch=real;}
  assert.equal(ae.status,'offline'); assert.equal(a.state.deletions[n.id].dirty,true);
  const reopened=new Notebook(a.storage), engine=new SyncEngine(reopened); await engine.run(); await be.run();
  assert.equal(engine.status,'synced'); assert.equal(reopened.state.deletions[n.id].dirty,false); assert.equal(Object.keys(b.state.notes).length,0);
});
test('deletion during an in-flight normal upload remains queued and cannot resurrect contents',async t=>{
  const {a,b,ae,be}=await setup(t); await ae.run(); const n=a.create('note',{body:'In flight'}); const real=globalThis.fetch; let deleted=false;
  globalThis.fetch=async(url,options)=>{const response=await real(url,options); if(options?.method==='PUT'&&!deleted){deleted=true;a.batchTrash([n.id],true);a.permanentlyDelete([n.id]);}return response;};
  try{await ae.run();}finally{globalThis.fetch=real;}
  assert.equal(a.state.notes[n.id],undefined); assert.ok(a.state.deletions[n.id].dirty); await ae.run(); await be.run(); assert.equal(Object.keys(b.state.notes).length,0);
});
test('unsupported hosts gate permanent deletion; known supported offline deletion stays queued',async t=>{
  const {a,ae}=await setup(t), n=a.create('note',{trashed:true}); assert.throws(()=>a.permanentlyDelete([n.id]),/Connect once/);
  const real=globalThis.fetch; globalThis.fetch=async(url,options)=>String(url).endsWith('/api/health')?new Response(JSON.stringify({ok:true,protocol:1})):real(url,options);
  try{await ae.run();assert.throws(()=>a.permanentlyDelete([n.id]),/Connect once/);}finally{globalThis.fetch=real;}
  await ae.run(); globalThis.fetch=async()=>{throw new Error('Offline');};
  try{a.permanentlyDelete([n.id]);await ae.run();assert.ok(a.state.deletions[n.id].dirty);}finally{globalThis.fetch=real;}
  await ae.run();assert.equal(a.state.deletions[n.id].dirty,false);
});

test('1.0 notebook state upgrades without losing notes, credentials, pairing codes or storage identity',async t=>{
  const {a,ae,config}=await setup(t); const n=a.create('task',{title:'Upgrade preservation',folder:'Original',pinned:true,tasks:[{id:'old-task',text:'Keep me',done:true}]}); await ae.run();
  const legacy=JSON.parse(a.storage.getItem('mira.notes.v1'));delete legacy.deletions;delete legacy.serverFeatures;
  a.storage.setItem('mira.notes.v1',JSON.stringify(legacy));const upgraded=new Notebook(a.storage);
  assert.equal(upgraded.loadError,null);assert.deepEqual(payload(upgraded.state.notes[n.id]),payload(a.state.notes[n.id]));
  assert.deepEqual(upgraded.state.config,config);assert.equal(pairingCode(upgraded.state.config),pairingCode(config));
  assert.deepEqual(upgraded.state.deletions,{});assert.equal(new SyncEngine(upgraded).status,'local');
});

// Invoked by the Android protocol integration test against the real Java socket server.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Notebook, SyncEngine, createVault, pairingCode, parsePairing, checkVault } from '../web/core.mjs';
const [server, fixture, phase] = process.argv.slice(2);
class MemoryStorage { data = new Map(); getItem(k) { return this.data.get(k) ?? null; } setItem(k, v) { this.data.set(k, v); } }
const a = new Notebook(new MemoryStorage()), b = new Notebook(new MemoryStorage());
const config = phase === 'create' ? await createVault(server) : JSON.parse(await readFile(fixture, 'utf8')).config;
a.attach(config); b.attach(parsePairing(pairingCode(config)));
const ae = new SyncEngine(a), be = new SyncEngine(b);
if (phase === 'create') {
  const note = a.create('task', { title: 'Phone hosted protocol test', body: 'Phone → Windows ☕ हिन्दी', tasks: [{ id: crypto.randomUUID(), text: 'Connect Windows to Android', done: false }] });
  await ae.run(); await be.run(); assert.equal(ae.status, 'synced'); assert.equal(be.status, 'synced');
  assert.equal(b.state.notes[note.id].body, note.body);
  b.update(note.id, { body: 'Windows → phone verified', tasks: [{ ...note.tasks[0], done: true }] });
  await be.run(); await ae.run(); assert.equal(a.state.notes[note.id].body, 'Windows → phone verified'); assert.ok(a.state.notes[note.id].tasks[0].done);
  a.update(note.id, { body: 'Phone offline edit' }); b.update(note.id, { body: 'Windows offline edit' });
  await ae.run(); await be.run(); await be.run(); await ae.run();
  assert.equal(Object.keys(a.state.notes).length, 1);
  assert.equal(a.state.notes[note.id].body, 'Phone offline edit\n\nWindows offline edit');
  assert.deepEqual(a.state.notes[note.id].tasks, b.state.notes[note.id].tasks);
  b.update(note.id, { trashed: true }); await be.run(); await ae.run(); assert.ok(a.state.notes[note.id].trashed);
  a.update(note.id, { trashed: false }); await ae.run(); await be.run(); assert.equal(b.state.notes[note.id].trashed, false);
  await assert.rejects(checkVault({ ...config, token: Buffer.alloc(32, 23).toString('base64url') }), /key was rejected/);
  const doomed = a.create('note', { title: 'Permanent deletion through Java host', body: 'Must not return' });
  await ae.run(); await be.run(); b.update(doomed.id, { body: 'Stale edit' });
  a.batchTrash([doomed.id], true); a.permanentlyDelete([doomed.id]);
  const reopened = new Notebook(a.storage); await new SyncEngine(reopened).run(); await be.run();
  assert.equal(b.state.notes[doomed.id], undefined); assert.ok(b.state.deletions[doomed.id]);
  // Both clients add while disconnected. The Java host must retain the new
  // encrypted timing/order metadata without depending on request arrival order.
  const timed = (id, createdAt) => ({ id, text: id, done: false, createdAt });
  a.update(note.id, { tasks: [...a.state.notes[note.id].tasks, timed('phone-early',100), timed('phone-late',400)] });
  b.update(note.id, { tasks: [...b.state.notes[note.id].tasks, timed('windows-first',200), timed('windows-second',300)] });
  for (const engine of [be,ae,be,ae]) await engine.run();
  assert.deepEqual(a.state.notes[note.id].tasks.filter(t=>t.createdAt!==undefined).map(t=>t.createdAt),[100,200,300,400]);
  b.placeTask(note.id, 'phone-late', 'phone-early', false); await be.run(); await ae.run();
  assert.deepEqual(a.state.notes[note.id].tasks,b.state.notes[note.id].tasks);
  await writeFile(fixture, JSON.stringify({ config, id: note.id, deleted: doomed.id, tasks:a.state.notes[note.id].tasks, taskOrder:a.state.notes[note.id].taskOrder }));
} else {
  await ae.run(); assert.equal(ae.status, 'synced'); assert.equal(Object.keys(a.state.notes).length, 1);
  const { id, deleted, tasks, taskOrder } = JSON.parse(await readFile(fixture, 'utf8'));
  assert.equal(a.state.notes[deleted], undefined); assert.ok(a.state.deletions[deleted]);
  assert.equal(a.state.notes[id].body, 'Phone offline edit\n\nWindows offline edit');
  assert.equal(a.state.notes[id].trashed, false);
  assert.deepEqual(a.state.notes[id].tasks,tasks); assert.deepEqual(a.state.notes[id].taskOrder,taskOrder);
  a.resetTaskOrder(id); await ae.run(); await be.run();
  assert.deepEqual(b.state.notes[id].tasks.filter(t=>t.createdAt!==undefined).map(t=>t.createdAt),[100,200,300,400]);
  b.create('note', { title: 'After phone server restart', body: 'Persisted notes remain editable.' });
  await be.run(); await ae.run(); assert.equal(Object.keys(a.state.notes).length, 2);
}
console.log(JSON.stringify({ ok: true, phase, notes: Object.keys(a.state.notes).length }));

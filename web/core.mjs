import { androidNative, desktopNative, nativeFetch } from './native.mjs';
const STORAGE = 'mira.notes.v1';
const COLORS = ['paper', 'butter', 'sage', 'rose', 'lavender', 'sky'];
export const colors = COLORS;
const encode = value => {
  let text = ''; for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lexical = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function validTaskOrder(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || !Array.isArray(value.ids) || value.ids.length > 2000 ||
      value.ids.some(id => typeof id !== 'string' || id.length > 2000) || new Set(value.ids).size !== value.ids.length ||
      !timestamp(value.updatedAt) || !uuidPattern.test(value.changeId) || value.legacyIds !== undefined &&
      (!Array.isArray(value.legacyIds) || value.legacyIds.length > 2000 || value.legacyIds.some(id => typeof id !== 'string' || id.length > 2000) || new Set(value.legacyIds).size !== value.legacyIds.length)) throw new Error('Invalid checklist order.');
  return { ids: [...value.ids], updatedAt: value.updatedAt, changeId: value.changeId, ...(value.legacyIds ? { legacyIds: [...value.legacyIds] } : {}) };
}
export function orderedTasks(note) {
  const positions = new Map((note.taskOrder?.ids || []).map((id, index) => [id, index]));
  const legacy = new Map([...new Set([...(note.taskOrder?.legacyIds || []), ...note.tasks.map(task => task.id)])].map((id,index) => [id,index]));
  return [...note.tasks].sort((a, b) => {
    if (positions.size) {
      const ap = positions.get(a.id), bp = positions.get(b.id);
      if (ap !== undefined || bp !== undefined) return (ap ?? Infinity) - (bp ?? Infinity);
    }
    // Earlier releases did not record item times. Keep those existing rows in order.
    if (a.createdAt === undefined || b.createdAt === undefined) {
      if (a.createdAt === undefined && b.createdAt === undefined) return legacy.get(a.id) - legacy.get(b.id);
      return a.createdAt === undefined ? -1 : 1;
    }
    return a.createdAt - b.createdAt || lexical(a.id, b.id);
  });
}
export function compareNotes(a, b, sort = 'oldest') {
  return Number(b.pinned) - Number(a.pinned) ||
    (sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? b.createdAt - a.createdAt : sort === 'updated' ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt) || lexical(a.id, b.id);
}
export function normalizeServer(value) {
  const u = new URL(value.trim());
  if (u.username || u.password || u.search || u.hash) throw new Error('Use a server address without a password, query, or fragment.');
  const h = u.hostname;
  const parts = h.split('.').map(Number), ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(h) && parts.every(n => n >= 0 && n <= 255);
  const local = h === 'localhost' || h === '[::1]' || (ipv4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Internet sync needs an https:// address. HTTP is available for a trusted local network.');
  return u.href.replace(/\/$/, '');
}
export function validNote(value) {
  if (!value || !uuidPattern.test(value.id) || typeof value.title !== 'string' || typeof value.body !== 'string') throw new Error('This file contains an invalid note.');
  if (value.title.length > 500 || value.body.length > 350000) throw new Error('A note is too large (title: 500, text: 350,000 characters).');
  if (!Array.isArray(value.tasks) || value.tasks.length > 2000) throw new Error('Invalid checklist.');
  const result = {
    id: value.id, title: value.title, body: value.body,
    type: value.type === 'task' ? 'task' : 'note', color: COLORS.includes(value.color) ? value.color : 'paper',
    pinned: !!value.pinned, folder: String(value.folder || '').slice(0, 60), trashed: !!value.trashed,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    tasks: value.tasks.map(t => {
      if (t.createdAt !== undefined && !timestamp(t.createdAt)) throw new Error('Invalid checklist item time.');
      return { id: String(t.id || crypto.randomUUID()), text: String(t.text || '').slice(0, 2000), done: !!t.done, ...(t.createdAt === undefined ? {} : { createdAt: t.createdAt }) };
    }),
    ...(value.taskOrder === undefined || value.taskOrder === null ? {} : { taskOrder: validTaskOrder(value.taskOrder) })
  };
  result.tasks = orderedTasks(result);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1000000) throw new Error('This note is too large to sync. Split it into smaller notes.');
  return result;
}
export function payload(note) { return validNote(note); }
// A three-way merge uses the last acknowledged revision to distinguish removal
// from an offline addition. This metadata stays on the device, outside ciphertext.
export async function mergeChecklists(local, remote, base) {
  if (local.type !== 'task' || remote.type !== 'task') throw new Error('Only checklists can be merged item by item.');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const choose = (a, b, before) => same(a, b) ? a : base && same(a, before) ? b : base && same(b, before) ? a :
    JSON.stringify(a) < JSON.stringify(b) ? a : b;
  const text = (a, b, before, separator) => {
    if (a === b || base && b === before) return a;
    if (base && a === before) return b;
    if (!a) return b;
    if (!b) return a;
    return [a, b].sort().join(separator);
  };
  const left = new Map(local.tasks.map(t => [t.id, t])), right = new Map(remote.tasks.map(t => [t.id, t]));
  const previous = new Map((base?.tasks || []).map(t => [t.id, t]));
  const merged = new Map();
  const variantId = async (id, text) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['mira-task-variant-1', id, text]))));
    digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
    const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  const add = async task => {
    const existing = merged.get(task.id);
    if (existing && existing.text !== task.text) {
      const [first, second] = [existing, task].sort((a,b) => a.text.localeCompare(b.text));
      merged.set(task.id, first);
      await add({...second, id:await variantId(task.id, second.text)});
    } else merged.set(task.id, existing ? { ...task, done: existing.done || task.done } : task);
  };
  for (const id of [...new Set([...previous.keys(), ...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(id), b = right.get(id), before = previous.get(id);
    if (!a || !b) {
      const survivor = a || b;
      // Removing an untouched item wins; an edit concurrent with removal survives.
      if (survivor && (!before || !same(survivor, before))) await add(survivor);
      continue;
    }
    const times = [a.createdAt, b.createdAt, before?.createdAt].filter(timestamp);
    const timing = times.length ? { createdAt: Math.min(...times) } : {};
    const done = a.done === b.done ? a.done : before ? (a.done === before.done ? b.done : a.done) : a.done || b.done;
    if (a.text === b.text || before && (a.text === before.text || b.text === before.text)) {
      await add({ id, text: a.text === before?.text ? b.text : a.text, done, ...timing });
    } else {
      // Keep both concurrent rewrites as items in this checklist, with stable IDs
      // so retries and a third device cannot multiply the alternatives.
      const alternatives = [a.text, b.text].sort();
      await add({ id, text: alternatives[0], done, ...timing });
      await add({ id: await variantId(id, alternatives[1]), text: alternatives[1], done, ...timing });
    }
  }
  const preferredOrder = [...(base?.tasks || []), ...remote.tasks, ...local.tasks].map(t => t.id);
  const order = new Map([...new Set(preferredOrder)].map((id, i) => [id, i]));
  const tasks = [...merged.values()].sort((a,b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || lexical(a.id,b.id));
  // Only explicit reorder/reset actions change this clock. Text edits cannot undo a move.
  const taskOrder = [local.taskOrder, remote.taskOrder].filter(Boolean).sort((a,b) => b.updatedAt - a.updatedAt || lexical(b.changeId,a.changeId))[0];
  let title = text(local.title, remote.title, base?.title, ' / ');
  let body = text(local.body, remote.body, base?.body, '\n\n');
  if (title.length > 500) {
    title = choose(local.title, remote.title, base?.title);
    body += `\n\nOther checklist title:\n${title === local.title ? remote.title : local.title}`;
  }
  if (body.length > 350000 || tasks.length > 2000) throw new Error('Both checklist edits are kept on their devices, but the combined list exceeds the note limit. Split the list before syncing.');
  return validNote({ ...remote, title, body, tasks, ...(taskOrder ? { taskOrder } : {}),
    createdAt: Math.min(local.createdAt, remote.createdAt), updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    ...Object.fromEntries(['color','pinned','folder','trashed'].map(key => [key, choose(local[key], remote[key], base?.[key])])) });
}
export class Notebook extends EventTarget {
  constructor(storage = localStorage) {
    super(); this.storage = storage; this.state = { schema: 1, notes: {}, deletions: {}, folders: [], config: null, lastSync: null, serverFeatures: null }; this.loadError = null; this.saveError = null;
    const saved = storage.getItem(STORAGE);
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.schema !== 1 || !s.notes || Array.isArray(s.notes)) throw new Error('Unrecognized notebook format');
        for (const [id, n] of Object.entries(s.notes)) {
          const p = validNote(n); if (p.id !== id) throw new Error('Invalid note identity');
          const syncBase = n.syncBase && n.syncBase.id === id ? validNote(n.syncBase) : undefined;
          this.state.notes[id] = { ...p, revision: Number.isSafeInteger(n.revision) ? n.revision : 0, dirty: !!n.dirty, changeId: n.changeId || crypto.randomUUID(), ...(syncBase ? { syncBase } : {}) };
        }
        this.state.config = s.config ? parseConfig(s.config) : null;
        if (s.deletions) for (const [id, d] of Object.entries(s.deletions)) {
          if (!uuidPattern.test(id) || !Number.isSafeInteger(d.revision) || d.revision < 0) throw new Error('Invalid deletion record');
          this.state.deletions[id] = { id, revision: d.revision, dirty: !!d.dirty, changeId: d.changeId || crypto.randomUUID(), updatedAt: Number(d.updatedAt) || Date.now() };
          delete this.state.notes[id];
        }
        this.state.serverFeatures = s.serverFeatures || null;
        this.state.folders = Array.isArray(s.folders) ? s.folders.filter(f => typeof f === 'string' && f.length <= 60) : [];
        this.state.lastSync = s.lastSync;
      } catch (e) { this.loadError = new Error('Your saved notebook could not be read. Export the recovery file before making changes. ' + e.message); }
    }
  }
  save(kind = 'change', detail = {}) {
    if (this.loadError) throw this.loadError;
    try { this.storage.setItem(STORAGE, JSON.stringify(this.state)); this.saveError = null; }
    catch (error) { this.saveError = error; throw error; }
    this.dispatchEvent(new CustomEvent(kind, { detail }));
  }
  create(type = 'note', fields = {}) {
    const now = Date.now();
    const n = { id: crypto.randomUUID(), title: '', body: '', type, color: 'paper', pinned: false, folder: '', trashed: false, createdAt: now, updatedAt: now, tasks: [], ...fields, revision: 0, dirty: true, changeId: crypto.randomUUID() };
    this.state.notes[n.id] = { ...n, ...validNote(n) }; this.save(); return this.state.notes[n.id];
  }
  update(id, fields) {
    const before = this.state.notes[id]; if (!before) return;
    if (Array.isArray(fields.tasks)) {
      const previous = new Map(before.tasks.map(task => [task.id, task]));
      fields = { ...fields, tasks: fields.tasks.map(task => {
        const old = previous.get(task.id);
        return old ? { ...task, ...(old.createdAt === undefined ? {} : { createdAt: old.createdAt }) } : { ...task, createdAt: task.createdAt ?? Date.now() };
      }) };
    }
    const n = { ...before, ...fields, id, updatedAt: Date.now(), dirty: true, changeId: crypto.randomUUID() };
    this.state.notes[id] = { ...n, ...validNote(n) }; this.save(); return this.state.notes[id];
  }
  addFolder(name) { if (!this.state.folders.includes(name)) this.state.folders.push(name); this.save(); }
  moveTask(noteId, taskId, direction) {
    const note = this.state.notes[noteId]; if (!note || note.trashed || note.type !== 'task' || ![-1,1].includes(direction)) return false;
    const tasks = orderedTasks(note), task = tasks.find(item => item.id === taskId); if (!task) return false;
    const group = tasks.filter(item => item.done === task.done), index = group.findIndex(item => item.id === taskId), neighbor = group[index + direction];
    if (!neighbor) return false;
    const from = tasks.findIndex(item => item.id === taskId), to = tasks.findIndex(item => item.id === neighbor.id);
    [tasks[from], tasks[to]] = [tasks[to], tasks[from]];
    this.setTaskOrder(noteId, tasks.map(item => item.id));
    return true;
  }
  resetTaskOrder(noteId) {
    const note = this.state.notes[noteId]; if (!note || note.trashed || note.type !== 'task') return;
    this.setTaskOrder(noteId, []);
  }
  placeTask(noteId, taskId, targetId, after = false) {
    const note = this.state.notes[noteId];
    if (!note || note.trashed || note.type !== 'task' || taskId === targetId) return false;
    const tasks = orderedTasks(note), task = tasks.find(t => t.id === taskId), target = tasks.find(t => t.id === targetId);
    if (!task || !target || task.done !== target.done) return false;
    const group = tasks.filter(t => t.done === task.done).map(t => t.id), moved = group.filter(id => id !== taskId);
    moved.splice(moved.indexOf(targetId) + (after ? 1 : 0), 0, taskId);
    if (group.every((id, index) => id === moved[index])) return false;
    // Replace only this group's slots; preserve the other section and current remote edits.
    let index = 0;
    this.setTaskOrder(noteId, tasks.map(t => t.done === task.done ? moved[index++] : t.id));
    return true;
  }
  setTaskOrder(noteId, ids) {
    const note = this.state.notes[noteId];
    const legacyIds = [...new Set([...(note.taskOrder?.legacyIds || []), ...note.tasks.filter(task => task.createdAt === undefined).map(task => task.id)])];
    this.transaction(() => {
      const next = { ...note, taskOrder: { ids, legacyIds, updatedAt: Math.max(Date.now(), (note.taskOrder?.updatedAt || 0) + 1), changeId: crypto.randomUUID() }, updatedAt: Date.now(), dirty: true, changeId: crypto.randomUUID() };
      this.state.notes[noteId] = { ...next, ...validNote(next) };
    });
  }
  batchTrash(ids, trashed) {
    this.transaction(() => { for (const id of ids) {
      const n = this.state.notes[id]; if (!n) continue;
      this.state.notes[id] = { ...n, trashed, dirty: true, updatedAt: Date.now(), changeId: crypto.randomUUID() };
    } });
  }
  permanentlyDelete(ids) {
    if (this.state.config && !(this.state.serverFeatures?.server === this.state.config.server && this.state.serverFeatures?.permanentDelete))
      throw new Error('Connect once to a NoteMark 1.1 hosting device before deleting permanently. Update the hosting app or server if needed.');
    this.transaction(() => { for (const id of ids) {
      const n = this.state.notes[id]; if (!n?.trashed) continue;
      this.state.deletions[id] = { id, revision: n.revision, dirty: !!this.state.config, updatedAt: Date.now(), changeId: crypto.randomUUID() };
      delete this.state.notes[id];
    } });
  }
  transaction(fn) {
    const before = structuredClone(this.state);
    try { fn(); this.save(); } catch (error) { this.state = before; throw error; }
  }
  attach(config) {
    const old = this.state.config;
    this.state.config = parseConfig(config);
    if (!old || old.id !== config.id || old.token !== config.token || old.key !== config.key) {
      this.state.deletions = {}; this.state.serverFeatures = null;
      for (const n of Object.values(this.state.notes)) { n.revision = 0; n.dirty = true; n.changeId = crypto.randomUUID(); delete n.syncBase; }
    }
    this.state.lastSync = null; this.save();
  }
  export() { return JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), notes: Object.values(this.state.notes).map(payload) }, null, 2); }
  import(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text; if (data.schema !== 1 || !Array.isArray(data.notes) || data.notes.length > 5000) throw new Error('Choose a NoteMark backup with at most 5,000 notes.');
    const notes = data.notes.map(validNote);
    if (Object.keys(this.state.notes).length + notes.length > 5000) throw new Error('This import would exceed 5,000 notes.');
    this.transaction(() => {
      for (const n of notes) { const id = crypto.randomUUID(); this.state.notes[id] = { ...n, id, revision: 0, dirty: true, changeId: crypto.randomUUID() }; }
      if (Array.isArray(data.folders)) this.state.folders = [...new Set([...this.state.folders, ...data.folders.filter(f => typeof f === 'string' && f.length <= 60)])];
    });
    return notes.length;
  }
}
export function parseConfig(c) {
  if (!c || !uuidPattern.test(c.id) || !/^[\w-]{43}$/.test(c.key) || !/^[\w-]{43}$/.test(c.token)) throw new Error('This connection code is invalid. Copy the whole code from your other device.');
  if (decode(c.key).length !== 32 || decode(c.token).length !== 32) throw new Error('Invalid connection keys.');
  const result = { server: normalizeServer(c.server), id: c.id, token: c.token, key: c.key };
  if (c.fingerprint !== undefined) {
    if (typeof c.fingerprint !== 'string' || !/^[a-f\d]{64}$/i.test(c.fingerprint)) throw new Error('Invalid phone certificate fingerprint. Copy a new connection code.');
    const address = new URL(result.server), host = address.hostname, n = host.split('.').map(Number);
    const local = host === 'localhost' || host === '[::1]' || /^\d+\.\d+\.\d+\.\d+$/.test(host) && n.every(x=>x>=0&&x<=255) && (n[0]===127 || n[0]===10 || n[0]===192&&n[1]===168 || n[0]===172&&n[1]>=16&&n[1]<=31);
    if (address.protocol !== 'https:' || !local) throw new Error('Phone certificate pairing requires a local HTTPS address.');
    result.fingerprint = c.fingerprint.toUpperCase();
  }
  return result;
}
export function pairingCode(config) { return 'mira1.' + encode(new TextEncoder().encode(JSON.stringify(parseConfig(config)))); }
export function parsePairing(text) {
  if (!text.trim().startsWith('mira1.')) throw new Error('A connection code starts with mira1.');
  return parseConfig(JSON.parse(new TextDecoder().decode(decode(text.trim().slice(6)))));
}
async function request(config, path, method = 'GET', body) {
  let response;
  try {
    if (config.fingerprint && !androidNative && !desktopNative) throw new Error('Pinned phone sync requires the installed NoteMark app.');
    response = await (androidNative || desktopNative ? nativeFetch : fetch)(config.server + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(config.token ? { Authorization: 'Bearer ' + config.token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), notebook: config.id, fingerprint: config.fingerprint, signal: AbortSignal.timeout(10000), cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
  } catch (error) {
    if (config.fingerprint && /certificate|fingerprint|installed NoteMark/i.test(error.message)) throw error;
    const host = new URL(config.server).host;
    const local = config.server.startsWith('http:') || !!config.fingerprint;
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Connection timed out' : 'Connection was blocked or refused';
    const failure = new Error(local ? `${reason}: cannot reach the device at ${host}. Keep NoteMark open on the hosting device and use the same Wi-Fi. If Windows is hosting, use Repair Wi-Fi access on the PC. If that route is blocked, choose Host from this phone on Android, then connect Windows using the phone’s new code.` : `${reason}: cannot reach ${host}. Check that your HTTPS sync server is online and both devices have internet access.`);
    failure.code = 'unreachable'; throw failure;
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('This address responded, but it is not a NoteMark sync server. Check the address and port.'); }
  if (!response.ok && response.status !== 409) throw new Error(response.status === 401 ? 'Connection key was rejected. Reconnect using your other device’s code.' : response.status === 404 ? 'This notebook is missing on the server. Check the connection code.' : data.error || `Server error ${response.status}`);
  return { status: response.status, data };
}
export async function createVault(server, fingerprint) {
  const c = parseConfig({ server: normalizeServer(server), id: crypto.randomUUID(), token: encode(crypto.getRandomValues(new Uint8Array(32))), key: encode(crypto.getRandomValues(new Uint8Array(32))), ...(fingerprint === undefined ? {} : { fingerprint }) });
  await probeServer(c.server, c);
  await request(c, '/api/vaults', 'POST', { id: c.id, token: c.token }); return c;
}
export async function probeServer(server, config = {}) {
  const { data } = await request({ ...config, server: normalizeServer(server) }, '/api/health');
  if (data.ok !== true || data.protocol !== 1) throw new Error('The server responded with an incompatible sync protocol. Update NoteMark on Windows and Android.');
  return data;
}
export async function checkVault(c) { c = parseConfig(c); await probeServer(c.server, c); await request(c, `/api/vaults/${c.id}/notes`); }
export async function encryptNote(config, note) {
  const key = await crypto.subtle.importKey('raw', decode(config.key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(config.id + ':' + note.id) }, key, new TextEncoder().encode(JSON.stringify(payload(note))));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)), deleted: false };
}
export async function decryptNote(config, record) {
  const key = await crypto.subtle.importKey('raw', decode(config.key), 'AES-GCM', false, ['decrypt']);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: new TextEncoder().encode(config.id + ':' + record.id) }, key, decode(record.ciphertext));
  const note = validNote(JSON.parse(new TextDecoder().decode(data)));
  if (note.id !== record.id) throw new Error('Encrypted note identity does not match.');
  return { ...note, revision: record.revision, dirty: false, changeId: crypto.randomUUID(), syncBase: payload(note) };
}
export class SyncEngine extends EventTarget {
  constructor(book) { super(); this.book = book; this.busy = false; this.paused = false; this.idle = Promise.resolve(); this.status = 'local'; }
  emit(status, message = '') { this.status = status; this.dispatchEvent(new CustomEvent('status', { detail: { status, message } })); }
  pause() { this.paused = true; return this.idle; }
  resume() { this.paused = false; }
  async run() {
    if (this.paused || this.busy || !this.book.state.config || this.book.loadError) return;
    let finishIdle;
    this.idle = new Promise(resolve => { finishIdle = resolve; });
    this.busy = true; this.emit('syncing');
    const c = this.book.state.config;
    try {
      const health = await probeServer(c.server, c);
      if (this.book.state.config !== c) return;
      this.book.state.serverFeatures = { server: c.server, permanentDelete: health.capabilities?.permanentDelete === true };
      // Deletions win over offline edits. Keep their IDs indefinitely to prevent resurrection.
      for (const deletion of Object.values(this.book.state.deletions).filter(d => d.dirty)) {
        if (!health.capabilities?.permanentDelete) throw new Error('Update the hosting app or server to NoteMark 1.1 to finish permanent deletion.');
        const blank = { id: deletion.id, title: '', body: '', tasks: [], trashed: true, createdAt: 0, updatedAt: deletion.updatedAt };
        const encrypted = { ...await encryptNote(c, blank), deleted: true };
        let revision = deletion.revision;
        for (let attempt = 0; attempt < 8; attempt++) {
          const { status, data } = await request(c, `/api/vaults/${c.id}/notes/${deletion.id}`, 'PUT', { baseRevision: revision, ...encrypted });
          if (this.book.state.config !== c) return;
          if (status !== 409 || data.current?.deleted) {
            if (status === 409) await decryptNote(c, data.current);
            Object.assign(deletion, { revision: status === 409 ? data.current.revision : data.revision, dirty: false }); break;
          }
          revision = data.current?.revision || 0; deletion.revision = revision;
        }
        this.book.save('remote');
      }
      for (const note of Object.values(this.book.state.notes).filter(n => n.dirty)) {
        for (let attempt = 0; attempt < 4; attempt++) {
        if (this.paused || this.book.state.config !== c) return;
        if (!this.book.state.notes[note.id] || this.book.state.deletions[note.id]) break;
        const snapshot = structuredClone(this.book.state.notes[note.id]);
        if (!snapshot.dirty) break;
        const encrypted = await encryptNote(c, snapshot);
        if (this.paused || this.book.state.config !== c) return;
        const { status, data } = await request(c, `/api/vaults/${c.id}/notes/${note.id}`, 'PUT', { baseRevision: snapshot.revision, ...encrypted });
        if (this.book.state.config !== c) return;
        const local = this.book.state.notes[note.id];
        // The user can permanently delete while an earlier upload is in flight.
        if (!local || this.book.state.deletions[note.id]) {
          const d = this.book.state.deletions[note.id]; if (d) { d.revision = status === 409 ? data.current?.revision || 0 : data.revision; d.dirty = true; }
          this.book.save('remote'); break;
        }
        let retryMerge = false;
        if (status === 409) {
          if (data.current?.deleted) { await decryptNote(c, data.current); this.adoptDeletion(data.current); this.book.save('remote'); continue; }
          const remote = await decryptNote(c, data.current);
          if (this.book.state.config !== c) return;
          if (this.book.state.deletions[note.id] || !this.book.state.notes[note.id]) break;
          if (this.book.state.notes[note.id] !== local) continue;
          if (JSON.stringify(payload(remote)) === JSON.stringify(payload(snapshot))) {
            local.revision = remote.revision; local.syncBase = payload(remote); local.dirty = local.changeId !== snapshot.changeId;
          } else if (local.type === 'task' && remote.type === 'task') {
            const changeId = local.changeId;
            const combined = await mergeChecklists(local, remote, local.syncBase);
            if (this.book.state.config !== c) return;
            if (this.book.state.deletions[note.id] || !this.book.state.notes[note.id]) break;
            if (this.book.state.notes[note.id].changeId !== changeId) continue;
            this.book.state.notes[note.id] = { ...combined, revision: remote.revision, syncBase: payload(remote), dirty: true, changeId: crypto.randomUUID() };
            retryMerge = true;
          } else {
            const copy = this.book.create(local.type, { ...payload(local), id: crypto.randomUUID(), title: (local.title || 'Untitled').slice(0, 480) + ' (conflict copy)' });
            this.book.state.notes[note.id] = remote;
            this.book.dispatchEvent(new CustomEvent('conflict', { detail: { original: note.id, copy: copy.id } }));
          }
        } else { local.revision = data.revision; local.syncBase = payload(snapshot); local.dirty = local.changeId !== snapshot.changeId; }
        this.book.save('remote');
        if (!retryMerge) break;
        }
      }
      if (this.paused || this.book.state.config !== c) return;
      const { data } = await request(c, `/api/vaults/${c.id}/notes`);
      if (this.book.state.config !== c) return;
      for (const record of data.notes) {
        if (record.deleted) { await decryptNote(c, record); this.adoptDeletion(record); continue; }
        if (this.book.state.deletions[record.id]) {
          const d = this.book.state.deletions[record.id]; d.revision = Math.max(d.revision, record.revision); d.dirty = true; continue;
        }
        const local = this.book.state.notes[record.id];
        if (!local || (!local.dirty && (record.revision > local.revision || !local.syncBase))) {
          const remote = await decryptNote(c, record);
          if (this.book.state.config !== c) return;
          const deletion = this.book.state.deletions[record.id];
          if (deletion) { deletion.revision = Math.max(deletion.revision, record.revision); deletion.dirty = true; continue; }
          const latest = this.book.state.notes[record.id];
          if (!latest || !latest.dirty && record.revision >= latest.revision) this.book.state.notes[record.id] = remote;
        }
      }
      this.book.state.lastSync = Date.now(); this.book.save('remote');
      const pending = Object.values(this.book.state.notes).some(n => n.dirty) || Object.values(this.book.state.deletions).some(d => d.dirty);
      this.emit(pending ? 'pending' : 'synced');
    } catch (error) { this.emit('offline', error.message || 'Could not reach the sync server. Your notes are saved on this device.'); }
    finally { this.busy = false; if (this.paused && this.status === 'syncing') this.emit('pending'); finishIdle(); }
  }
  adoptDeletion(record) {
    delete this.book.state.notes[record.id];
    this.book.state.deletions[record.id] = { id: record.id, revision: record.revision, dirty: false, updatedAt: Date.parse(record.updatedAt) || Date.now(), changeId: crypto.randomUUID() };
  }
}

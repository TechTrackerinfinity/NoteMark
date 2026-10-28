import { Zip, ZipDeflate, Unzip, UnzipInflate, strToU8, strFromU8 } from './vendor/fflate.mjs';
import { payload, validNote } from './core.mjs';
export const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024, MAX_ENTRIES = 5002;
export const backupFilename = () => 'NoteMark-backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.zip';
function filename(note) {
  let title = note.title.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 70) || 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = '_' + title;
  return `${note.trashed ? 'trash' : 'notes'}/${title}-${note.id}.md`;
}
function markdown(n) {
  const active = n.tasks.filter(t => !t.done), done = n.tasks.filter(t => t.done);
  const tasks = a => a.map(t => `- [${t.done ? 'x' : ' '}] ${t.text.replace(/\r?\n/g, '\n  ')}`).join('\n');
  return `# ${n.title || 'Untitled'}\n\n${n.body ? n.body + '\n\n' : ''}${n.tasks.length ? tasks(active) + (done.length ? '\n\n## Completed\n\n' + tasks(done) : '') + '\n\n' : ''}`;
}
export async function createBackup(book) {
  if (book.loadError) throw book.loadError;
  const notes = Object.values(book.state.notes).map(payload);
  if (notes.length > 5000) throw new Error('A backup can contain at most 5,000 notes.');
  const manifest = { format: 'notemark-backup', version: 1, schema: 1, exportedAt: new Date().toISOString(), folders: [...book.state.folders], notes };
  const chunks = []; let size = 0, expanded = 0, failure;
  const zip = new Zip((error, chunk) => { if (error) failure = error; else { size += chunk.length; if (size > MAX_ARCHIVE) failure = new Error('Backup exceeds 64 MB.'); else chunks.push(chunk); } });
  const add = (name, text) => {
    const bytes = strToU8(text); expanded += bytes.length;
    if (expanded > MAX_EXPANDED) throw new Error('Backup content exceeds 128 MB.');
    const file = new ZipDeflate(name, { level: 6 }); zip.add(file); file.push(bytes, true);
    if (failure) throw failure;
  };
  add('backup.json', JSON.stringify(manifest, null, 2));
  for (let i = 0; i < notes.length; i++) {
    add(filename(notes[i]), markdown(notes[i]));
    if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  zip.end(); if (failure) throw failure;
  const result = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}
function safePath(name) {
  return typeof name === 'string' && name.length < 240 && !/[\\\x00-\x1f:]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function zipDirectory(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), fail = () => { throw new Error('The ZIP backup is incomplete or damaged.'); };
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end + 22 + v.getUint16(end + 20, true) !== bytes.length) fail();
  const count = v.getUint16(end + 10, true), offset = v.getUint32(end + 16, true), size = v.getUint32(end + 12, true);
  if (!count || count > MAX_ENTRIES || v.getUint16(end + 4, true) || v.getUint16(end + 6, true) || v.getUint16(end + 8, true) !== count || offset + size !== end) fail();
  const entries = new Map(); let p = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || v.getUint32(p, true) !== 0x02014b50) fail();
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), compressed = v.getUint32(p + 20, true), length = v.getUint32(p + 24, true);
    const nameSize = v.getUint16(p + 28, true), next = p + 46 + nameSize + v.getUint16(p + 30, true) + v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    if (next > end || flags & 1 || ![0,8].includes(method) || local + 30 > offset || v.getUint32(local, true) !== 0x04034b50) fail();
    const name = strFromU8(bytes.subarray(p + 46, p + 46 + nameSize));
    const localNameLength = v.getUint16(local + 26, true), dataStart = local + 30 + localNameLength + v.getUint16(local + 28, true);
    if (!safePath(name) || entries.has(name) || dataStart + compressed > offset || v.getUint16(local + 8, true) !== method ||
        strFromU8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail();
    expanded += length; if (expanded > MAX_EXPANDED) throw new Error('Expanded ZIP exceeds 128 MB.');
    entries.set(name, { crc, length }); p = next;
  }
  if (p !== end) fail(); return entries;
}
export async function readBackup(bytes, name = '') {
  if (bytes.length > MAX_ARCHIVE) throw new Error('Choose a backup smaller than 64 MB.');
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b) && !name.toLowerCase().endsWith('.zip')) {
    const data = JSON.parse(strFromU8(bytes)); validateManifest(data, false); return data;
  }
  if (bytes.length < 22) throw new Error('The ZIP backup is incomplete.');
  const directory = zipDirectory(bytes);
  let count = 0, total = 0, manifest, error; const seen = new Set(), finished = new Set(), manifestChunks = [];
  const unzip = new Unzip(file => {
    if (++count > MAX_ENTRIES || !directory.has(file.name) || !safePath(file.name) || seen.has(file.name)) throw new Error('This ZIP contains invalid or duplicate paths.');
    seen.add(file.name);
    if (file.originalSize > MAX_EXPANDED) throw new Error('ZIP content exceeds the backup limit.');
    if (file.name !== 'backup.json' && !/^(notes|trash)\/[^/]+\.md$/.test(file.name)) throw new Error('Choose a NoteMark ZIP backup.');
    let crc = 0xffffffff, fileSize = 0;
    file.ondata = (failure, chunk, final) => {
      if (failure) { error = failure; return; }
      total += chunk.length; if (total > MAX_EXPANDED) throw new Error('Expanded ZIP exceeds 128 MB.');
      fileSize += chunk.length;
      for (const b of chunk) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
      if (final) { const entry = directory.get(file.name); if (entry.length !== fileSize || entry.crc !== ((crc ^ 0xffffffff) >>> 0)) throw new Error('A file in this backup is damaged.'); finished.add(file.name); }
      if (file.name === 'backup.json') {
        manifestChunks.push(chunk);
        if (final) {
          const length = manifestChunks.reduce((n, c) => n + c.length, 0), joined = new Uint8Array(length); let offset = 0;
          for (const c of manifestChunks) { joined.set(c, offset); offset += c.length; }
          manifest = JSON.parse(strFromU8(joined));
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 128 * 1024) {
    unzip.push(bytes.subarray(i, i + 128 * 1024), i + 128 * 1024 >= bytes.length);
    if (error) throw error;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  validateManifest(manifest, true);
  if (finished.size !== directory.size) throw new Error('The ZIP backup is incomplete.');
  for (const note of manifest.notes) if (!seen.has(filename(note))) throw new Error('A note file is missing from this ZIP backup.');
  return manifest;
}
function validateManifest(data, zip) {
  if (!data || data.schema !== 1 || !Array.isArray(data.notes) || data.notes.length > 5000 ||
      zip && (data.format !== 'notemark-backup' || data.version !== 1)) throw new Error('This is not a supported NoteMark backup.');
  const ids = new Set();
  for (const n of data.notes) { validNote(n); if (ids.has(n.id)) throw new Error('The backup contains duplicate note identities.'); ids.add(n.id); }
  if (data.folders && (!Array.isArray(data.folders) || data.folders.some(f => typeof f !== 'string' || f.length > 60))) throw new Error('Invalid backup folders.');
}

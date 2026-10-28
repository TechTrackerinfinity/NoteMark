import test from 'node:test';
import assert from 'node:assert/strict';
import { Notebook, payload } from '../web/core.mjs';
import { createBackup, readBackup, MAX_ARCHIVE } from '../web/backup.mjs';
import { unzipSync, zipSync, strToU8, strFromU8 } from '../web/vendor/fflate.mjs';
class Storage { data = new Map(); fail = false; getItem(k) { return this.data.get(k) ?? null; } setItem(k,v) { if(this.fail) throw new Error('Disk full'); this.data.set(k,v); } }
const fresh = () => new Notebook(new Storage());
test('ZIP contains readable individual notes, trash, metadata and no credentials or deleted content', async () => {
  const b = fresh(); b.addFolder('Empty folder');
  b.create('note', { title: '同じ / title: *?', body: 'Unicode हिन्दी 🧠', folder: 'Ideas', pinned: true, color:'sky', createdAt: 1234, updatedAt:5678 });
  b.create('task', { title: '同じ / title: *?', trashed:true, tasks:[{id:'a',text:'Open item',done:false},{id:'b',text:'Finished item',done:true}] });
  const doomed=b.create('note',{title:'Do not export',body:'ERASED_SENTINEL',trashed:true}); b.permanentlyDelete([doomed.id]);
  b.state.config = { token:'TOKEN_SENTINEL', key:'KEY_SENTINEL' };
  const bytes=await createBackup(b), files=unzipSync(bytes), names=Object.keys(files);
  assert.equal(names.length,3); assert.ok(names.some(n=>n.startsWith('notes/'))); assert.ok(names.some(n=>n.startsWith('trash/')));
  assert.ok(names.every(n=>!/[<>:"\\|?*]/.test(n)));
  const md=strFromU8(files[names.find(n=>n.startsWith('trash/'))]); assert.match(md,/- \[ \] Open item/); assert.match(md,/## Completed\n\n- \[x\] Finished item/);
  const text=Object.values(files).map(strFromU8).join(''); for(const s of ['TOKEN_SENTINEL','KEY_SENTINEL','ERASED_SENTINEL']) assert.ok(!text.includes(s));
  const restored=await readBackup(bytes,'backup.zip'); assert.deepEqual(restored.notes,Object.values(b.state.notes).map(payload)); assert.deepEqual(restored.folders,['Empty folder']);
  const c=fresh(), existing=c.create('note',{title:'Keep me'}); const keys={server:'unchanged'}; c.state.config=keys;
  assert.equal(c.import(restored),2); assert.equal(c.state.config.server,'unchanged'); assert.ok(c.state.notes[existing.id]);
  for (const n of restored.notes) assert.equal(c.state.notes[n.id],undefined);
  const copies=Object.values(c.state.notes).filter(n=>n.id!==existing.id);
  assert.deepEqual(copies.map(n=>({...payload(n),id:'copy'})),restored.notes.map(n=>({...n,id:'copy'})));
});
test('duplicate and reserved Windows titles use unique safe filenames',async()=>{
  const b=fresh(); for(const title of ['CON','CON','..','NUL.txt','a\\b/c']) b.create('note',{title});
  const files=unzipSync(await createBackup(b)); assert.equal(Object.keys(files).length,6);
  assert.equal(Object.keys(files).filter(n=>n.startsWith('notes/_CON-')).length,2);
});
test('legacy JSON restores as new copies and invalid mixed notes import atomically',async()=>{
  const b=fresh(); b.create('note',{title:'Legacy'}); const legacy=await readBackup(strToU8(b.export()),'Mira-Notes-backup.json');
  assert.equal(b.import(legacy),1); const before=JSON.stringify(b.state);
  assert.throws(()=>b.import({schema:1,notes:[legacy.notes[0],{id:'bad'}]})); assert.equal(JSON.stringify(b.state),before);
});
test('storage failure rolls back imports, trash and permanent deletion',()=>{
  const b=fresh(), n=b.create('note',{title:'Remain'}), data=JSON.parse(b.export()); let before=JSON.stringify(b.state);
  b.storage.fail=true; assert.throws(()=>b.import(data),/Disk full/); assert.equal(JSON.stringify(b.state),before);
  assert.throws(()=>b.batchTrash([n.id],true),/Disk full/); assert.equal(JSON.stringify(b.state),before);
  b.storage.fail=false; b.batchTrash([n.id],true); before=JSON.stringify(b.state); b.storage.fail=true;
  assert.throws(()=>b.permanentlyDelete([n.id]),/Disk full/); assert.equal(JSON.stringify(b.state),before);
});
test('ZIP restore rejects traversal, duplicate paths, missing notes and malformed manifests',async()=>{
  const b=fresh(); b.create('note',{title:'Safe'}); const files=unzipSync(await createBackup(b));
  for(const name of ['../escape.md','/absolute.md','notes/../escape.md','notes\\evil.md','C:/bad.md']) await assert.rejects(readBackup(zipSync({...files,[name]:strToU8('bad')}),'bad.zip'));
  const missing={...files}; delete missing[Object.keys(files).find(k=>k.startsWith('notes/'))]; await assert.rejects(readBackup(zipSync(missing),'missing.zip'),/missing/);
  await assert.rejects(readBackup(zipSync({...files,'backup.json':strToU8('{}')}),'bad.zip'),/supported/);
  await assert.rejects(readBackup(zipSync({...files,'backup.json':strToU8('{broken')}),'bad.zip'));
  // Rename a same-length extra entry to an existing name in both headers.
  const duplicate=zipSync({'backup.json':files['backup.json'],'xxxxxx.json':files['backup.json']},{level:0});
  const buf=Buffer.from(duplicate); for(let p=0;(p=buf.indexOf('xxxxxx.json',p))>=0;p+=11) buf.write('backup.json',p);
  await assert.rejects(readBackup(buf,'duplicate.zip'));
});
test('ZIP restore rejects truncated archives, bad CRC and oversized input/expanded content',async()=>{
  const b=fresh(); b.create('note',{title:'CRC test',body:'Unique ASCII content'}); const bytes=await createBackup(b);
  await assert.rejects(readBackup(bytes.slice(0,-22),'truncated.zip'));
  const raw=zipSync({'backup.json':strToU8(JSON.stringify({format:'notemark-backup',version:1,schema:1,notes:[]}))},{level:0});
  const damaged=raw.slice(); damaged[damaged.indexOf(0x7b)+1]^=1; await assert.rejects(readBackup(damaged,'damaged.zip'));
  await assert.rejects(readBackup(new Uint8Array(MAX_ARCHIVE+1),'large.zip'),/64 MB/);
  const inflated=raw.slice(); const v=new DataView(inflated.buffer); for(let p=0;p<inflated.length-46;p++) if(v.getUint32(p,true)===0x02014b50) v.setUint32(p+24,129*1024*1024,true);
  await assert.rejects(readBackup(inflated,'expanded.zip'),/128 MB/);
});

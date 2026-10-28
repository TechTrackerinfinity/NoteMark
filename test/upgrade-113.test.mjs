import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';
import {Notebook,SyncEngine,createVault,parseConfig,pairingCode,parsePairing,mergeChecklists,payload} from '../web/core.mjs';
class Storage { data=new Map(); getItem(k){return this.data.get(k)??null;} setItem(k,v){this.data.set(k,v);} }

test('working 1.1.3 storage keeps certificate pairing, revisions and merge base through upgrade and address changes',()=>{
  const storage=new Storage(), book=new Notebook(storage);
  const config={id:crypto.randomUUID(),server:'https://192.168.31.22:47821',token:'A'.repeat(43),key:'B'.repeat(43),fingerprint:'ab'.repeat(32)};
  book.attach(config); const n=book.create('task',{title:'Existing phone note',tasks:[{id:crypto.randomUUID(),text:'Keep completion',done:true}]});
  Object.assign(n,{revision:8,dirty:false,syncBase:payload(n)});book.save();
  const next=new Notebook(storage);assert.equal(next.loadError,null);
  assert.equal(next.state.config.fingerprint,'AB'.repeat(32));assert.deepEqual(next.state.notes[n.id].syncBase,payload(n));
  assert.deepEqual(parsePairing(pairingCode(config)),parseConfig(config));
  next.attach({...config,server:'https://192.168.31.23:47821'});
  assert.equal(next.state.notes[n.id].revision,8);assert.equal(next.state.notes[n.id].dirty,false);
  assert.deepEqual(next.state.notes[n.id].syncBase,payload(n));
});

test('phone certificate pairing rejects malformed pins and nonlocal or cleartext destinations',()=>{
  const config={id:crypto.randomUUID(),server:'https://192.168.31.22:47821',token:'A'.repeat(43),key:'B'.repeat(43),fingerprint:'ab'.repeat(32)};
  for(const fingerprint of ['',true,'ab'.repeat(31),'xx'.repeat(32)])assert.throws(()=>parseConfig({...config,fingerprint}),/fingerprint/i);
  for(const server of ['http://192.168.31.22:47821','https://example.com'])assert.throws(()=>parseConfig({...config,server}),/local HTTPS/);
});

test('checklist three-way merge keeps additions, removals, completion and concurrent rewrites',async()=>{
  const n=new Notebook(new Storage()).create('task',{title:'Shared list',tasks:[{id:'one',text:'Tea',done:false},{id:'two',text:'Remove me',done:false}]});
  const base=payload(n), local=structuredClone(base),remote=structuredClone(base);
  local.tasks[0].done=true;local.tasks=local.tasks.filter(t=>t.id!=='two');local.tasks.push({id:'three',text:'Added offline',done:false});
  remote.tasks[0].text='Green tea';
  const merged=await mergeChecklists(local,remote,base);
  assert.deepEqual(merged.tasks,[{id:'one',text:'Green tea',done:true},{id:'three',text:'Added offline',done:false}]);
  local.tasks[0].text='Black tea';
  const both=await mergeChecklists(local,remote,base);assert.deepEqual(new Set(both.tasks.map(t=>t.text)),new Set(['Black tea','Green tea','Added offline']));
});

test('concurrent checklist edits converge as one note and permanent deletion still wins',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'notemark-upgrade-113-'));
  const server=await startServer({port:0,dataDir:directory,authRateLimit:10000});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const config=await createVault('http://127.0.0.1:'+server.port);
  const a=new Notebook(new Storage()),b=new Notebook(new Storage());a.attach(config);b.attach(config);
  const ae=new SyncEngine(a),be=new SyncEngine(b);
  const n=a.create('task',{title:'Shared',tasks:[{id:'one',text:'Tea',done:false}]});
  await ae.run();await be.run();
  a.update(n.id,{tasks:[{id:'one',text:'Tea',done:true}]});
  b.update(n.id,{tasks:[{id:'one',text:'Green tea',done:false},{id:'two',text:'Milk',done:false}]});
  await ae.run();await be.run();await ae.run();
  assert.equal(Object.keys(a.state.notes).length,1);assert.equal(Object.keys(b.state.notes).length,1);
  assert.deepEqual(a.state.notes[n.id].tasks,b.state.notes[n.id].tasks);
  assert.equal(a.state.notes[n.id].tasks[0].done,true);assert.equal(a.state.notes[n.id].tasks[0].text,'Green tea');
  a.batchTrash([n.id],true);a.permanentlyDelete([n.id]);b.update(n.id,{title:'Stale edit'});
  await ae.run();await be.run();assert.equal(b.state.notes[n.id],undefined);assert.equal(Object.keys(b.state.notes).length,0);
});

test('native desktop request preserves the explicit phone certificate fingerprint',async()=>{
  const old=globalThis.miraDesktop;let received;
  globalThis.miraDesktop={request:async args=>{received=args;return {status:200,data:{ok:true}};}};
  try{
    const {nativeFetch,desktopNative}=await import('../web/native.mjs?upgrade113');assert.equal(desktopNative,true);
    const result=await nativeFetch('https://192.168.31.22:47821/api/health',{method:'GET',headers:{},fingerprint:'AB'.repeat(32)});
    assert.equal(result.ok,true);assert.equal(received.fingerprint,'AB'.repeat(32));assert.deepEqual(await result.json(),{ok:true});
  }finally{if(old===undefined)delete globalThis.miraDesktop;else globalThis.miraDesktop=old;}
});

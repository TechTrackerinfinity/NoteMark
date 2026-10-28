import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Notebook,SyncEngine,createVault,validNote,mergeChecklists,compareNotes,payload} from '../web/core.mjs';
import {createBackup,readBackup} from '../web/backup.mjs';
import {startServer} from '../server/index.mjs';
class Storage { value=null; fail=false; getItem(){return this.value;}setItem(key,value){if(this.fail)throw Error('Storage full');this.value=value;} }
const fresh=()=>new Notebook(new Storage());
const item=(id,time,done=false)=>({id,text:id,done,createdAt:time});
const ids=note=>note.tasks.map(task=>task.id);
function at(time,fn){const old=Date.now;Date.now=()=>time;try{return fn();}finally{Date.now=old;}}
async function pair(t,tasks=[]){
 const dir=await mkdtemp(join(tmpdir(),'notemark-order-'));const host=await startServer({port:0,dataDir:dir,authRateLimit:10000});
 t.after(async()=>{await host.close();await rm(dir,{recursive:true,force:true});});
 const config=await createVault('http://127.0.0.1:'+host.port),a=fresh(),b=fresh();a.attach(config);b.attach(config);
 const ae=new SyncEngine(a),be=new SyncEngine(b),note=a.create('task',{title:'Offline list',createdAt:100,tasks});await ae.run();await be.run();return {a,b,ae,be,note};
}

test('item addition time is recorded once, survives restart and is unchanged by edits/completion',()=>{
 const a=fresh(),note=at(100,()=>a.create('task'));at(110,()=>a.update(note.id,{tasks:[{id:'a',text:'A',done:false}]}));
 at(220,()=>a.update(note.id,{tasks:[{id:'a',text:'Edited A',done:true},{id:'b',text:'B',done:false}]}));
 const reopened=new Notebook(a.storage);assert.equal(reopened.state.notes[note.id].createdAt,100);
 assert.deepEqual(reopened.state.notes[note.id].tasks.map(t=>t.createdAt),[110,220]);
 at(330,()=>reopened.update(note.id,{tasks:reopened.state.notes[note.id].tasks.map(t=>({...t,text:t.text+'!'}))}));
 assert.deepEqual(reopened.state.notes[note.id].tasks.map(t=>t.createdAt),[110,220]);
});
test('dashboard oldest-first uses original note creation, with deterministic ties and pinned priority',()=>{
 const b=fresh(),a=b.create('note',{createdAt:100,updatedAt:900}),c=b.create('note',{createdAt:300,updatedAt:100}),d=b.create('note',{createdAt:200,updatedAt:500});
 assert.deepEqual([c,d,a].sort(compareNotes).map(n=>n.id),[a.id,d.id,c.id]);
 assert.deepEqual([a,c,d].sort((a,b)=>compareNotes(a,b,'created')).map(n=>n.id),[c.id,d.id,a.id]);
 c.pinned=true;assert.equal([a,d,c].sort(compareNotes)[0].id,c.id);
 const left={...a,id:'a'},right={...a,id:'b'};assert.deepEqual([right,left].sort(compareNotes).map(n=>n.id),['a','b']);
});
test('offline additions merge by original item time in either upload order after restart',async t=>{
 for(const first of ['a','b']){
  const p=await pair(t);p.a.update(p.note.id,{tasks:[item('a-early',110),item('a-late',140)]});p.b.update(p.note.id,{tasks:[item('b-first',120),item('b-second',130)]});
  const a=new Notebook(p.a.storage),b=new Notebook(p.b.storage),ae=new SyncEngine(a),be=new SyncEngine(b);
  for(const engine of first==='a'?[ae,be,ae,be]:[be,ae,be,ae])await engine.run();
  const expected=['a-early','b-first','b-second','a-late'];assert.deepEqual(ids(a.state.notes[p.note.id]),expected);assert.deepEqual(ids(b.state.notes[p.note.id]),expected);
  assert.deepEqual(a.state.notes[p.note.id].tasks.map(t=>t.createdAt),[110,120,130,140]);assert.equal(a.state.notes[p.note.id].createdAt,100);
 }
});
test('equal-time additions and concurrent text rewrites have deterministic ordering and keep their times',async()=>{
 const base=fresh().create('task',{createdAt:10,tasks:[item('base',20)]}),a=structuredClone(base),b=structuredClone(base);
 a.tasks.push(item('z',30));b.tasks.push(item('a',30));a.tasks[0].text='one';b.tasks[0].text='two';
 const ab=await mergeChecklists(a,b,base),ba=await mergeChecklists(b,a,base);
 assert.deepEqual(ab.tasks,ba.tasks);assert.deepEqual(ab.tasks.filter(t=>t.createdAt===30).map(t=>t.id),['a','z']);assert.equal(ab.tasks.filter(t=>t.createdAt===20).length,2);
});
test('custom order persists and merges with offline completion and new items, then reset syncs',async t=>{
 const {a,b,ae,be,note}=await pair(t,[item('a',100),item('b',200),item('c',300)]);
 at(1000,()=>a.moveTask(note.id,'c',-1));b.update(note.id,{tasks:[item('a',100),item('b',200,true),item('c',300),item('d',250)]});
 for(const e of [ae,be,ae,be])await e.run();
 assert.deepEqual(ids(a.state.notes[note.id]),['a','c','b','d']);assert.deepEqual(a.state.notes[note.id].tasks,b.state.notes[note.id].tasks);
 assert.equal(b.state.notes[note.id].tasks.find(t=>t.id==='b').done,true);assert.equal(new Notebook(a.storage).state.notes[note.id].taskOrder.ids.length,3);
 const oldClock=b.state.notes[note.id].taskOrder.updatedAt;
 at(10,()=>b.resetTaskOrder(note.id));assert.ok(b.state.notes[note.id].taskOrder.updatedAt>oldClock);
 a.update(note.id,{title:'A later text edit'});for(const e of [ae,be,ae,be])await e.run();
 assert.deepEqual(ids(a.state.notes[note.id]),['a','b','d','c']);assert.deepEqual(a.state.notes[note.id].taskOrder.ids,[]);
});
test('concurrent offline manual moves converge even with equal device clocks',async t=>{
 const {a,b,ae,be,note}=await pair(t,[item('a',100),item('b',200),item('c',300)]);
 at(1000,()=>a.moveTask(note.id,'a',1));at(1000,()=>b.moveTask(note.id,'c',-1));
 const winner=[a.state.notes[note.id],b.state.notes[note.id]].sort((a,b)=>a.taskOrder.changeId<b.taskOrder.changeId?1:-1)[0];
 for(const e of [ae,be,ae,be])await e.run();assert.deepEqual(ids(a.state.notes[note.id]),ids(winner));assert.deepEqual(ids(a.state.notes[note.id]),ids(b.state.notes[note.id]));
});
test('legacy items retain their original sequence through reorder, restart and time-order reset',()=>{
 const b=fresh(),note=b.create('task',{tasks:['a','b','c'].map(id=>({id,text:id,done:false}))});
 b.moveTask(note.id,'c',-1);b.moveTask(note.id,'c',-1);assert.deepEqual(ids(b.state.notes[note.id]),['c','a','b']);
 const reopened=new Notebook(b.storage);reopened.resetTaskOrder(note.id);assert.deepEqual(ids(reopened.state.notes[note.id]),['a','b','c']);assert.ok(reopened.state.notes[note.id].tasks.every(t=>t.createdAt===undefined));
});
test('moves stay inside their completion group and failed order changes leave saved data intact',()=>{
 const b=fresh(),note=b.create('task',{tasks:[item('a',1),item('done',2,true),item('b',3)]});assert.equal(b.moveTask(note.id,'done',1),false);
 b.moveTask(note.id,'b',-1);assert.deepEqual(ids(b.state.notes[note.id]).filter(id=>id!=='done'),['b','a']);
 const state=JSON.stringify(b.state),disk=b.storage.value;b.storage.fail=true;
 assert.throws(()=>b.moveTask(note.id,'b',1),/Storage full/);assert.equal(JSON.stringify(b.state),state);assert.equal(b.storage.value,disk);
 assert.throws(()=>b.resetTaskOrder(note.id),/Storage full/);assert.equal(JSON.stringify(b.state),state);
});

test('drag drops move directly to either end without changing contents, times or the other section',()=>{
 const b=fresh(),note=b.create('task',{tasks:[item('a',1),item('done1',2,true),item('b',3),item('done2',4,true),item('c',5)]});
 assert.equal(b.placeTask(note.id,'a','c',true),true);assert.deepEqual(ids(b.state.notes[note.id]),['b','done1','c','done2','a']);
 assert.equal(b.placeTask(note.id,'a','b',false),true);assert.deepEqual(ids(b.state.notes[note.id]),['a','done1','b','done2','c']);
 b.placeTask(note.id,'done2','done1',false);assert.deepEqual(ids(b.state.notes[note.id]),['a','done2','b','done1','c']);
 for(const task of b.state.notes[note.id].tasks){const old=note.tasks.find(t=>t.id===task.id);assert.deepEqual(task,old);}
 assert.deepEqual(new Notebook(b.storage).state.notes[note.id].tasks,b.state.notes[note.id].tasks);
});

test('invalid, no-op and cross-section drops do not write; failed drops are atomic',()=>{
 const b=fresh(),note=b.create('task',{tasks:[item('a',1),item('b',2),item('done',3,true)]});const disk=b.storage.value;
 for(const args of [['a','a'],['a','b',false],['b','a',true],['missing','a'],['a','missing'],['a','done']])assert.equal(b.placeTask(note.id,...args),false);
 assert.equal(b.storage.value,disk);const saved=JSON.stringify(b.state);b.storage.fail=true;
 assert.throws(()=>b.placeTask(note.id,'b','a',false),/Storage full/);assert.equal(JSON.stringify(b.state),saved);assert.equal(b.storage.value,disk);
 b.storage.fail=false;b.batchTrash([note.id],true);assert.equal(b.placeTask(note.id,'b','a'),false);assert.equal(b.placeTask('missing','b','a'),false);
});

test('dragged order survives restart, offline additions and text changes, then time-order reset syncs',async t=>{
 const {a,b,ae,be,note}=await pair(t,[item('a',10),item('b',20),item('c',30),item('d',40)]);
 a.placeTask(note.id,'a','d',true);b.update(note.id,{tasks:[item('a',10),{...item('b',20),text:'Edited remotely'},item('c',30),item('d',40),item('new',25)]});
 const restarted=new Notebook(a.storage),re=new SyncEngine(restarted);for(const e of [re,be,re,be])await e.run();
 assert.deepEqual(ids(restarted.state.notes[note.id]),['b','c','d','a','new']);assert.deepEqual(restarted.state.notes[note.id].tasks,b.state.notes[note.id].tasks);assert.equal(b.state.notes[note.id].tasks[0].text,'Edited remotely');
 b.resetTaskOrder(note.id);for(const e of [be,re,be])await e.run();assert.deepEqual(ids(restarted.state.notes[note.id]),['a','b','new','c','d']);
});
test('ZIP and legacy JSON restore preserve item times and manual order metadata',async()=>{
 const b=fresh(),note=b.create('task',{tasks:[item('early',10),item('late',20)]});b.moveTask(note.id,'late',-1);
 const backup=await readBackup(await createBackup(b),'backup.zip'),copy=fresh();copy.import(backup);const restored=Object.values(copy.state.notes)[0];
 assert.deepEqual(restored.tasks,b.state.notes[note.id].tasks);assert.deepEqual(restored.taskOrder,b.state.notes[note.id].taskOrder);
 const legacy=fresh();legacy.import(b.export());assert.deepEqual(Object.values(legacy.state.notes)[0].taskOrder,restored.taskOrder);
});
test('malformed new timing/order metadata is rejected without partially importing a backup',()=>{
 const b=fresh(),note=b.create('task',{tasks:[item('one',10)]});
 for(const createdAt of [-1,'today',Infinity,NaN])assert.throws(()=>validNote({...payload(note),tasks:[{...item('one',10),createdAt}]}),/time/);
 const malformed={...payload(note),taskOrder:{ids:['one','one'],updatedAt:100,changeId:crypto.randomUUID()}};
 const saved=JSON.stringify(b.state);assert.throws(()=>b.import({schema:1,notes:[payload(note),malformed]}),/order/);assert.equal(JSON.stringify(b.state),saved);
});
test('permanent deletion still defeats an offline checklist reorder without conflict copies',async t=>{
 const {a,b,ae,be,note}=await pair(t,[item('a',100),item('b',200)]);a.batchTrash([note.id],true);a.permanentlyDelete([note.id]);b.moveTask(note.id,'b',-1);
 await ae.run();await be.run();assert.equal(Object.keys(b.state.notes).length,0);assert.ok(b.state.deletions[note.id]);
});

// Windows UI regression against real Electron and an isolated, unpaired profile.
// Run with: node test/editor-autosave.runtime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=await fs.mkdtemp(path.join(root,'.build/editor-autosave-'));
const profile=path.join(output,'profile');
const executable=process.env.NOTEMARK_QA_EXE ? path.resolve(process.env.NOTEMARK_QA_EXE) : path.join(root,'node_modules/electron/dist/electron.exe');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];
let processHandle,cdp;
async function open() {
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 processHandle=spawn(executable,[...(process.env.NOTEMARK_QA_EXE?[]:[root]),'--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`],{
  cwd:root,env:{...process.env,MIRA_USER_DATA:profile,MIRA_SYNC_PORT:'0'},windowsHide:true,stdio:'ignore'
 });
 let target;
 for(let i=0;i<50;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.includes('index.html'));if(target)break;}catch{}await pause(200);}
 if(!target)throw Error('Isolated Electron did not open');
 const socket=new WebSocket(target.webSocketDebuggerUrl);let sequence=0;const pending=new Map();
 socket.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error.message)):p.resolve(r.result);}});
 await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 cdp={call,close:()=>socket.close(),async evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}};
 await ready();
}
async function ready(){for(let i=0;i<50;i++){try{if(await cdp.evaluate(`document.readyState==='complete'&&!!document.getElementById('new-task')&&document.querySelectorAll('#notes-grid .note-card').length===Object.keys(JSON.parse(localStorage.getItem('mira.notes.v1')||'{"notes":{}}').notes).length`))return;}catch{}await pause(100);}throw Error('Editor did not become ready');}
async function close(){if(!cdp)return;await cdp.evaluate(`(()=>{setTimeout(()=>window.close(),50);return true})()`);cdp.close();cdp=null;await new Promise((resolve,reject)=>{if(processHandle.exitCode!==null)return resolve();const timer=setTimeout(()=>reject(Error('QA window did not close')),10000);processHandle.once('exit',()=>{clearTimeout(timer);resolve();});});}
const input=async(id,value)=>cdp.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));return true})()`);
const read=()=>cdp.evaluate(`JSON.parse(localStorage.getItem('mira.notes.v1'))`);
const click=id=>cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const type=kind=>cdp.evaluate(`(()=>{const e=document.getElementById('note-type');e.value=${JSON.stringify(kind)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function pointerDrag(source, target, {touch=false,after=false,cancel=false,outside=false,fail=false}={}) {
 await cdp.call('Page.bringToFront');await pause(60);
 const points=await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('#editor [data-task]')];const a=rows.find(e=>e.dataset.task===${JSON.stringify(source)}),b=rows.find(e=>e.dataset.task===${JSON.stringify(target)});a.scrollIntoView({block:'center'});const r=a.querySelector('[data-drag-task]').getBoundingClientRect(),s=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,toX:s.left+60,toY:s.top+s.height*${after?0.8:0.2}}})()`);
 const send=async(type,x,y)=>touch?cdp.call('Input.dispatchTouchEvent',{type,touchPoints:['touchEnd','touchCancel'].includes(type)?[]:[{x,y,id:1,radiusX:4,radiusY:4}]}):cdp.call('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
 await send(touch?'touchStart':'mousePressed',points.x,points.y);
 if(fail)await cdp.evaluate(`(()=>{window.qaOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('QA storage full','QuotaExceededError')};})()`);
 for(let step=1;step<=8;step++){await send(touch?'touchMove':'mouseMoved',points.x+(points.toX-points.x)*step/8,points.y+(points.toY-points.y)*step/8);await pause(16);}
 if(cancel){if(touch)await send('touchCancel',0,0);else await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
 if(!(cancel&&touch))await send(touch?'touchEnd':'mouseReleased',outside?2:points.toX,outside?2:points.toY);
 if(fail)await cdp.evaluate(`Storage.prototype.setItem=window.qaOriginalSetItem`);
 await pause(80);
}
try {
 await open();
 let noteId,firstNoteId;
 const draft='\nBuy milk, bread and vegetables. हिन्दी 🥦 '+ 'LongUnbrokenChecklistText'.repeat(7);
 await check('unfinished item saves on every input without Add; one stable item',async()=>{
  await click('new-note');await type('task');await input('note-title','Checklist '+'LongTitleWithoutSpaces'.repeat(10));
  await input('new-task','Buy milk');const a=await read();noteId=firstNoteId=Object.keys(a.notes)[0];
  await input('new-task',draft);const b=await read();assert.equal(b.notes[noteId].tasks.length,1);assert.equal(b.notes[noteId].tasks[0].id,a.notes[noteId].tasks[0].id);assert.equal(b.notes[noteId].tasks[0].text,draft);
  assert.equal(await cdp.evaluate(`document.querySelectorAll('#checklist [data-task]').length`),0);
 });
 await check('reload restores unsubmitted item as a normal checklist row',async()=>{
  await cdp.call('Page.reload');await pause(500);await ready();await cdp.evaluate(`document.querySelector('[data-open="${noteId}"]').click()`);
  assert.equal(await cdp.evaluate(`document.querySelector('.task-text').value`),draft);assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'');
 });
 await check('360px mobile title, checklist, body and new entry wrap without horizontal scrolling',async()=>{
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
  await input('new-task','AnotherLongUnbrokenEntry'.repeat(12));
  await cdp.evaluate(`window.dispatchEvent(new Event('resize'))`);
  const layout=await cdp.evaluate(`(()=>{const nodes=[document.getElementById('note-title'),document.querySelector('.task-text'),document.getElementById('new-task')];return {editorFits:document.getElementById('editor').scrollWidth<=document.getElementById('editor').clientWidth+1,fields:nodes.map(e=>({fits:e.scrollWidth<=e.clientWidth+1,height:e.clientHeight,line:parseFloat(getComputedStyle(e).lineHeight)}))}})()`);
  assert.equal(layout.editorFits,true);for(const field of layout.fields){assert.equal(field.fits,true);assert.ok(field.height>field.line*1.5);}
  await fs.writeFile(path.join(output,'mobile-checklist.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await input('new-task','');assert.equal((await read()).notes[noteId].tasks.length,1);
  await type('note');await input('note-body','LongBodyWord'.repeat(50)+'\nSecond line');assert.equal(await cdp.evaluate(`document.getElementById('note-body').scrollWidth<=document.getElementById('note-body').clientWidth+1`),true);await type('task');
 });
 await check('Add and Enter finalize existing autosaved item without duplicating it; Shift+Enter and IME stay editable',async()=>{
  await input('new-task','Second item');await cdp.evaluate(`document.getElementById('add-task-form').requestSubmit()`);assert.equal((await read()).notes[noteId].tasks.length,2);
  await input('new-task','Third item');await cdp.evaluate(`document.getElementById('new-task').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);assert.equal((await read()).notes[noteId].tasks.length,3);assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'');
  await input('new-task','पहली पंक्ति\nSecond line');await cdp.evaluate(`(()=>{const e=document.getElementById('new-task');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));})()`);assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'पहली पंक्ति\nSecond line');
 });
 await check('close and reopen saves an unsubmitted multiline item; completion moves it to Completed',async()=>{
  await click('close-editor');await cdp.evaluate(`document.querySelector('[data-open="${noteId}"]').click()`);
  const state=await read();assert.equal(state.notes[noteId].tasks.length,4);assert.equal(state.notes[noteId].tasks[3].text,'पहली पंक्ति\nSecond line');
  await cdp.evaluate(`(()=>{const e=document.querySelector('#checklist input[type=checkbox]');e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await cdp.evaluate(`document.querySelectorAll('#completed-checklist [data-task]').length`),1);
 });
 await check('new notes never inherit the previous note entry; folder and normal note body save without blur',async()=>{
  await input('new-task','Saved before opening another note');await click('close-editor');await click('new-note');
  const state=await read(),second=Object.keys(state.notes).find(id=>id!==noteId);assert.ok(second);noteId=second;
  assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'');await input('note-title','Restart proof');await input('note-body','Typed body without closing the editor');await input('note-folder','Autosaved folder');
  const saved=(await read()).notes[noteId];assert.equal(saved.body,'Typed body without closing the editor');assert.equal(saved.folder,'Autosaved folder');
 });
 await check('Windows app close and restart retains the unsubmitted Add field and other edits',async()=>{
  await type('task');await input('new-task','Saved even though Add was never pressed');await close();await open();
  const saved=(await read()).notes[noteId];assert.equal(saved.title,'Restart proof');assert.equal(saved.body,'Typed body without closing the editor');assert.equal(saved.folder,'Autosaved folder');assert.equal(saved.tasks.length,1);assert.equal(saved.tasks[0].text,'Saved even though Add was never pressed');
 });
 await check('a failed save keeps the editor open and the Add field intact',async()=>{
  await cdp.evaluate(`document.querySelector('[data-open="${noteId}"]').click()`);
  await cdp.evaluate(`(()=>{window.qaOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('QA storage full','QuotaExceededError')};})()`);
  await input('new-task','Keep this unsaved text');await cdp.evaluate(`document.getElementById('add-task-form').requestSubmit()`);
  assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'Keep this unsaved text');
  await click('close-editor');
  assert.equal(await cdp.evaluate(`document.getElementById('editor').open`),true);assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'Keep this unsaved text');
  await cdp.evaluate(`Storage.prototype.setItem=window.qaOriginalSetItem`);await click('close-editor');assert.equal(await cdp.evaluate(`document.getElementById('editor').open`),false);
 });
 await check('direct mouse and Android-style touch dragging, keyboard moves, restart and By time',async()=>{
  await cdp.evaluate(`document.querySelector('[data-open="${noteId}"]').click()`);await input('new-task','An unfinished item before reordering');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});await click('reorder-tasks');
  assert.equal(await cdp.evaluate(`document.getElementById('new-task').value`),'');
  const original=(await read()).notes[noteId].tasks.map(t=>t.id);assert.equal(original.length,3);assert.ok((await read()).notes[noteId].tasks.every(t=>Number.isFinite(t.createdAt)));
  assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-direction]').length`),0);
  await pointerDrag(original[2],original[0]);const moved=[original[2],original[0],original[1]];
  assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),moved);
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true});
  await pointerDrag(original[2],original[1],{touch:true,after:true});assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),original);
  await pointerDrag(original[2],original[0],{touch:true});assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),moved);
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:false});
  await cdp.evaluate(`document.querySelector('#checklist textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}))`);assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),[original[0],original[2],original[1]]);
  await cdp.evaluate(`document.querySelectorAll('#checklist [data-drag-task]')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`);assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),moved);
  assert.equal(await cdp.evaluate(`document.getElementById('editor').scrollWidth<=document.getElementById('editor').clientWidth+1`),true);
  await fs.writeFile(path.join(output,'mobile-reorder.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await close();await open();await cdp.evaluate(`document.querySelector('[data-open="${noteId}"]').click()`);
  assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),moved);await click('reset-task-order');assert.deepEqual((await read()).notes[noteId].tasks.map(t=>t.id),original);
  assert.deepEqual((await read()).notes[noteId].taskOrder.ids,[]);await click('close-editor');
 });
 await check('cancelled, outside, cross-section and failed drops keep saved order and editor intact',async()=>{
  await cdp.evaluate(`document.querySelector('[data-open="${firstNoteId}"]').click()`);await cdp.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.evaluate(`document.getElementById('editor').scrollTop=0`);
  const state=(await read()).notes[firstNoteId],pending=state.tasks.filter(t=>!t.done),completed=state.tasks.filter(t=>t.done),before=state.tasks.map(t=>t.id);
  for(const options of [{cancel:true},{outside:true},{fail:true}]){await pointerDrag(pending[1].id,pending[0].id,options);assert.deepEqual((await read()).notes[firstNoteId].tasks.map(t=>t.id),before);assert.equal(await cdp.evaluate(`document.getElementById('editor').open&&!document.querySelector('.task-drag-ghost')`),true);}
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true});await pointerDrag(pending[1].id,pending[0].id,{touch:true,cancel:true});await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:false});assert.deepEqual((await read()).notes[firstNoteId].tasks.map(t=>t.id),before);
  await pointerDrag(pending[0].id,completed[0].id);assert.deepEqual((await read()).notes[firstNoteId].tasks.map(t=>t.id),before);
  await click('close-editor');
 });
 await check('long-list dragging auto-scrolls and ordinary editing remains available',async()=>{
  await click('new-note');await type('task');await input('note-title','Drag scroll check');
  for(let i=0;i<22;i++){await input('new-task','Task '+i);await cdp.evaluate(`document.getElementById('add-task-form').requestSubmit()`);}
  const scrollId=Object.values((await read()).notes).find(n=>n.title==='Drag scroll check').id,ids=(await read()).notes[scrollId].tasks.map(t=>t.id);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
  const p=await cdp.evaluate(`(()=>{document.getElementById('editor').scrollTop=0;const h=document.querySelector('[data-drag-task]').getBoundingClientRect(),e=document.getElementById('editor').getBoundingClientRect();return {x:h.left+h.width/2,y:h.top+h.height/2,end:e.bottom-12}})()`);
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y,id:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.end,id:1}]});await pause(1800);
  assert.ok(await cdp.evaluate(`document.getElementById('editor').scrollTop`)>200);
  await fs.writeFile(path.join(output,'mobile-drag-active.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:false});
  const moved=(await read()).notes[scrollId].tasks.map(t=>t.id);assert.ok(moved.indexOf(ids[0])>6);assert.equal(moved.length,22);
  await cdp.evaluate(`(()=>{const t=document.querySelector('#checklist textarea');t.value='Edited after dragging';t.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);assert.equal((await read()).notes[scrollId].tasks[0].text,'Edited after dragging');
  await fs.writeFile(path.join(output,'mobile-drag-scroll.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  for(const id of ids.slice(-2))await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('[data-task]')].find(e=>e.dataset.task===${JSON.stringify(id)}),c=row.querySelector('input');c.checked=true;c.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pointerDrag(ids.at(-2),ids.at(-1),{after:true});assert.deepEqual((await read()).notes[scrollId].tasks.filter(t=>t.done).map(t=>t.id),[ids.at(-1),ids.at(-2)]);
  await click('close-editor');
 });
 await check('checking and unchecking keep the viewport still with mouse, touch and keyboard',async()=>{
  const target=Object.values((await read()).notes).find(n=>n.title==='Drag scroll check');
  await cdp.evaluate(`document.querySelector('[data-open="${target.id}"]').click()`);await cdp.call('Page.bringToFront');
  for(const mobile of [true,false]){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:mobile?360:1200,height:800,deviceScaleFactor:1,mobile});
   for(const mode of ['mouse','touch','keyboard'])for(const middle of [false,true]){
    const point=await cdp.evaluate(`(()=>{const e=document.getElementById('editor');e.scrollTop=${middle?500:0};const r=e.getBoundingClientRect();const c=[...document.querySelectorAll('#checklist input[type=checkbox]')].find(c=>{const b=c.getBoundingClientRect();return b.top>r.top+30&&b.bottom<r.bottom-30});const b=c.getBoundingClientRect();return {id:c.closest('[data-task]').dataset.task,x:b.left+b.width/2,y:b.top+b.height/2,top:e.scrollTop,page:window.scrollY}})()`);
    if(mode==='touch'){
     await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true});await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:false});
    }else if(mode==='mouse'){
     for(const event of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type:event,x:point.x,y:point.y,button:'left',buttons:event==='mousePressed'?1:0,clickCount:1});
    }else{
     await cdp.evaluate(`[...document.querySelectorAll('#checklist [data-task]')].find(r=>r.dataset.task===${JSON.stringify(point.id)}).querySelector('input').focus({preventScroll:true})`);
     for(const event of ['keyDown','keyUp'])await cdp.call('Input.dispatchKeyEvent',{type:event,key:' ',code:'Space',windowsVirtualKeyCode:32});
    }
    await pause(100);
    const after=await cdp.evaluate(`({top:document.getElementById('editor').scrollTop,page:window.scrollY,completed:[...document.querySelectorAll('#completed-checklist [data-task]')].some(e=>e.dataset.task===${JSON.stringify(point.id)})})`);
    assert.equal(after.completed,true,mode+' completion');assert.ok(Math.abs(after.top-point.top)<=1,`${mobile?'mobile':'desktop'} ${mode}: scroll moved ${point.top} -> ${after.top}`);assert.equal(after.page,point.page);assert.equal((await read()).notes[target.id].tasks.find(t=>t.id===point.id).done,true);
    const undo=await cdp.evaluate(`(()=>{const c=[...document.querySelectorAll('#completed-checklist [data-task]')].find(r=>r.dataset.task===${JSON.stringify(point.id)}).querySelector('input');c.scrollIntoView({block:'center'});const b=c.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,top:document.getElementById('editor').scrollTop}})()`);
    for(const event of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type:event,x:undo.x,y:undo.y,button:'left',buttons:event==='mousePressed'?1:0,clickCount:1});await pause(100);
    assert.equal((await read()).notes[target.id].tasks.find(t=>t.id===point.id).done,false);assert.ok(Math.abs(await cdp.evaluate(`document.getElementById('editor').scrollTop`)-undo.top)<=1,'uncheck preserves scroll');
   }
  }
  await click('close-editor');
 });
 await check('dashboard defaults to oldest first and preserves an explicitly chosen sort after restart',async()=>{
  assert.equal(await cdp.evaluate(`document.getElementById('sort').value`),'oldest');assert.equal(await cdp.evaluate(`document.querySelector('[data-open]').dataset.open`),firstNoteId);
  await cdp.evaluate(`(()=>{const s=document.getElementById('sort');s.value='created';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);assert.equal(await cdp.evaluate(`document.querySelector('[data-open]').getAttribute('aria-label')`),'Open Drag scroll check');
  await close();await open();assert.equal(await cdp.evaluate(`document.getElementById('sort').value`),'created');
  await cdp.evaluate(`(()=>{const s=document.getElementById('sort');s.value='oldest';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 });
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({ok:true,checks,isolatedProfile:true,at:new Date().toISOString()},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,output}));
}finally{if(cdp)await close();}

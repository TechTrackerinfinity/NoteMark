// Isolated browser-only QA host. Never included in packaged application web assets.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
const qa=`import {Notebook} from './core.mjs';
let fail=false; const save=Notebook.prototype.save;
Notebook.prototype.save=function(...args){if(fail){const error=new Error('Simulated storage failure');this.saveError=error;throw error;}return save.apply(this,args);};
const b=document.createElement('button'); b.id='qa-storage';b.textContent='QA: storage normal';b.style.cssText='position:fixed;bottom:4px;right:4px;z-index:20;background:white;color:black;border:1px solid gray;padding:8px';
const toggle=()=>{fail=!fail;b.textContent=fail?'QA: storage failing':'QA: storage normal';}; b.onclick=toggle;document.body.append(b);
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='f'){e.preventDefault();toggle();}});
await import('./app.mjs');`;
createServer(async(req,res)=>{try{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/qa.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(qa);}
 const path=resolve(root,'.'+(name==='/'?'/index.html':name));if(!path.startsWith(root+'/')&&!path.startsWith(root+'\\'))throw Error();
 let data=await readFile(path);if(name==='/')data=Buffer.from(data.toString().replace('src="app.mjs"','src="qa.mjs"'));
 res.writeHead(200,{'Content-Type':{'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
}catch{res.writeHead(404);res.end();}}).listen(5197,'127.0.0.1',()=>console.log('Isolated UI save-failure fixture: http://localhost:5197'));

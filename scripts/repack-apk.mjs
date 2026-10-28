import fs from 'node:fs';
import {zipSync,unzipSync} from 'fflate';
import {verifyApkZip} from './verify-apk-zip.mjs';
const [resources,dex,output]=process.argv.slice(2);
const entries=Object.create(null);
for(const [name,content] of Object.entries(unzipSync(fs.readFileSync(resources)))) {
  const canonical=name.replaceAll('\\','/');
  if(canonical==='classes.dex'||Object.hasOwn(entries,canonical)||canonical.startsWith('/')||canonical.includes(':')||canonical.split('/').some(s=>s==='..'||s==='.'))throw Error('Unexpected APK path: '+name);
  entries[canonical]=[content,{level:canonical==='resources.arsc'?0:6}];
}
entries['classes.dex']=[new Uint8Array(fs.readFileSync(dex)),{level:0}];
const result=zipSync(entries);verifyApkZip(result,{requireAlignment:false});fs.writeFileSync(output,result);

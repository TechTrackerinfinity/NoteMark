import fs from 'node:fs';
import {crc32,inflateRawSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

/** Check the metadata Android's ZIP extractor uses, not just the central directory. */
export function verifyApkZip(bytes,{requireAlignment=true}={}) {
  const b=Buffer.from(bytes);if(b.length<22||b.length>128*1024*1024)throw Error('APK size is invalid');
  let e=b.length-22;while(e>=Math.max(0,b.length-65557)&&b.readUInt32LE(e)!==0x06054b50)e--;
  if(e<0||b.readUInt32LE(e)!==0x06054b50)throw Error('ZIP end record is missing');
  const count=b.readUInt16LE(e+10),start=b.readUInt32LE(e+16),centralSize=b.readUInt32LE(e+12);
  if(b.readUInt16LE(e+4)||b.readUInt16LE(e+6)||count===65535||start+centralSize>e)throw Error('Unsupported ZIP layout');
  let p=start;const entries=new Map();
  for(let i=0;i<count;i++) {
    if(p+46>e||b.readUInt32LE(p)!==0x02014b50)throw Error('Central directory is invalid');
    const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),crc=b.readUInt32LE(p+16),packed=b.readUInt32LE(p+20),size=b.readUInt32LE(p+24);
    const n=b.readUInt16LE(p+28),x=b.readUInt16LE(p+30),c=b.readUInt16LE(p+32),local=b.readUInt32LE(p+42);
    if(p+46+n+x+c>start+centralSize||local+30>start||b.readUInt32LE(local)!==0x04034b50||size>64*1024*1024)throw Error('ZIP entry is out of bounds');
    const name=b.toString('utf8',p+46,p+46+n),ln=b.readUInt16LE(local+26),lx=b.readUInt16LE(local+28),data=local+30+ln+lx,end=data+packed;
    if(entries.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').some(s=>s==='..'||s==='.')||data>end||end>start)throw Error('Unsafe or duplicated APK entry');
    if(flags!==b.readUInt16LE(local+6)||method!==b.readUInt16LE(local+8)||!b.subarray(p+46,p+46+n).equals(b.subarray(local+30,local+30+ln)))throw Error('ZIP local/central metadata disagree: '+name);
    if(flags&1||![0,8].includes(method))throw Error('Unsupported APK compression: '+name);
    if(flags&8) {
      let descriptor=end;if(b.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;
      if(descriptor+12>start||b.readUInt32LE(descriptor)!==crc||b.readUInt32LE(descriptor+4)!==packed||b.readUInt32LE(descriptor+8)!==size)throw Error('Missing or inconsistent ZIP data descriptor: '+name);
    } else if(b.readUInt32LE(local+14)!==crc||b.readUInt32LE(local+18)!==packed||b.readUInt32LE(local+22)!==size)throw Error('ZIP entry sizes or CRC disagree: '+name);
    const content=method===0?b.subarray(data,end):inflateRawSync(b.subarray(data,end),{maxOutputLength:Math.max(size+1,1)});
    if(content.length!==size||crc32(content)!==crc)throw Error('ZIP content size or CRC is invalid: '+name);
    if(name==='classes.dex'||name==='resources.arsc') {
      if(method!==0)throw Error('Android executable/resources must be ZIP-stored: '+name);
      if(requireAlignment&&data%4)throw Error('Android executable/resources are not aligned: '+name);
    }
    entries.set(name,{flags,method,size,dataOffset:data});p+=46+n+x+c;
  }
  if(!entries.has('classes.dex')||!entries.has('resources.arsc')||!entries.has('AndroidManifest.xml'))throw Error('Required APK entry is missing');
  return {ok:true,entries:entries.size,dex:entries.get('classes.dex'),resources:entries.get('resources.arsc')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(verifyApkZip(fs.readFileSync(process.argv[2])),null,2));

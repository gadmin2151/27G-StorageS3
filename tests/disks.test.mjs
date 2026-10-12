import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, rename, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeDisk, mountArguments, hostDeviceMounted, DiskManager, createDiskAgent } from '../src/disk-agent.mjs';
const token='disk-test-token-'.repeat(4);
const noCommands=async()=>{throw new Error('No external commands allowed in folder tests');};
async function workspace(t){const dir=await mkdtemp(join(tmpdir(),'27g-disks-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,'external');await mkdir(source);return{dir,source,dataDir:join(dir,'state')};}
async function agentFixture(t){const paths=await workspace(t);const agent=await createDiskAgent({...paths,token,allowedRoots:[paths.source],run:noCommands});await new Promise(resolve=>agent.server.listen(0,'127.0.0.1',resolve));t.after(()=>agent.close());const url=`http://127.0.0.1:${agent.server.address().port}`;return{...paths,...agent,url};}
const bearer=value=>({authorization:`Bearer ${value}`});

test('disk validation rejects unsafe sources and command argument injection without exposing SMB secrets',()=>{
  for(const input of [null,{kind:'folder',source:'/'},{kind:'device',source:'/dev/../etc/passwd'},{kind:'smb',source:'//host/share,foo=bar',username:'x',password:'y'},{kind:'smb',source:'//host/share',username:'a\nb',password:'x'},{kind:'nfs',source:'host:/share -o exec;evil'}])assert.throws(()=>normalizeDisk(input));
  assert.equal(hostDeviceMounted('24 20 8:1 / / rw - ext4 /dev/sda1 rw','8:1'),true);assert.equal(hostDeviceMounted('24 20 8:1 / / rw - ext4 /dev/sda1 rw','8:2'),false);assert.equal(hostDeviceMounted('invalid','8:2'),true);
  const smb=normalizeDisk({kind:'smb',source:'//server/share',username:'domain user',password:'very secret',domain:'DOMAIN'});const args=mountArguments(smb,'/target','/private/credentials');assert.equal(args.includes('very secret'),false);assert.ok(args.includes('--'));assert.match(args.join(' '),/seal/);assert.match(args.join(' '),/nosuid,nodev,noexec/);
  assert.deepEqual(mountArguments({kind:'device',source:'/dev/sdb1',filesystem:'ext4'},'/target'),['-t','ext4','-o','rw,nosuid,nodev,noexec','--','/dev/sdb1','/target']);
});

test('folder volume persists ownership and unique host identity; HTTP authorization precedes mount probing',async t=>{
  const a=await agentFixture(t);const response=await fetch(`${a.url}/disks`,{method:'POST',headers:{...bearer(token),'content-type':'application/json'},body:JSON.stringify({kind:'folder',source:a.source,label:'Local disk'})});assert.equal(response.status,201);const disk=await response.json();assert.equal(disk.state,'ready');
  let probes=0;const original=a.manager.mounted.bind(a.manager);a.manager.mounted=async disk=>{probes++;return original(disk);};assert.equal((await fetch(`${a.url}/volumes/${disk.id}/health`)).status,401);assert.equal(probes,0);
  const health=await (await fetch(`${a.url}/volumes/${disk.id}/health`,{headers:bearer(disk.token)})).json();assert.match(health.filesystemId,new RegExp(`^${a.manager.hostId}:`));
  const id=randomUUID(),data='hello disk',sha=createHash('sha256').update(data).digest('hex');const put=await fetch(`${a.url}/volumes/${disk.id}/blobs/${id}`,{method:'PUT',headers:{...bearer(disk.token),'x-content-sha256':sha},body:data});assert.equal(put.status,201);assert.equal(await(await fetch(`${a.url}/volumes/${disk.id}/blobs/${id}`,{headers:bearer(disk.token)})).text(),data);
  const duplicate=await fetch(`${a.url}/disks`,{method:'POST',headers:bearer(token),body:JSON.stringify({kind:'folder',source:a.source})});assert.equal(duplicate.status,400);
  const hostId=a.manager.hostId;await a.manager.close();const reopened=await new DiskManager({dataDir:a.dataDir,token,allowedRoots:[a.source],run:noCommands}).init();t.after(()=>reopened.close());assert.equal(reopened.hostId,hostId);assert.equal(reopened.disks[0].state,'ready');
  const another=await new DiskManager({dataDir:join(a.dir,'other-state'),token,allowedRoots:[a.source],run:noCommands}).init();t.after(()=>another.close());assert.notEqual(another.hostId,hostId);const owned=await another.add({kind:'folder',source:a.source});assert.equal(owned.state,'unavailable');assert.equal((await readFile(join(a.source,'.27g-storeges3','volume.id'),'utf8')).trim(),disk.id);
});

test('renaming the mounted folder during PUT never writes into replacement directory and fails closed',async t=>{
  const a=await agentFixture(t),disk=await a.manager.add({kind:'folder',source:a.source});const blob=randomUUID(),first=Buffer.alloc(65536,97);let resolveResponse,rejectResponse;const result=new Promise((resolve,reject)=>{resolveResponse=resolve;rejectResponse=reject;});
  const req=request(`${a.url}/volumes/${disk.id}/blobs/${blob}`,{method:'PUT',headers:bearer(disk.token)},res=>{res.resume();res.on('end',()=>resolveResponse(res.statusCode));});req.on('error',rejectResponse);req.write(first);
  const temporary=join(a.source,'.27g-storeges3','tmp');for(let i=0;i<100;i++){if((await readdir(temporary)).length)break;await delay(5);}assert.equal((await readdir(temporary)).length,1);
  const moved=join(a.dir,'detached');await rename(a.source,moved);await mkdir(a.source);await mkdir(join(a.source,'.27g-storeges3','tmp'),{recursive:true});await mkdir(join(a.source,'.27g-storeges3','blobs'));
  await assert.rejects(a.manager.retry(disk.id),{status:409});req.end('last');assert.equal(await result,503);assert.deepEqual(await readdir(join(a.source,'.27g-storeges3','blobs')),[]);assert.deepEqual(await readdir(join(a.source,'.27g-storeges3','tmp')),[]);
  assert.equal((await fetch(`${a.url}/volumes/${disk.id}/health`,{headers:bearer(disk.token)})).status,503);assert.equal((await a.manager.list())[0].state,'unavailable');
});

test('a disconnected client cannot release pinned directories while its write handler is still completing',async t=>{
  const a=await agentFixture(t),disk=await a.manager.add({kind:'folder',source:a.source});
  const mounted=a.manager.mounted.bind(a.manager);let calls=0,reached,resume;const gate=new Promise(resolve=>{resume=resolve;}),paused=new Promise(resolve=>{reached=resolve;});
  a.manager.mounted=async value=>{if(++calls===3){reached();await gate;}return mounted(value);};
  const req=request(`${a.url}/volumes/${disk.id}/blobs/${randomUUID()}`,{method:'PUT',headers:bearer(disk.token)});req.on('error',()=>{});req.end('payload');
  try{await paused;req.destroy();await delay(10);assert.equal(a.manager.activeRequests.get(disk.id),1);await assert.rejects(a.manager.retry(disk.id),{status:409});}
  finally{resume();for(let i=0;i<100&&a.manager.activeRequests.get(disk.id);i++)await delay(5);}
  assert.equal(a.manager.activeRequests.get(disk.id),undefined);assert.equal((await a.manager.retry(disk.id)).token,disk.token);
});

test('SMB credentials stay encrypted at rest, private during mount and recover after pending crash state',async t=>{
  const {dir,source,dataDir}=await workspace(t);let mounted=false,seenCredentials=false,commandCalls=0,manager;
  const run=async(name,args)=>{commandCalls++;if(name==='findmnt'){if(!mounted)throw Object.assign(new Error('not mounted'),{code:1});return{stdout:JSON.stringify({filesystems:[{target:manager.disks[0].target,source:'//server/share',fstype:'cifs',id:77}]})};}if(name==='mount'){const option=args[args.indexOf('-o')+1],path=/credentials=([^,]+)/.exec(option)[1];const contents=await readFile(path,'utf8');assert.match(contents,/password=private-test-password/);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(args.join(' ').includes('private-test-password'),false);seenCredentials=true;mounted=true;return{stdout:''};}throw new Error('unexpected command');};
  manager=await new DiskManager({dataDir,token,allowedRoots:[source],run}).init();t.after(()=>manager.close());const disk=await manager.add({kind:'smb',source:'//server/share',username:'testuser',password:'private-test-password'});assert.equal(disk.state,'ready');assert.equal(seenCredentials,true);assert.equal(JSON.stringify(await manager.list()).includes('private-test-password'),false);assert.equal((await readFile(join(dataDir,'disks.json'),'utf8')).includes('private-test-password'),false);assert.equal((await readdir(dataDir)).some(name=>name.startsWith('.smb-')),false);
  const savedId=disk.id;await manager.close();await writeFile(join(dataDir,`.smb-${randomUUID()}`),'stale password',{mode:0o600});manager=await new DiskManager({dataDir,token,allowedRoots:[source],run}).init();assert.equal(manager.disks[0].id,savedId);assert.equal(manager.disks[0].state,'ready');assert.equal((await readdir(dataDir)).some(name=>name.startsWith('.smb-')),false);assert.ok(commandCalls>0);
});

test('folder allowlist follows real paths and rejects a symlinked storage root',async t=>{
  const {dir,source,dataDir}=await workspace(t);const manager=await new DiskManager({dataDir,token,allowedRoots:[source],run:noCommands}).init();t.after(()=>manager.close());const outside=join(dir,'outside');await mkdir(outside);const alias=join(source,'link');await symlink(outside,alias);await assert.rejects(manager.add({kind:'folder',source:alias}),{status:400});
  await symlink(outside,join(source,'.27g-storeges3'));const disk=await manager.add({kind:'folder',source});assert.equal(disk.state,'unavailable');assert.deepEqual(await readdir(outside),[]);
});

test('device retry rechecks host ownership and failed mount discovery never attempts another mount',async t=>{
  const {dir,dataDir}=await workspace(t),mountInfo=join(dir,'host-mountinfo');
  let mounts=0,discoveryError=false,checks=0;
  const run=async(name)=>{
    if(name==='findmnt')throw Object.assign(new Error('mount discovery'),{code:discoveryError?2:1});
    if(name==='lsblk')return{stdout:JSON.stringify({blockdevices:[{name:'/dev/test-device',fstype:'ext4',mountpoints:[null],'maj:min':'8:8'}]})};
    if(name==='mount'){mounts++;throw new Error('No real mounts allowed in tests');}
    throw new Error('unexpected command');
  };
  const manager=await new DiskManager({dataDir,token,allowDevices:true,hostMountInfoFile:mountInfo,run}).init();t.after(()=>manager.close());
  const disk={id:randomUUID(),kind:'device',source:'/dev/test-device',filesystem:'ext4',state:'pending'};
  await writeFile(mountInfo,'24 20 8:1 / / rw - ext4 /dev/root rw\n');
  await manager.checkDeviceUsage(disk);manager.disks.push(disk);await manager.save();
  // Hardware presence is simulated; real lsblk and mount are never executed.
  manager.checkDevice=async value=>{checks++;return manager.checkDeviceUsage(value);};
  await writeFile(mountInfo,'24 20 8:1 / / rw - ext4 /dev/root rw\n25 20 8:8 / /other rw - ext4 /dev/test-device rw\n');
  await assert.rejects(manager.retry(disk.id),{status:400});assert.equal(checks,1);assert.equal(mounts,0);assert.equal(disk.state,'unavailable');
  discoveryError=true;await assert.rejects(manager.retry(disk.id),{status:400});assert.equal(checks,1);assert.equal(mounts,0);
});

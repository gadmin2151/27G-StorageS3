import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Storage } from '../src/storage.mjs';
import { createNodeServer } from '../src/node.mjs';
const body=value=>Readable.from([Buffer.from(value)]);
async function fixture(t,options={}) {const dir=await mkdtemp(join(tmpdir(),'27g-versions-'));let storage=await new Storage({dataDir:dir,...options}).init();await storage.createBucket('example');t.after(async()=>{storage.close();await rm(dir,{recursive:true,force:true});});return {dir,get storage(){return storage;},async restart(){storage.close();storage=await new Storage({dataDir:dir,...options}).init();}};}
async function content(storage,key,options){const result=await storage.getObject('example',key,options);const data=[];for await(const chunk of result.stream)data.push(chunk);return Buffer.concat(data).toString();}
async function nodeFixture(t){const dir=await mkdtemp(join(tmpdir(),'27g-version-node-')),token='version-node-token-'.repeat(4),server=await createNodeServer({dataDir:dir,token});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});return {dir,node:{id:'peer',url:`http://127.0.0.1:${server.address().port}`,token}};}

test('five retained content versions, tombstone restore and restart preserve history and pinning',async t=>{
  const f=await fixture(t);const written=[];
  for(let i=0;i<7;i++)written.push(await f.storage.putObject('example','file',body(`version-${i}`)));
  const versions=(await f.storage.listObjectVersions('example')).versions;assert.equal(versions.length,5);assert.deepEqual(versions.map(x=>x.versionId),written.slice(2).reverse().map(x=>x.versionId));assert.equal(versions[0].isLatest,true);
  assert.equal((await f.storage.listObjects('example')).objects[0].versionId,written[6].versionId);
  await assert.rejects(f.storage.getObject('example','file',{versionId:written[0].versionId}),{code:'NoSuchVersion'});
  const generation=f.storage.objectGeneration('example','file'),deleted=await f.storage.deleteObject('example','file');assert.equal(deleted.isDeleteMarker,true);assert.equal((await f.storage.listTrash('example'))[0].restoreVersionId,written[6].versionId);
  await assert.rejects(f.storage.headObject('example','file'),{code:'NoSuchKey'});assert.equal((await f.storage.listObjectVersions('example')).versions.length,6);
  await f.restart();assert.equal(await content(f.storage,'file',{versionId:written[3].versionId}),'version-3');
  await f.storage.restoreObject('example','file',written[3].versionId);assert.equal(await content(f.storage,'file'),'version-3');assert.equal((await f.storage.listObjectVersions('example')).versions.length,5);assert.deepEqual(await f.storage.listTrash('example'),[]);
  await assert.rejects(f.storage.getObject('example','file',{expectedBlobId:generation}),{code:'NoSuchKey'});
  f.storage.db.prepare('UPDATE garbage SET retired_at=0').run();await f.storage.garbageCollect();for(const version of (await f.storage.listObjectVersions('example')).versions)await content(f.storage,'file',{versionId:version.versionId});assert.equal((await readdir(join(f.dir,'blobs'))).length,5);
});

test('persistent multipart resume, checksum/order/minimum-size validation and atomic completion',async t=>{
  const f=await fixture(t);const upload=await f.storage.createMultipartUpload('example','big',{owner:'alice'}),first=Buffer.alloc(5*1024**2,97);
  const part1=await f.storage.uploadPart('example','big',upload.uploadId,1,body(first),{owner:'alice'});await f.restart();const part2=await f.storage.uploadPart('example','big',upload.uploadId,2,body('end'),{owner:'alice'});
  const page=await f.storage.listParts('example','big',upload.uploadId,{maxParts:1,owner:'alice'});assert.equal(page.isTruncated,true);assert.equal(page.nextPartNumberMarker,1);assert.equal((await f.storage.listMultipartUploads('example')).uploads[0].uploadId,upload.uploadId);
  await assert.rejects(f.storage.uploadPart('example','big',upload.uploadId,2,body('wrong'),{expectedSha256:'0'.repeat(64)}),{code:'XAmzContentSHA256Mismatch'});
  await assert.rejects(f.storage.completeMultipartUpload('example','big',upload.uploadId,[{partNumber:2,etag:part2.etag},{partNumber:1,etag:part1.etag}]),{code:'InvalidPartOrder'});
  await assert.rejects(f.storage.completeMultipartUpload('example','big',upload.uploadId,[{partNumber:1,etag:'0'.repeat(32)}]),{code:'InvalidPart'});
  await assert.rejects(f.storage.abortMultipartUpload('example','big',upload.uploadId,{owner:'bob'}),{code:'AccessDenied'});
  const result=await f.storage.completeMultipartUpload('example','big',upload.uploadId,[{partNumber:1,etag:part1.etag},{partNumber:2,etag:part2.etag}],{owner:'alice'});assert.equal(result.size,first.length+3);assert.match(result.etag,/-2$/);assert.equal(result.owner,'alice');assert.equal((await content(f.storage,'big')).slice(-3),'end');assert.equal((await f.storage.listMultipartUploads('example')).uploads.length,0);assert.equal(f.storage.ownerUsage('alice').objects,1);
  const small=await f.storage.createMultipartUpload('example','small');const a=await f.storage.uploadPart('example','small',small.uploadId,1,body('a')),b=await f.storage.uploadPart('example','small',small.uploadId,2,body('b'));
  await assert.rejects(f.storage.completeMultipartUpload('example','small',small.uploadId,[{partNumber:1,etag:a.etag},{partNumber:2,etag:b.etag}]),{code:'EntityTooSmall'});await f.storage.abortMultipartUpload('example','small',small.uploadId);
});

test('quota reservations serialize concurrent writers and count retained versions and multipart bytes',async t=>{
  const f=await fixture(t);await f.storage.setBucketQuota('example',{maxBytes:5,maxObjects:3});
  const results=await Promise.allSettled([f.storage.putObject('example','a',body('abcd')),f.storage.putObject('example','b',body('abcd'))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'QuotaExceeded');assert.equal(f.storage.bucketUsage('example').bytes,4);assert.equal(f.storage.bucketUsage('example').reservedBytes,0);
  const present=(await f.storage.listObjects('example')).objects[0].key;await f.storage.deleteObject('example',present);assert.equal(f.storage.bucketUsage('example').bytes,4);await assert.rejects(f.storage.putObject('example','c',body('xx')),{code:'QuotaExceeded'});
  for(const version of (await f.storage.listObjectVersions('example')).versions)await f.storage.deleteObject('example',version.key,{versionId:version.versionId});
  const upload=await f.storage.createMultipartUpload('example','mpu');await f.storage.uploadPart('example','mpu',upload.uploadId,1,body('12345'));assert.equal(f.storage.bucketUsage('example').bytes,5);await assert.rejects(f.storage.uploadPart('example','mpu',upload.uploadId,2,body('x')),{code:'QuotaExceeded'});await f.storage.abortMultipartUpload('example','mpu',upload.uploadId);assert.equal(f.storage.bucketUsage('example').bytes,0);
  f.storage.quotaPolicy=owner=>({enabled:owner!=='disabled',quotaBytes:3,quotaObjects:1});await f.storage.putObject('example','owned',body('123'),{owner:'alice'});await assert.rejects(f.storage.createMultipartUpload('example','another',{owner:'alice'}),{code:'QuotaExceeded'});await assert.rejects(f.storage.putObject('example','denied',body('x'),{owner:'disabled'}),{code:'AccessDenied'});
});

test('migration, repair and GC include historical versions and unfinished upload parts',async t=>{
  const f=await fixture(t,{cacheBytes:0}),peer=await nodeFixture(t);const a=await f.storage.putObject('example','file',body('old'));await f.storage.putObject('example','file',body('new'));const upload=await f.storage.createMultipartUpload('example','unfinished');const part=await f.storage.uploadPart('example','unfinished',upload.uploadId,1,body('part'));
  const result=await f.storage.configure({mode:'raid1',nodes:[{id:'local',url:'local'},peer.node],migrate:true});assert.equal(result.migrated,3);assert.equal((await readdir(join(peer.dir,'blobs'))).length,3);
  const old=f.storage.db.prepare('SELECT blob_id FROM object_versions WHERE version_id=?').get(a.versionId);await writeFile(join(f.dir,'blobs',old.blob_id),'broken');const scrub=await f.storage.scrub();assert.equal(scrub.checked,3);assert.equal(scrub.repaired,1);assert.equal(await content(f.storage,'file',{versionId:a.versionId}),'old');
  f.storage.db.prepare('UPDATE garbage SET retired_at=0').run();await f.storage.garbageCollect();assert.equal((await readdir(join(peer.dir,'blobs'))).length,3);
  await f.storage.completeMultipartUpload('example','unfinished',upload.uploadId,[{partNumber:1,etag:part.etag}]);assert.equal(await content(f.storage,'unfinished'),'part');
});

test('metadata snapshot roundtrip restores versions, quotas, parts and topology atomically',async t=>{
  const f=await fixture(t);await f.storage.putObject('example','file',body('one'));await f.storage.putObject('example','file',body('two'));const upload=await f.storage.createMultipartUpload('example','mpu');await f.storage.uploadPart('example','mpu',upload.uploadId,1,body('part'));await f.storage.setBucketQuota('example',{maxBytes:99,maxObjects:9});const snapshot=f.storage.exportState();await f.storage.deleteObject('example','file');await f.storage.abortMultipartUpload('example','mpu',upload.uploadId);await f.storage.importState(snapshot);assert.deepEqual(f.storage.exportState(),snapshot);assert.equal(await content(f.storage,'file'),'two');assert.equal((await f.storage.listParts('example','mpu',upload.uploadId)).parts.length,1);
  const broken=structuredClone(snapshot);broken.tables.multipart_parts[0].upload_id='absent';await assert.rejects(f.storage.importState(broken));assert.deepEqual(f.storage.exportState(),snapshot);
});

test('snapshot rollback without persisted runtime restores the constructor cache and concurrency defaults',async t=>{
  const f=await fixture(t,{cacheBytes:65536,concurrency:2});const baseline=f.storage.exportState();
  assert.equal(baseline.tables.settings.some(row=>row.key==='runtime'),false);
  await f.storage.updateSettings({cacheBytes:131072,concurrency:5});
  assert.equal(f.storage.cacheBytes,131072);assert.equal(f.storage.concurrency,5);
  await f.storage.importState(baseline);
  assert.deepEqual(f.storage.exportState(),baseline);assert.equal(f.storage.cacheBytes,65536);assert.equal(f.storage.concurrency,2);
  const status=await f.storage.status();assert.equal(status.cache.limit,65536);assert.equal(status.queue.concurrency,2);
  // A later acknowledged update must still override the constructor defaults.
  await f.storage.updateSettings({cacheBytes:262144,concurrency:3});const committed=f.storage.exportState();
  await f.storage.updateSettings({cacheBytes:0,concurrency:1});await f.storage.importState(committed);
  assert.equal(f.storage.cacheBytes,262144);assert.equal(f.storage.concurrency,3);
});

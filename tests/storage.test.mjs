import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Storage } from '../src/storage.mjs';
import { createNodeServer } from '../src/node.mjs';

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), '27g-storage-')); let storage = await new Storage({ dataDir: dir, ...options }).init();
  t.after(async () => { storage.close(); await rm(dir, { recursive: true, force: true }); });
  return { storage, dir, restart: async () => { storage.close(); storage = await new Storage({ dataDir: dir, ...options }).init(); return storage; } };
}
const body = value => Readable.from([Buffer.from(value)]);
async function read(storage, key = 'hello', bucket = 'test-bucket') { const result = await storage.getObject(bucket, key); const chunks = []; for await (const chunk of result.stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
async function remote(t) {
  const dir = await mkdtemp(join(tmpdir(), '27g-node-')); const token = 'test-node-token-'.repeat(4); const server = await createNodeServer({ dataDir: dir, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dir, { recursive: true, force: true }); });
  return { dir, token, url, server };
}

test('durable object restart, literal keys, checksum rejection and cache invalidation', async t => {
  const setupResult = await setup(t); let { storage } = setupResult;
  await storage.createBucket('test-bucket'); const key = '../../etc/passwd//a';
  await storage.putObject('test-bucket', key, body('first')); assert.equal(await read(storage, key), 'first'); assert.equal(await read(storage, key), 'first');
  assert.equal((await storage.status()).cache.hits, 1);
  await assert.rejects(storage.putObject('test-bucket', key, body('corrupt'), { expectedSha256: '0'.repeat(64) }), { code: 'XAmzContentSHA256Mismatch' });
  assert.equal(await read(storage, key), 'first');
  await assert.rejects(storage.putObject('test-bucket', key, body('corrupt'), { expectedMd5: Buffer.from('wrong').toString('base64') }), { code: 'BadDigest' });
  const expectedMd5 = createHash('md5').update('second').digest('base64'); await storage.putObject('test-bucket', key, body('second'), { expectedMd5 }); assert.equal(await read(storage, key), 'second');
  storage = await setupResult.restart(); assert.equal(await read(storage, key), 'second'); assert.equal((await storage.buckets())[0].bytes, 6);
  assert.equal((await readdir(join(setupResult.dir, 'blobs'))).every(name => /^[a-f\d-]{36}$/.test(name)), true);
  await assert.rejects(storage.deleteBucket('test-bucket'), { code: 'BucketNotEmpty' });
  await storage.deleteObject('test-bucket', key); await assert.rejects(storage.headObject('test-bucket', key), { code: 'NoSuchKey' });
  await assert.rejects(storage.deleteBucket('test-bucket'), { code: 'BucketNotEmpty' });
  for (const version of (await storage.listObjectVersions('test-bucket')).versions) await storage.deleteObject('test-bucket', key, { versionId: version.versionId });
  await storage.deleteBucket('test-bucket'); assert.deepEqual(await storage.buckets(), []);
});

test('bounded payload and queue preserve committed value on failure', async t => {
  const { storage } = await setup(t, { maxObjectBytes: 8, concurrency: 1, queueLimit: 1 }); await storage.createBucket('test-bucket'); await storage.putObject('test-bucket', 'hello', body('valid'));
  await assert.rejects(storage.putObject('test-bucket', 'hello', body('0123456789')), { code: 'EntityTooLarge' }); assert.equal(await read(storage), 'valid');
  let release, started; const entered = new Promise(resolve => { started = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const first = storage.putObject('test-bucket', 'one', (async function* () { started(); await gate; yield Buffer.from('1'); })()); await entered;
  const second = storage.putObject('test-bucket', 'two', body('2')); await assert.rejects(storage.putObject('test-bucket', 'three', body('3')), { code: 'SlowDown' }); release(); await Promise.all([first, second]);
});

test('list delimiter pagination and start-after preserve literal ordering', async t => {
  const { storage } = await setup(t); await storage.createBucket('test-bucket');
  for (const key of ['a/1', 'a/2', 'b/1', 'b/2', 'root']) await storage.putObject('test-bucket', key, body(key));
  const one = await storage.listObjects('test-bucket', { maxKeys: 1, delimiter: '/' }); assert.deepEqual(one.commonPrefixes, ['a/']); assert.equal(one.isTruncated, true);
  const two = await storage.listObjects('test-bucket', { maxKeys: 1, delimiter: '/', continuationToken: one.nextContinuationToken }); assert.deepEqual(two.commonPrefixes, ['b/']);
  const three = await storage.listObjects('test-bucket', { maxKeys: 1, delimiter: '/', continuationToken: two.nextContinuationToken }); assert.deepEqual(three.objects.map(item => item.key), ['root']); assert.equal(three.isTruncated, false);
  const after = await storage.listObjects('test-bucket', { startAfter: 'a/1', delimiter: '/' }); assert.deepEqual(after.commonPrefixes, ['b/']);
  await assert.rejects(storage.listObjects('test-bucket', { prefix: 'x', continuationToken: one.nextContinuationToken }), { code: 'InvalidArgument' });
});

test('RAID rules, persisted settings, node secret redaction', async t => {
  const { storage } = await setup(t); const local = { id: 'local', url: 'local' }, peer = { id: 'peer', url: 'http://127.0.0.1:1234', token: 'x'.repeat(32) };
  await assert.rejects(storage.configure({ mode: 'raid1', nodes: [local] }), { code: 'InvalidArgument' });
  await assert.rejects(storage.configure({ mode: 'raid10', nodes: [local, peer] }), { code: 'InvalidArgument' });
  await assert.rejects(storage.configure({ mode: 'raid0', nodes: [{ ...peer, url: 'file:///tmp' }] }), { code: 'InvalidArgument' });
  await assert.rejects(storage.createBucket('../invalid'), { code: 'InvalidBucketName' });
  await storage.configure({ mode: 'raid1', nodes: [local, peer] }); assert.equal(JSON.stringify(await storage.topology()).includes(peer.token), false);
  await storage.updateSettings({ cacheBytes: 10, concurrency: 2 }); assert.equal((await storage.status()).queue.concurrency, 2);
});

test('real remote replication, integrity failover, repair, failed overwrite and migration rollback', async t => {
  const fixture = await setup(t, { cacheBytes: 0 }); let { storage, dir } = fixture; const node = await remote(t); const local = { id: 'local', url: 'local' }, peer = { id: 'peer', url: node.url, token: node.token };
  assert.equal((await fetch(`${node.url}/health`)).status, 401);
  assert.equal((await fetch(`${node.url}/blobs/../../bad`, { method: 'PUT', headers: { authorization: `Bearer ${node.token}` }, body: 'x' })).status, 404);
  await storage.createBucket('test-bucket'); await storage.putObject('test-bucket', 'hello', body('replicated'));
  await assert.rejects(storage.configure({ mode: 'raid1', nodes: [local, peer] }), { code: 'TopologyLocked' });
  const migrated = await storage.configure({ mode: 'raid1', nodes: [local, peer], migrate: true }); assert.equal(migrated.migrated, 1);
  const localBlobs = await readdir(join(dir, 'blobs')); assert.equal((await readdir(join(node.dir, 'blobs'))).length, 1);
  await writeFile(join(dir, 'blobs', localBlobs[0]), 'broken'); assert.equal(await read(storage), 'replicated');
  const scrub = await storage.scrub(); assert.equal(scrub.repaired, 1); assert.equal(scrub.unrecoverable, 0);
  await new Promise(resolve => { node.server.close(resolve); node.server.closeAllConnections(); });
  assert.equal(await read(storage), 'replicated');
  await assert.rejects(storage.putObject('test-bucket', 'hello', body('new-value')), { code: 'ServiceUnavailable' }); assert.equal(await read(storage), 'replicated');
  await assert.rejects(storage.configure({ mode: 'raid0', nodes: [peer], migrate: true }), { code: 'ServiceUnavailable' }); assert.equal((await storage.topology()).mode, 'raid1'); assert.equal(await read(storage), 'replicated');
  storage = await fixture.restart(); assert.equal((await storage.topology()).mode, 'raid1'); assert.equal(await read(storage), 'replicated');
});

test('RAID10 distributes objects across mirror pairs, RAID0 stores one copy', async t => {
  const { storage } = await setup(t, { cacheBytes: 0 }); const peers = await Promise.all([remote(t), remote(t), remote(t)]);
  const nodes = [{ id: 'local', url: 'local' }, ...peers.map((peer, i) => ({ id: `node-${i}`, url: peer.url, token: peer.token }))];
  await storage.configure({ mode: 'raid10', nodes }); await storage.createBucket('test-bucket');
  for (let i = 0; i < 12; i++) await storage.putObject('test-bucket', `key-${i}`, body(`value-${i}`));
  const rows = storage.db.prepare('SELECT replicas FROM objects').all(); assert.equal(rows.every(row => JSON.parse(row.replicas).length === 2), true); assert.equal(new Set(rows.map(row => row.replicas)).size, 2);
  await storage.configure({ mode: 'raid0', nodes, migrate: true }); assert.equal(storage.db.prepare('SELECT replicas FROM objects').all().every(row => JSON.parse(row.replicas).length === 1), true);
  for (let i = 0; i < 12; i++) assert.equal(await read(storage, `key-${i}`), `value-${i}`);
  storage.db.prepare('UPDATE garbage SET retired_at=0').run(); const garbage = await storage.garbageCollect(); assert.equal(garbage.failed, 0);
  for (let i = 0; i < 12; i++) assert.equal(await read(storage, `key-${i}`), `value-${i}`);
});


test('disabled cache does not accumulate empty objects; cache entries have a hard bound', async t => {
  const { storage } = await setup(t, { cacheBytes: 0 }); await storage.createBucket('test-bucket');
  await storage.putObject('test-bucket', 'empty', body('')); assert.equal(await read(storage, 'empty'), ''); assert.equal((await storage.status()).cache.entries, 0);
  await storage.updateSettings({ cacheBytes: 1 });
  for (let i = 0; i < 4100; i++) storage._remember('test-bucket', `empty-${i}`, { blob_id: String(i) }, Buffer.alloc(0));
  assert.equal(storage.cache.size, 4096);
  await storage.updateSettings({ cacheBytes: 0 }); assert.equal(storage.cache.size, 0);
});

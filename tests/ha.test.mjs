import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HaCoordinator, HaUnavailable } from '../src/ha.mjs';
import { prepareHaSecrets } from '../src/ha-secrets.mjs';
import { cluster, proxy, until } from './ha-support.mjs';

function coordinator(etcd, nodeId, role, clusterId, encryptionKey, extra = {}) {
  const local = { value: { catalog: { objects: [], multipart: [] }, auth: { users: ['admin'] }, shares: [] } };
  const ha = new HaCoordinator({ endpoints: etcd.endpoints, nodeId, role, clusterId, encryptionKey,
    leaseTTL: 3, pollMs: 100, timeoutMs: 250,
    exportState: () => structuredClone(local.value), importState: state => { local.value = structuredClone(state); }, ...extra });
  return { ha, local };
}

test('HA snapshots encrypt metadata and enforce size/authentication limits', () => {
  const key = randomBytes(32), fake = {};
  const a = coordinator(fake, 'master', 'master', 'unit', key, { client: {} });
  const state = { passwordHash: 'private metadata', parts: [{ uploadId: 'durable' }] };
  const encoded = a.ha._encode(state);
  assert.equal(encoded.value.includes(Buffer.from('private metadata')), false);
  assert.deepEqual(a.ha._decode(encoded.value).state, state);
  const altered = Buffer.from(encoded.value); altered[altered.length - 1] ^= 1;
  assert.throws(() => a.ha._decode(altered), HaUnavailable);
  const wrong = coordinator(fake, 'slave', 'slave', 'unit', randomBytes(32), { client: {} });
  assert.throws(() => wrong.ha._decode(encoded.value), HaUnavailable);
  const small = coordinator(fake, 'limit', 'master', 'unit', key, { client: {}, snapshotBytes: 1024 });
  assert.throws(() => small.ha._encode({ data: randomBytes(2000).toString('hex') }), /лимит/);
});

test('preferred HA role persists only in node-local configuration', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-ha-role-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32), first = coordinator({}, 'node', 'master', 'roles', key, { client: {}, dataDir });
  await first.ha.setRole('slave');
  const second = coordinator({}, 'node', 'master', 'roles', key, { client: {}, dataDir });
  assert.equal(second.ha.status().configuredRole, 'slave');
  assert.equal(second.ha.status().isLeader, false);
  await assert.rejects(second.ha.setRole('active-active'), /master/);
});

test('shared HA secrets bootstrap once and never replace an installed master key', async t => {
  const dir = await mkdtemp(join(tmpdir(), '27g-ha-secrets-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const masterKeyFile = join(dir, 'shared-key'), setupTokenFile = join(dir, 'shared-setup'), dataDir = join(dir, 'data');
  const key = randomBytes(32), token = 'ha-test-only-setup-secret-with-enough-length';
  await writeFile(masterKeyFile, key); await writeFile(setupTokenFile, token);
  await prepareHaSecrets({ dataDir, masterKeyFile, setupTokenFile });
  assert.deepEqual(await readFile(join(dataDir, 'master.key')), key);
  assert.equal((await stat(join(dataDir, 'master.key'))).mode & 0o777, 0o600);
  await prepareHaSecrets({ dataDir, masterKeyFile, setupTokenFile });
  await writeFile(masterKeyFile, randomBytes(32));
  await assert.rejects(prepareHaSecrets({ dataDir, masterKeyFile, setupTokenFile }), /differs/);
  assert.deepEqual(await readFile(join(dataDir, 'master.key')), key);
  assert.equal(await readFile(join(dataDir, 'setup.token'), 'utf8'), token);
});

const binary = process.env.ETCD_BINARY;
test('HA with three real etcd voters: failover, partitions, rollback and recovery', { skip: !binary, timeout: 90000 }, async t => {
  await access(binary);
  const etcd = await cluster(binary); t.after(() => etcd.close());
  await t.test('slave loads catalog/auth/share/multipart metadata after master crash', async t => {
    const key = randomBytes(32), a = coordinator(etcd, 'node-a', 'master', 'crash', key), b = coordinator(etcd, 'node-b', 'slave', 'crash', key);
    t.after(async () => { await a.ha.close(); await b.ha.close(); });
    await a.ha.start(); await b.ha.start(); assert.equal(a.ha.isLeader, true); assert.equal(b.ha.isLeader, false);
    await a.ha.run({ write: true }, () => {
      a.local.value.catalog.objects.push({ key: 'photo.jpg', blob: 'replicated-blob' });
      a.local.value.catalog.multipart.push({ uploadId: 'u1', parts: [1, 2] });
      a.local.value.auth.users.push('operator'); a.local.value.shares.push('hashed-link');
    });
    const confirmed = structuredClone(a.local.value);
    // Crash: no graceful revoke; leadership must wait for server-side lease expiry.
    a.ha.closed = true; clearInterval(a.ha.timer); clearInterval(a.ha.renewTimer);
    await until(() => b.ha.isLeader);
    assert.deepEqual(b.local.value, confirmed);
    await b.ha.run({ write: true }, () => b.local.value.catalog.objects.push({ key: 'new-after-failover' }));
    await assert.rejects(a.ha.run({ write: true }, () => { throw new Error('must not execute'); }), HaUnavailable);
  });
  await t.test('partitioned old master cannot acknowledge an in-flight write after promotion', async t => {
    const proxies = await Promise.all(etcd.endpoints.map(proxy));
    const key = randomBytes(32), a = coordinator(etcd, 'old-master', 'master', 'partition', key, { endpoints: proxies.map(p => p.endpoint) });
    const b = coordinator(etcd, 'new-master', 'slave', 'partition', key);
    t.after(async () => { await a.ha.close(); await b.ha.close(); await Promise.all(proxies.map(p => p.close())); });
    await a.ha.start(); await b.ha.start();
    let release; const pending = new Promise(resolve => { release = resolve; });
    let entered = false;
    const stale = a.ha.run({ write: true }, async () => { entered = true; await pending; a.local.value.catalog.objects.push({ key: 'stale' }); });
    // Attach rejection handling before creating the partition.
    const rejected = assert.rejects(stale, HaUnavailable);
    await until(() => entered); for (const p of proxies) p.blocked = true;
    await until(() => b.ha.isLeader);
    await b.ha.run({ write: true }, () => b.local.value.catalog.objects.push({ key: 'confirmed-on-new-master' }));
    for (const p of proxies) p.blocked = false; release(); await rejected;
    await until(() => a.local.value.catalog.objects.some(item => item.key === 'confirmed-on-new-master'));
    assert.equal(a.local.value.catalog.objects.some(item => item.key === 'stale'), false);
    assert.equal(a.ha.isLeader, false);
  });
  await t.test('loss of two voters rejects commit and restores speculative local metadata', async t => {
    const a = coordinator(etcd, 'quorum-master', 'master', 'quorum', randomBytes(32));
    t.after(() => a.ha.close()); await a.ha.start();
    await a.ha.run({ write: true }, () => a.local.value.catalog.objects.push({ key: 'durable' }));
    await assert.rejects(a.ha.run({ write: true }, async () => {
      a.local.value.catalog.objects.push({ key: 'unconfirmed' });
      await etcd.stop(etcd.members[1]); await etcd.stop(etcd.members[2]);
    }), HaUnavailable);
    assert.deepEqual(a.local.value.catalog.objects, [{ key: 'durable' }]);
    assert.equal(a.ha.isLeader, false);
    await assert.rejects(a.ha.run({ write: false }, () => 'stale read'), HaUnavailable);
    await etcd.start(etcd.members[1]); await etcd.start(etcd.members[2]);
    await until(() => a.ha.isLeader);
    const [snapshot] = await etcd.client.read([a.ha.stateKey]);
    assert.deepEqual(a.local.value, a.ha._decode(snapshot.value).state);
    await a.ha.run({ write: true }, () => a.local.value.catalog.objects.push({ key: 'after-recovery' }));
  });
  await t.test('application validation errors preserve leader and commit their audit record', async t => {
    const a = coordinator(etcd, 'validation-master', 'master', 'validation', randomBytes(32));
    t.after(() => a.ha.close()); await a.ha.start();
    await assert.rejects(a.ha.run({ write: true }, () => { a.local.value.audit = ['login.failed']; throw new Error('bad password'); }), /bad password/);
    assert.equal(a.ha.isLeader, true); assert.deepEqual(a.ha.committed.state.audit, ['login.failed']);
  });
  await t.test('a previously joined coordinator never bootstraps from stale SQLite after etcd state loss', async t => {
    const dataDir = await mkdtemp(join(tmpdir(), '27g-ha-recovery-')), key = randomBytes(32);
    const a = coordinator(etcd, 'old-master', 'master', 'recovery', key, { dataDir });
    t.after(() => rm(dataDir, { recursive: true, force: true })); await a.ha.start(); await a.ha.close();
    await etcd.client.request('/v3/kv/deleterange', { key: Buffer.from(a.ha.stateKey).toString('base64') });
    const b = coordinator(etcd, 'old-master', 'master', 'recovery', key, { dataDir, exportState: () => { throw new Error('Must never export stale SQLite'); } });
    t.after(() => b.ha.close()); await b.ha.start();
    assert.equal(b.ha.isLeader, false); assert.match(b.ha.status().error, /Восстановите etcd/);
    const [snapshot] = await etcd.client.read([b.ha.stateKey]); assert.equal(snapshot, null);
  });
});

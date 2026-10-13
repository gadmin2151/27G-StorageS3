import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { HaCoordinator } from '../src/ha.mjs';
import { cluster, until, delay } from './ha-support.mjs';

test('HA initial migration belongs to the first fenced cluster state', { skip: !process.env.ETCD_BINARY, timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), '27g-ha-init-'));
  const etcd = await cluster(process.env.ETCD_BINARY), key = randomBytes(32), apps = [];
  t.after(async () => {
    await Promise.all(apps.map(app => app.close()));
    await etcd.close(); await rm(dir, { recursive: true, force: true });
  });
  async function app(nodeId, role, clusterId, initEnv) {
    const dataDir = join(dir, nodeId);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'master.key'), key, { mode: 0o600 });
    const instance = await createApp({ dataDir, initEnv,
      setupToken: 'test-ha-initial-migration-setup-token',
      ha: { endpoints: etcd.endpoints, nodeId, role, clusterId, leaseTTL: 3, pollMs: 100, timeoutMs: 300 },
    });
    apps.push(instance); return instance;
  }
  await t.test('empty slave never creates identities; master initializes once and takeover retains them', async () => {
    const slave = await app('slave', 'slave', 'first-init', { INIT_CONFIG_FILE: '/missing/slave-init-secret.json' });
    assert.equal(slave.auth.listUsers().length, 0);
    assert.equal(slave.ha.isLeader, false);
    const env = { INIT_ENABLED: 'true', INIT_ADMIN_USERNAME: 'owner', INIT_ADMIN_PASSWORD: 'only-test-owner-password',
      INIT_BUCKET: 'app-files', INIT_BUCKET_ACCESS: 'public-read', INIT_BUCKET_READ_PREFIXES: '["images/"]',
      INIT_BUCKET_QUOTA_BYTES: '4096', INIT_S3_ACCESS_KEY: 'G27TESTINITIALACCESS', INIT_S3_SECRET_KEY: 'only-test-s3-secret-at-least-32-bytes',
    };
    const master = await app('master', 'master', 'first-init', env);
    assert.equal(master.ha.isLeader, true);
    const before = master.auth.exportState();
    await until(() => slave.auth.listUsers().length === 1);
    assert.equal(slave.auth.listUsers()[0].username, 'owner');
    assert.deepEqual(slave.auth.exportState(), before);
    assert.equal((await slave.storage.buckets())[0].quotaBytes, 4096);
    assert.equal(await slave.bucketPolicies.allowsAnonymousRead('app-files', 'images/pic.png'), true);
    assert.equal(await slave.bucketPolicies.allowsAnonymousRead('app-files', 'private/pic.png'), false);
    await assert.rejects(access(join(dir, 'slave', 'init-credentials.json')), { code: 'ENOENT' });
    const credentials = await readFile(join(dir, 'master', 'init-credentials.json'));
    apps.splice(apps.indexOf(master), 1); await master.close();
    await until(() => slave.ha.isLeader);
    assert.deepEqual(slave.auth.exportState(), before);
    assert.equal(slave.auth.lookupKey(env.INIT_S3_ACCESS_KEY).secretKey, env.INIT_S3_SECRET_KEY);
    const restarted = await app('master', 'master', 'first-init', { INIT_CONFIG_FILE: '/missing/master-init-secret.json' });
    assert.equal(restarted.ha.isLeader, false);
    assert.deepEqual(restarted.auth.exportState(), before);
    assert.deepEqual(await readFile(join(dir, 'master', 'init-credentials.json')), credentials);
  });
  await t.test('invalid master inputs fail startup instead of publishing defaults; corrected startup can retry', async () => {
    await assert.rejects(app('bad-master', 'master', 'invalid-init', { INIT_ENABLED: 'true', INIT_ADMIN_PASSWORD: 'short' }));
    const [state] = await etcd.client.read(['/27g/invalid-init/state']);
    assert.equal(state, null);
    const corrected = await app('bad-master', 'master', 'invalid-init', { INIT_ENABLED: 'true', INIT_ADMIN_PASSWORD: 'corrected-test-password' });
    assert.equal(corrected.ha.isLeader, true);
    assert.equal(corrected.auth.defaultCredentials, false);
    assert.equal((await corrected.auth.login({ username: 'admin', password: 'corrected-test-password' }, 'test')).user, 'admin');
  });
  await t.test('an expired initialization lease cannot publish its local state', async () => {
    let initialized = false;
    const ha = new HaCoordinator({ endpoints: etcd.endpoints, nodeId: 'slow', role: 'master', clusterId: 'slow-init', encryptionKey: key,
      leaseTTL: 3, pollMs: 100, timeoutMs: 300,
      initializeState: async () => { initialized = true; await delay(4500); },
      exportState: () => ({ initialized }), importState: () => {},
    });
    try {
      await ha.start();
      assert.equal(initialized, true);
      assert.equal(ha.isLeader, false);
      const [state] = await etcd.client.read([ha.stateKey]);
      assert.equal(state, null);
    } finally { await ha.close(); }
  });
});

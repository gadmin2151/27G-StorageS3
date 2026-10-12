import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createNodeServer } from '../src/node.mjs';
import { HaCoordinator } from '../src/ha.mjs';
import { cluster, until } from './ha-support.mjs';

const setupToken = 'ha-test-setup-token-never-production';
const digest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
function signature(endpoint, method, path, key, body = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = digest(body), host = new URL(endpoint).host, [pathname, query = ''] = path.split('?');
  const canonicalQuery = [...new URLSearchParams(query)].sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${encodeURIComponent(a)}=${encodeURIComponent(b)}`).join('&');
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `${method}\n${pathname}\n${canonicalQuery}\nhost:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n\n${names}\n${hash}`;
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretKey}`, date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  const sig = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).toString('hex');
  return { 'x-amz-date': date, 'x-amz-content-sha256': hash, authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${sig}` };
}
async function application(options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./ha-app-worker.mjs', import.meta.url))], {
    env: { ...process.env, HA_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const pending = new Map(), events = new Map(); let output = '';
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-12000); });
  child.on('message', message => {
    if (message.id && pending.has(message.id)) { const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message); }
    if (message.event) { const event = events.get(message.event); if (event?.resolve) { events.delete(message.event); event.resolve(message); } else events.set(message.event, message); }
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Application exited: ${output}`));
    for (const waiter of events.values()) waiter.reject?.(new Error(`Application exited: ${output}`));
  });
  const event = name => {
    const found = events.get(name); if (found?.event) { events.delete(name); return Promise.resolve(found); }
    return new Promise((resolve, reject) => events.set(name, { resolve, reject }));
  };
  const command = command => new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); child.send({ id, command }); });
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  };
  const ready = await event('ready');
  return { endpoint: ready.endpoint, child, event, command, kill };
}
async function storageNode(dataDir, id, token) {
  const server = await createNodeServer({ dataDir, token, filesystemNamespace: id });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { node: { id, url: `http://127.0.0.1:${server.address().port}`, token },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
function web(endpoint) {
  let cookie, csrf;
  const api = (path, method = 'GET', value, headers = {}) => fetch(`${endpoint}/api${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000),
  });
  return { api, async login(username = 'admin', password = 'admin!123') {
    const response = await api('/login', 'POST', { username, password, setupToken });
    assert.equal(response.status, 200, await response.clone().text());
    cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf;
  } };
}
async function json(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function ready(app) { try { const response = await fetch(`${app.endpoint}/ha/ready`, { signal: AbortSignal.timeout(1000) }); await response.text(); return response.status === 200; } catch { return false; } }

test('real application HA: SIGKILL failover preserves S3 versions, identities, links and multipart; quorum gates HTTP acknowledgements', { skip: !process.env.ETCD_BINARY, timeout: 90000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), '27g-ha-app-'));
  const etcd = await cluster(process.env.ETCD_BINARY), nodes = [], apps = [];
  t.after(async () => { await Promise.all(apps.map(app => app.kill())); await Promise.all(nodes.map(node => node.close())); await etcd.close(); await rm(dir, { recursive: true, force: true }); });
  const masterKey = randomBytes(32), token = randomBytes(32).toString('hex');
  for (const id of ['disk-a', 'disk-b']) nodes.push(await storageNode(join(dir, id), id, token));
  for (const [nodeId, role] of [['master', 'master'], ['slave', 'slave']]) {
    const dataDir = join(dir, nodeId); await mkdir(dataDir); await writeFile(join(dataDir, 'master.key'), masterKey, { mode: 0o600 });
    apps.push(await application({ dataDir, setupToken, publicOrigin: '', trustedProxyIPs: '', cacheBytes: 0,
      ha: { endpoints: etcd.endpoints, nodeId, role, clusterId: 'application', leaseTTL: 3, pollMs: 100, timeoutMs: 300 } }));
  }
  const [master, slave] = apps;
  let browser = web(master.endpoint), endpoint = master.endpoint, key, oldVersion, uploadId, partETag, sharePath;
  const s3 = (path, method = 'GET', body = '', headers = {}) => fetch(endpoint + path, { method, headers: { ...signature(endpoint, method, path, key, body), ...headers }, ...(['GET', 'HEAD'].includes(method) ? {} : { body }), signal: AbortSignal.timeout(15000) });
  await t.test('master confirms replicated metadata and two immutable blob copies', async () => {
    await browser.login();
    await json(await browser.api('/settings', 'PUT', { cacheBytes: 0, concurrency: 2, scrubIntervalSeconds: 0 }));
    await json(await browser.api('/topology', 'PUT', { mode: 'raid1', nodes: nodes.map(node => node.node), migrate: true }));
    await json(await browser.api('/buckets', 'POST', { name: 'photos' }), 201);
    await json(await browser.api('/users', 'POST', { username: 'operator', password: 'operator-password-test', role: 'operator', quotaBytes: 10000000, quotaObjects: 20 }), 201);
    key = await json(await browser.api('/keys', 'POST', { label: 'HA integration', role: 'readwrite', buckets: ['photos'], owner: 'operator' }), 201);
    let response = await s3('/photos/photo.png', 'PUT', 'first-photo', { 'content-type': 'image/png' });
    assert.equal(response.status, 200, await response.text()); oldVersion = response.headers.get('x-amz-version-id'); assert.ok(oldVersion);
    response = await s3('/photos/photo.png', 'PUT', 'current-photo', { 'content-type': 'image/png' }); assert.equal(response.status, 200, await response.text());
    const share = await json(await browser.api('/shares', 'POST', { bucket: 'photos', key: 'photo.png', expiresIn: 3600 }), 201); sharePath = new URL(share.url).pathname;
    response = await s3('/photos/resumed.bin?uploads', 'POST'); assert.equal(response.status, 200); uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())[1];
    response = await s3(`/photos/resumed.bin?partNumber=1&uploadId=${uploadId}`, 'PUT', 'persisted multipart part'); assert.equal(response.status, 200, await response.text()); partETag = response.headers.get('etag');
    const standby = await fetch(`${slave.endpoint}/api/status`); assert.equal(standby.status, 503); await standby.text();
  });
  await t.test('actual master process crash promotes slave; sessions require login and persisted operations resume', async () => {
    await master.kill(); await until(() => ready(slave)); endpoint = slave.endpoint; browser = web(endpoint);
    const session = await json(await browser.api('/session')); assert.equal(session.authenticated, false);
    await browser.login();
    const users = await json(await browser.api('/users')); assert.ok(users.users.some(user => user.username === 'operator'));
    const settings = await json(await browser.api('/settings')); assert.equal(settings.scrubIntervalSeconds, 0);
    let response = await s3('/photos/photo.png'); assert.equal(response.status, 200); assert.equal(await response.text(), 'current-photo');
    response = await s3(`/photos/photo.png?versionId=${oldVersion}`); assert.equal(response.status, 200); assert.equal(await response.text(), 'first-photo');
    const versions = await json(await browser.api('/versions?bucket=photos&key=photo.png')); assert.equal(versions.versions.length, 2);
    response = await fetch(endpoint + sharePath); assert.equal(response.status, 200); assert.equal(await response.text(), 'current-photo'); assert.equal(response.headers.get('content-type'), 'image/png');
    response = await s3(`/photos/resumed.bin?uploadId=${uploadId}`); assert.equal(response.status, 200); assert.match(await response.text(), /<PartNumber>1<\/PartNumber>/);
    const completion = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${partETag}</ETag></Part></CompleteMultipartUpload>`;
    response = await s3(`/photos/resumed.bin?uploadId=${uploadId}`, 'POST', completion); assert.equal(response.status, 200, await response.text());
    response = await s3('/photos/resumed.bin'); assert.equal(response.status, 200); assert.equal(await response.text(), 'persisted multipart part');
    const operator = web(endpoint); await operator.login('operator', 'operator-password-test');
  });
  await t.test('quorum lost after successful login work cannot release its Set-Cookie', async () => {
    await slave.command('armCommitBarrier');
    const barrier = slave.event('commitBarrier');
    const pending = fetch(endpoint + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin!123', setupToken }), signal: AbortSignal.timeout(15000) });
    await barrier; await etcd.stop(etcd.members[1]); await etcd.stop(etcd.members[2]); await slave.command('releaseCommit');
    const response = await pending; assert.equal(response.status, 503, await response.text()); assert.equal(response.headers.get('set-cookie'), null);
    const blocked = await browser.api('/status'); assert.equal(blocked.status, 503); await blocked.text();
    await etcd.start(etcd.members[1]); await etcd.start(etcd.members[2]); await until(() => ready(slave));
    await browser.login();
  });
  await t.test('HTTP 503 restores local projection; recovery follows the authoritative quorum outcome', async () => {
    await slave.command('armCommitBarrier'); const barrier = slave.event('commitBarrier');
    const pending = browser.api('/users', 'POST', { username: 'unconfirmed', password: 'unconfirmed-password-test', role: 'viewer' });
    await barrier; await etcd.stop(etcd.members[1]); await etcd.stop(etcd.members[2]); await slave.command('releaseCommit');
    const response = await pending; assert.equal(response.status, 503, await response.text());
    const projection = (await slave.command('inspectProjection')).result;
    assert.equal(projection.users.includes('unconfirmed'), false); assert.equal(projection.ha.isLeader, false);
    await etcd.start(etcd.members[1]); await etcd.start(etcd.members[2]); await until(() => ready(slave)); await browser.login();
    // A timed-out proposal can be committed when quorum returns. The response
    // cannot promise absence; restored SQLite MUST follow that authoritative result.
    const users = await json(await browser.api('/users'));
    const decoder = new HaCoordinator({ nodeId: 'inspector', clusterId: 'application', encryptionKey: masterKey, client: {}, exportState: () => ({}), importState: () => {} });
    const [snapshot] = await etcd.client.read(['/27g/application/state']);
    const authoritative = decoder._decode(snapshot.value).state.auth.users.map(user => user.username).sort();
    assert.deepEqual(users.users.map(user => user.username).sort(), authoritative);
    const valid = await s3('/photos/photo.png'); assert.equal(valid.status, 200); assert.equal(await valid.text(), 'current-photo');
  });
  await t.test('one missing storage host preserves reads but strictly mirrored writes are refused', async () => {
    await nodes[0].close();
    let response = await s3('/photos/photo.png'); assert.equal(response.status, 200); assert.equal(await response.text(), 'current-photo');
    response = await s3('/photos/unmirrored.bin', 'PUT', 'must not acknowledge'); assert.equal(response.status, 503, await response.text());
    response = await s3('/photos/unmirrored.bin'); assert.equal(response.status, 404); await response.text();
  });
});

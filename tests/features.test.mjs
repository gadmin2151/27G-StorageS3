import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { normalizePublicOrigin, normalizeCorsOrigins } from '../src/service-settings.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-features-'));
  let app, endpoint, cookie, csrf;
  async function start() { app = await createApp({ dataDir }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); endpoint = `http://127.0.0.1:${app.server.address().port}`; }
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, method = 'GET', body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(endpoint + path, { method, headers: { ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, headers: r.headers, data, text };
  };
  async function login(username = 'admin', password = 'admin!123') { const r = await call('/api/login', 'POST', { username, password, setupToken: app.auth.setupToken }); assert.equal(r.status, 200, r.text); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = r.data.csrf; return r; }
  await start(); await login();
  return { call, login, get endpoint() { return endpoint; }, get app() { return app; }, async restart() { await app.close(); app = null; await start(); await login(); } };
}

test('public domain persists and controls generated URLs; S3 CORS does not open admin routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/buckets', 'POST', { name: 'domain-test' })).status, 201);
  assert.equal((await f.call('/api/object?bucket=domain-test&key=photo', 'PUT', Buffer.from('photo'))).status, 200);
  let r = await f.call('/api/settings', 'PUT', { publicOrigin: 'https://storage.example.com/', corsOrigins: ['https://website.example.com'] }); assert.equal(r.status, 200, r.text);
  r = await f.call('/api/shares', 'POST', { bucket: 'domain-test', key: 'photo', expiresIn: 3600 }); assert.equal(r.status, 201, r.text); assert.equal(new URL(r.data.url).origin, 'https://storage.example.com');
  assert.equal((await f.call('/api/status')).data.endpoint, 'https://storage.example.com');
  r = await f.call('/domain-test/photo', 'OPTIONS', undefined, { origin: 'https://website.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,x-amz-date,content-type' }); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://website.example.com');
  r = await f.call('/domain-test/photo', 'OPTIONS', undefined, { origin: 'https://website.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,amz-sdk-invocation-id,amz-sdk-request,x-amz-date' }); assert.equal(r.status, 204); assert.match(r.headers.get('access-control-allow-headers'), /amz-sdk-request/);
  assert.equal((await f.call('/domain-test/photo', 'OPTIONS', undefined, { origin: 'https://website.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-csrf-token' })).status, 403);
  assert.equal((await f.call('/domain-test/photo', 'OPTIONS', undefined, { origin: 'https://wrong.example.com', 'access-control-request-method': 'PUT' })).status, 403);
  r = await f.call('/domain-test/photo', 'GET', undefined, { origin: 'https://website.example.com' }); assert.equal(r.status, 403, 'CORS does not bypass SigV4');
  r = await f.call('/api/buckets', 'POST', { name: 'forbidden-test' }, { origin: 'https://website.example.com' }); assert.equal(r.status, 403, 'CORS website cannot mutate administrative API');
  await f.restart(); r = await f.call('/api/settings'); assert.equal(r.data.publicOrigin, 'https://storage.example.com'); assert.deepEqual(r.data.corsOrigins, ['https://website.example.com']);
  assert.equal(normalizePublicOrigin('s3.example.com'), 'https://s3.example.com');
  for (const value of ['https://u:p@example.com', 'https://example.com/path', 'javascript:alert(1)', 'https://example.com?secret=yes']) assert.throws(() => normalizePublicOrigin(value));
  assert.throws(() => normalizeCorsOrigins(['*']));
});

test('web multipart survives restart, exposes versions and trash, and quota blocks excess bytes', async t => {
  const f = await fixture(t), bucket = 'feature-files', key = 'example.txt', suffix = `?bucket=${bucket}&key=${key}`;
  assert.equal((await f.call('/api/buckets', 'POST', { name: bucket })).status, 201);
  let r = await f.call('/api/uploads', 'POST', { bucket, key, contentType: 'text/plain' }); assert.equal(r.status, 201, r.text); const id = r.data.uploadId;
  r = await f.call(`/api/uploads/${id}/parts/1${suffix}`, 'PUT', Buffer.from('resumable data')); assert.equal(r.status, 200, r.text); const part = r.data;
  await f.restart();
  r = await f.call(`/api/uploads/${id}${suffix}`); assert.equal(r.data.parts.length, 1); assert.equal(r.data.parts[0].etag, part.etag);
  r = await f.call(`/api/uploads/${id}/complete${suffix}`, 'POST', { parts: [{ partNumber: 1, etag: part.etag }] }); assert.equal(r.status, 200, r.text);
  assert.equal((await f.call('/api/object' + suffix)).text, 'resumable data');
  for (let i = 0; i < 6; i++) assert.equal((await f.call('/api/object' + suffix, 'PUT', Buffer.from(`version-${i}`))).status, 200);
  r = await f.call('/api/versions' + suffix); assert.equal(r.data.versions.filter(v => !v.isDeleteMarker).length, 5);
  const oldest = r.data.versions.at(-1).versionId;
  assert.equal((await f.call('/api/object' + suffix, 'DELETE')).status, 200);
  r = await f.call(`/api/trash?bucket=${bucket}`); assert.equal(r.data.objects[0].key, key); assert.ok(r.data.objects[0].restoreVersionId);
  assert.equal((await f.call('/api/versions/restore', 'POST', { bucket, key, versionId: oldest })).status, 200);
  assert.equal((await f.call('/api/object' + suffix)).text, 'version-1');
  assert.equal((await f.call(`/api/bucket-quota?bucket=${bucket}`, 'PUT', { maxBytes: 1, maxObjects: null })).status, 200);
  assert.equal((await f.call('/api/object' + suffix, 'PUT', Buffer.from('xx'))).status, 403);
  assert.equal((await f.call('/api/object' + suffix)).text, 'version-1');
  assert.equal((await f.call('/api/trash/purge', 'POST', { bucket, key })).status, 200);
  assert.equal((await f.call('/api/versions' + suffix)).data.versions.length, 0);
});

test('user roles and ownership are enforced by HTTP routes and uploads', async t => {
  const f = await fixture(t), password = 'a-long-test-password';
  for (const [username, role] of [['reader', 'viewer'], ['writer', 'operator']]) assert.equal((await f.call('/api/users', 'POST', { username, password, role, quotaBytes: 10, quotaObjects: 5 })).status, 201);
  assert.equal((await f.call('/api/buckets', 'POST', { name: 'permissions' })).status, 201);
  const created = await f.call('/api/uploads', 'POST', { bucket: 'permissions', key: 'admin-file' }); const id = created.data.uploadId;
  let login = await f.login('reader', password); assert.equal(login.data.role, 'viewer');
  assert.equal((await f.call('/api/users')).status, 403); assert.equal((await f.call('/api/buckets', 'POST', { name: 'reader-bucket' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PUT', { concurrency: 1 })).status, 403);
  assert.equal((await f.call('/api/monitor')).status, 200);
  await f.login('writer', password);
  assert.equal((await f.call(`/api/uploads/${id}?bucket=permissions&key=admin-file`)).status, 404);
  assert.equal((await f.call('/api/object?bucket=permissions&key=writer-file', 'PUT', Buffer.from('12345678901'))).status, 403);
  assert.equal((await f.call('/api/object?bucket=permissions&key=writer-file', 'PUT', Buffer.from('ok'))).status, 200);
  assert.equal((await f.call('/api/disk-agents')).status, 403);
  await f.login(); const r = await f.call('/api/users'); assert.equal(r.data.users.find(u => u.username === 'writer').usage.bytes, 2);
  assert.equal((await f.call('/api/users/writer', 'PUT', { enabled: false })).status, 200);
});

test('monitor exposes measured counters and administrator-controlled thresholds', async t => {
  const f = await fixture(t);
  await f.call('/api/status');
  let r = await f.call('/api/monitor'); assert.ok(r.data.metrics.requests > 0); assert.ok(Array.isArray(r.data.series));
  r = await f.call('/api/monitor/settings', 'PUT', { diskPercent: 75, queuePercent: 70, latencyMs: 1000 }); assert.equal(r.status, 200);
  assert.equal((await f.call('/api/monitor')).data.settings.diskPercent, 75);
  assert.equal((await f.call('/api/scrub', 'POST', {})).status, 200);
  assert.equal(typeof (await f.call('/api/monitor')).data.scrub.at, 'number');
  assert.equal((await f.call('/api/monitor/settings', 'PUT', { diskPercent: 101 })).status, 400);
  r = await f.call('/api/metrics'); assert.equal(r.status, 200); assert.match(r.text, /storeges3_requests_total \d+/);
});

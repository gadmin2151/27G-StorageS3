import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { BucketPolicies, normalizeReadPrefixes } from '../src/bucket-policy.mjs';

function call(endpoint, path, method = 'GET', body, headers = {}) {
  const address = new URL(endpoint);
  return new Promise((resolve, reject) => {
    // Preserve literal dot segments, encoded separators and repeated slashes.
    const req = request({ hostname: address.hostname, port: address.port, method, path, headers, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(body);
  });
}
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
function signed(endpoint, path, method, key, body = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'), host = new URL(endpoint).host;
  const [pathname, query = ''] = path.split('?');
  const canonicalQuery = [...new URLSearchParams(query)].sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${encodeURIComponent(a)}=${encodeURIComponent(b)}`).join('&');
  const names = 'host;x-amz-content-sha256;x-amz-date', digest = hash(body), scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const canonical = `${method}\n${pathname}\n${canonicalQuery}\nhost:${host}\nx-amz-content-sha256:${digest}\nx-amz-date:${date}\n\n${names}\n${digest}`;
  const derived = hmac(hmac(hmac(hmac(`AWS4${key.secretKey}`, date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  const signature = hmac(derived, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
  return { 'x-amz-date': date, 'x-amz-content-sha256': digest, authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}` };
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-bucket-policy-')); let app, endpoint, cookie, csrf;
  const start = async () => {
    app = await createApp({ dataDir, setupToken: 'bucket-policy-test-only-setup-token', publicOrigin: '', trustedProxyIPs: '' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); endpoint = `http://127.0.0.1:${app.server.address().port}`;
  };
  const api = (path, method = 'GET', input, headers = {}) => {
    const raw = Buffer.isBuffer(input), body = input === undefined ? undefined : raw ? input : JSON.stringify(input);
    return call(endpoint, '/api' + path, method, body, { ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }), ...headers });
  };
  const login = async (username = 'admin', password = 'admin!123') => {
    const response = await api('/login', 'POST', { username, password }); assert.equal(response.status, 200, response.text);
    cookie = response.headers['set-cookie'][0].split(';')[0]; csrf = response.json().csrf;
  };
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  await start(); await login();
  return { api, login, get app() { return app; }, get endpoint() { return endpoint; }, call: (...args) => call(endpoint, ...args),
    async restart() { await app.close(); app = null; await start(); await login(); } };
}
async function expectJSON(response, status = 200) { assert.equal(response.status, status, response.text); return response.json(); }
const access = bucket => `/bucket-access?bucket=${encodeURIComponent(bucket)}`;
const object = (bucket, key) => `/object?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`;

test('bucket access defaults private, requires administrator and persists in HA-compatible auth metadata', async t => {
  const f = await fixture(t);
  await expectJSON(await f.api('/buckets', 'POST', { name: 'policy-files' }), 201);
  assert.deepEqual(await expectJSON(await f.api(access('policy-files'))), { bucket: 'policy-files', mode: 'private', readPrefixes: [], anonymousList: false });
  assert.equal((await f.call('/policy-files/known-file')).status, 403);
  assert.equal((await f.api(access('missing-bucket'), 'PUT', { mode: 'public-read' })).status, 404);
  assert.equal((await f.api(access('policy-files'), 'PUT', { mode: 'public-readwrite' })).status, 400);
  assert.equal((await f.api(access('policy-files'), 'PUT', { mode: 'public-read', readPrefixes: ['bad\0prefix'] })).status, 400);
  assert.equal((await f.api(access('policy-files'), 'PUT', { mode: 'public-read' }, { origin: 'https://evil.example' })).status, 403);
  await expectJSON(await f.api(object('policy-files', 'images/photo.png'), 'PUT', Buffer.from('photo')));
  await expectJSON(await f.api(access('policy-files'), 'PUT', { mode: 'public-read', readPrefixes: ['images/'] }));
  const snapshot = f.app.auth.exportState();
  await expectJSON(await f.api(access('policy-files'), 'PUT', { mode: 'private' }));
  assert.equal((await f.call('/policy-files/images/photo.png')).status, 403);
  f.app.auth.importState(snapshot); // The same preferences are restored by HA import.
  assert.equal((await f.call('/policy-files/images/photo.png')).status, 200);
  await f.restart(); assert.equal((await f.call('/policy-files/images/photo.png')).status, 200);
  assert.deepEqual((await expectJSON(await f.api(access('policy-files')))).readPrefixes, ['images/']);
  await expectJSON(await f.api('/users', 'POST', { username: 'operator', password: 'bucket-policy-operator-password', role: 'operator' }), 201);
  await f.login('operator', 'bucket-policy-operator-password');
  assert.equal((await f.api(access('policy-files'))).status, 403);
  assert.equal((await f.api(access('policy-files'), 'PUT', { mode: 'private' })).status, 403);
});

test('open bucket permits exact current-object reads only; lists, history, mutations and bad signatures remain denied', async t => {
  const f = await fixture(t), bucket = 'public-files';
  await expectJSON(await f.api('/buckets', 'POST', { name: bucket }), 201);
  const first = await expectJSON(await f.api(object(bucket, 'photo.svg'), 'PUT', Buffer.from('old content'), { 'content-type': 'image/svg+xml' }));
  await expectJSON(await f.api(object(bucket, 'photo.svg'), 'PUT', Buffer.from('<svg>new content</svg>'), { 'content-type': 'image/svg+xml' }));
  await expectJSON(await f.api(access(bucket), 'PUT', { mode: 'public-read', readPrefixes: [] }));
  let response = await f.call(`/${bucket}/photo.svg`); assert.equal(response.status, 200); assert.equal(response.text, '<svg>new content</svg>');
  assert.equal(response.headers['content-disposition'], 'attachment'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store'); assert.match(response.headers['content-security-policy'], /sandbox; default-src 'none'/);
  const etag = response.headers.etag;
  response = await f.call(`/${bucket}/photo.svg`, 'HEAD'); assert.equal(response.status, 200); assert.equal(response.text, ''); assert.equal(response.headers.etag, etag);
  response = await f.call(`/${bucket}/photo.svg`, 'GET', undefined, { range: 'bytes=0-4' }); assert.equal(response.status, 206); assert.equal(response.text, '<svg>');
  response = await f.call(`/${bucket}/photo.svg`, 'GET', undefined, { 'if-none-match': etag }); assert.equal(response.status, 304);
  for (const path of ['/', `/${bucket}`, `/${bucket}/`, `/${bucket}?list-type=2`, `/${bucket}?versions`, `/${bucket}?uploads`, `/${bucket}?location`, `/${bucket}/photo.svg?versionId=${first.versionId}`, `/${bucket}/photo.svg?uploadId=anything`, `/${bucket}/photo.svg?acl`])
    assert.equal((await f.call(path)).status, 403, path);
  assert.equal((await f.call(`/${bucket}`, 'HEAD')).status, 403);
  for (const method of ['PUT', 'DELETE', 'POST']) assert.equal((await f.call(`/${bucket}/photo.svg`, method)).status, 403);
  assert.equal((await f.call(`/${bucket}/photo.svg`, 'GET', undefined, { authorization: 'Bearer invalid' })).status, 501);
  assert.equal((await f.call(`/${bucket}/photo.svg?X-Amz-Signature=invalid`)).status, 403);
  assert.equal((await f.call(`/${bucket}/photo.svg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20000101T000000Z&X-Amz-Expires=60&X-Amz-Signature=${'0'.repeat(64)}`)).status, 403);
  const key = await expectJSON(await f.api('/keys', 'POST', { label: 'public policy signature checks', role: 'readwrite', buckets: [bucket] }), 201);
  response = await f.call(`/${bucket}/photo.svg`, 'GET', undefined, signed(f.endpoint, `/${bucket}/photo.svg`, 'GET', { ...key, secretKey: 'wrong secret' })); assert.equal(response.status, 403);
  response = await f.call(`/${bucket}?list-type=2`, 'GET', undefined, signed(f.endpoint, `/${bucket}?list-type=2`, 'GET', key)); assert.equal(response.status, 200); assert.match(response.text, /photo.svg/);
  await expectJSON(await f.api(`/keys/${key.id}`, 'DELETE'));
  response = await f.call(`/${bucket}/photo.svg`, 'GET', undefined, signed(f.endpoint, `/${bucket}/photo.svg`, 'GET', key)); assert.equal(response.status, 403);
  assert.equal((await f.call(`/${bucket}/photo.svg`)).status, 200);
});

test('prefix rules are literal, preserve raw S3 keys, and closing a bucket cancels a delayed anonymous read', async t => {
  const f = await fixture(t), bucket = 'prefix-files';
  await expectJSON(await f.api('/buckets', 'POST', { name: bucket }), 201);
  for (const key of ['images/first', 'images/../literal', 'images//double', 'images-other/hidden', 'secret', 'юникод/фото'])
    await expectJSON(await f.api(object(bucket, key), 'PUT', Buffer.from(key)));
  await expectJSON(await f.api(access(bucket), 'PUT', { mode: 'public-read', readPrefixes: ['images/', 'юникод/'] }));
  for (const [path, expected] of [['images/first', 'images/first'], ['images/../literal', 'images/../literal'], ['images//double', 'images//double'], ['images%2Ffirst', 'images/first'], ['%D1%8E%D0%BD%D0%B8%D0%BA%D0%BE%D0%B4/%D1%84%D0%BE%D1%82%D0%BE', 'юникод/фото']]) {
    const response = await f.call(`/${bucket}/${path}`); assert.equal(response.status, 200, path); assert.equal(response.text, expected);
  }
  for (const path of ['images-other/hidden', 'secret']) assert.equal((await f.call(`/${bucket}/${path}`)).status, 403);
  const original = f.app.storage.getObject.bind(f.app.storage); let result, release, entered;
  const barrier = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  f.app.storage.getObject = async (...args) => { result = await original(...args); entered(); await pending; return result; };
  const response = f.call(`/${bucket}/images/first`); await barrier;
  await expectJSON(await f.api(access(bucket), 'PUT', { mode: 'private', readPrefixes: ['images/'] }));
  release(); assert.equal((await response).status, 403); assert.equal(result.stream.destroyed, true);
  assert.equal((await f.call(`/${bucket}/images/first`)).status, 403);
});

test('deleted buckets never inherit an old public policy through web or S3 recreation', async t => {
  const f = await fixture(t), policies = new BucketPolicies({ auth: f.app.auth, storage: f.app.storage });
  const key = await expectJSON(await f.api('/keys', 'POST', { label: 'bucket lifecycle', role: 'readwrite', buckets: [] }), 201);
  for (const viaS3 of [false, true]) {
    const bucket = viaS3 ? 'recreated-s3' : 'recreated-web';
    await expectJSON(await f.api('/buckets', 'POST', { name: bucket }), 201);
    const originalCreatedAt = f.app.storage._bucket(bucket).created_at;
    await expectJSON(await f.api(access(bucket), 'PUT', { mode: 'public-read', readPrefixes: [''] }));
    if (viaS3) { const response = await f.call(`/${bucket}`, 'DELETE', undefined, signed(f.endpoint, `/${bucket}`, 'DELETE', key)); assert.equal(response.status, 204, response.text); }
    else await expectJSON(await f.api(`/buckets/${bucket}`, 'DELETE'));
    await expectJSON(await f.api('/buckets', 'POST', { name: bucket }), 201);
    // Even same-millisecond bucket creation cannot revive the policy: deletion removes it.
    f.app.storage.db.prepare('UPDATE buckets SET created_at=? WHERE name=?').run(originalCreatedAt, bucket);
    assert.equal((await policies.get(bucket)).mode, 'private');
  }
  assert.deepEqual(normalizeReadPrefixes(['images/', 'images/']), ['images/']);
  assert.deepEqual(normalizeReadPrefixes(['images/', '']), []);
  assert.throws(() => normalizeReadPrefixes(['a'.repeat(1025)]));
  assert.throws(() => normalizeReadPrefixes(Array(33).fill('a')));
  await assert.rejects(policies.set('missing-bucket', { mode: 'public-read' }), { status: 404 });
});

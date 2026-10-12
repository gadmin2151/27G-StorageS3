import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.mjs';
import { DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } from '../src/auth.mjs';

const setupToken = 'temporary-share-tests-setup-token';
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Preserve raw request targets for the S3 dot-segment routing regression below.
function httpCall(endpoint, method, path, { headers = {}, body } = {}) {
  const { hostname, port } = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, method, path, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes,
          text: bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function signedHeaders(endpoint, method, path, key, body = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = sha256(body), host = new URL(endpoint).host;
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const [pathname, query = ''] = path.split('?');
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  const parameters = [...new URLSearchParams(query)].map(([key, value]) => [encode(key), encode(value)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
  const canonical = `${method}\n${pathname}\n${parameters}\nhost:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n\n${names}\n${hash}`;
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretKey}`, date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`).toString('hex');
  return { 'x-amz-date': date, 'x-amz-content-sha256': hash,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}` };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-share-'));
  let app, endpoint, cookie, csrf;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function start() {
    app = await createApp({ dataDir, setupToken, ...options });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    endpoint = `http://127.0.0.1:${app.server.address().port}`;
    const login = await httpCall(endpoint, 'POST', '/api/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: DEFAULT_ADMIN_USERNAME, password: DEFAULT_ADMIN_PASSWORD, setupToken }),
    });
    assert.equal(login.status, 200, login.text);
    cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.json().csrf;
  }
  async function api(path, method = 'GET', value, headers = {}) {
    return httpCall(endpoint, method, `/api${path}`, {
      headers: { cookie, 'x-csrf-token': csrf, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  const objectQuery = (bucket, key) => new URLSearchParams({ bucket, key });
  async function upload(key = 'photo.png', bytes = photo, contentType = 'image/png', bucket = 'photos') {
    const result = await httpCall(endpoint, 'PUT', `/api/object?${objectQuery(bucket, key)}`, {
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': contentType }, body: bytes,
    });
    assert.equal(result.status, 200, result.text);
    return result.json();
  }
  async function share(key = 'photo.png', expiresIn = 3600, bucket = 'photos') {
    const result = await api('/shares', 'POST', { bucket, key, expiresIn });
    assert.equal(result.status, 201, result.text);
    const value = result.json();
    assert.ok(value.id); assert.ok(Number.isFinite(Date.parse(value.expiresAt)));
    return { ...value, path: new URL(value.url).pathname };
  }
  await start();
  assert.equal((await api('/buckets', 'POST', { name: 'photos' })).status, 201);
  await upload();
  return { dataDir, api, upload, share, objectQuery,
    get app() { return app; }, get endpoint() { return endpoint; },
    anonymous: (path, method = 'GET', options) => httpCall(endpoint, method, path, options),
    async restart() { await app.close(); app = null; await start(); },
  };
}

test('temporary share management requires a session, CSRF and same-origin mutations; expiry is bounded', async t => {
  const f = await fixture(t);
  for (const [method, path] of [['GET', '/api/shares?bucket=photos&key=photo.png'], ['POST', '/api/shares'], ['DELETE', '/api/shares/unknown']]) {
    const result = await f.anonymous(path, method, { headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(result.status, 401, `${method} ${path}`);
  }
  const input = { bucket: 'photos', key: 'photo.png', expiresIn: 3600 };
  for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': 'wrong' }, { origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.api('/shares', 'POST', input, headers)).status, 403);
  }
  for (const expiresIn of [0, 59, 604801, -1, 1.5, null, 'invalid']) {
    assert.equal((await f.api('/shares', 'POST', { ...input, expiresIn })).status, 400, `expiry ${JSON.stringify(expiresIn)} must be rejected`);
  }
  for (const invalid of [{}, { bucket: 'photos' }, { key: 'photo.png' }, { ...input, key: '' }, { ...input, bucket: [] }]) {
    assert.equal((await f.api('/shares', 'POST', invalid)).status, 400);
  }
  assert.equal((await f.api('/shares', 'POST', { ...input, key: 'absent.png' })).status, 404);
  const before = Date.now();
  const defaultShare = await f.api('/shares', 'POST', { bucket: 'photos', key: 'photo.png' });
  assert.equal(defaultShare.status, 201);
  assert.ok(Date.parse(defaultShare.json().expiresAt) >= before + 3600_000);
  assert.ok(Date.parse(defaultShare.json().expiresAt) <= Date.now() + 3600_000);
  await f.share('photo.png', 60); await f.share('photo.png', 604800);
});

test('anonymous shares expose only their selected object, hide tokens in listings, and can be revoked independently', async t => {
  const f = await fixture(t);
  const first = await f.share(), second = await f.share();
  assert.notEqual(first.path, second.path);
  assert.match(first.path, /^\/share\/[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(first.url).origin, f.endpoint);
  await f.upload('private.png', Buffer.from('unshared contents'));
  let response = await f.anonymous(first.path);
  assert.equal(response.status, 200); assert.deepEqual(response.bytes, photo);
  response = await f.anonymous(`${first.path}?bucket=photos&key=private.png`);
  if (response.status === 200) assert.deepEqual(response.bytes, photo, 'query parameters cannot retarget a share');
  else assert.equal(response.status, 404);
  assert.equal((await f.anonymous('/photos/private.png')).status, 403);
  const listed = await f.api('/shares?bucket=photos&key=photo.png');
  assert.equal(listed.status, 200);
  assert.deepEqual(new Set(listed.json().shares.map(x => x.id)), new Set([first.id, second.id]));
  for (const item of listed.json().shares) {
    assert.ok(item.createdAt); assert.ok(item.expiresAt);
    assert.equal(item.url, undefined); assert.equal(item.token, undefined);
  }
  assert.ok(!listed.text.includes(first.path.split('/').at(-1)));
  const otherList = await f.api('/shares?bucket=photos&key=private.png');
  assert.deepEqual(otherList.json().shares, []);
  const token = first.path.split('/').at(-1);
  const changed = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  assert.equal((await f.anonymous(`/share/${changed}`)).status, 404);
  assert.equal((await f.api(`/shares/${first.id}`, 'DELETE', undefined, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.api(`/shares/${first.id}`, 'DELETE')).status, 200);
  assert.equal((await f.anonymous(first.path)).status, 404);
  assert.equal((await f.anonymous(second.path)).status, 200);
  assert.deepEqual((await f.api('/shares?bucket=photos&key=photo.png')).json().shares.map(x => x.id), [second.id]);
  assert.notEqual((await f.anonymous(second.path, 'PUT', { body: 'replacement' })).status, 200);
  assert.deepEqual((await f.anonymous(second.path)).bytes, photo, 'a share grants no write permission');
});

test('shared raster images are inline; active content is isolated as downloads; HEAD returns safe headers without a body', async t => {
  const f = await fixture(t);
  for (const [extension, contentType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif']]) {
    const key = `inline.${extension}`;
    await f.upload(key, photo, contentType);
    const link = await f.share(key);
    for (const method of ['GET', 'HEAD']) {
      const result = await f.anonymous(link.path, method);
      assert.equal(result.status, 200);
      assert.equal(result.headers['content-type'], contentType);
      assert.match(result.headers['content-disposition'], /^inline(?:;|$)/);
      assert.equal(Number(result.headers['content-length']), photo.length);
      assert.match(result.headers['cache-control'], /no-store/);
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.equal(result.headers['referrer-policy'], 'no-referrer');
      assert.deepEqual(result.bytes, method === 'HEAD' ? Buffer.alloc(0) : photo);
      assert.equal(result.headers['set-cookie'], undefined);
    }
  }
  for (const [key, contentType] of [['page.html', 'text/html'], ['drawing.svg', 'image/svg+xml'], ['document.pdf', 'application/pdf'], ['unknown.bin', 'application/octet-stream']]) {
    await f.upload(key, Buffer.from('<script>alert(1)</script>'), contentType);
    const link = await f.share(key);
    const result = await f.anonymous(link.path);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'application/octet-stream');
    assert.match(result.headers['content-disposition'], /^attachment(?:;|$)/);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.match(result.headers['cache-control'], /no-store/);
  }
});

test('share expiry and revocation persist across restart, with token hashes stored instead of public tokens', async t => {
  const f = await fixture(t);
  const live = await f.share(), expired = await f.share(), revoked = await f.share();
  assert.equal((await f.api(`/shares/${revoked.id}`, 'DELETE')).status, 200);
  const database = new DatabaseSync(join(f.dataDir, 'shares.sqlite'));
  try {
    const token = live.path.split('/').at(-1);
    const row = database.prepare('SELECT * FROM shares WHERE id = ?').get(live.id);
    assert.equal(row.token_hash, sha256(token));
    assert.ok(!JSON.stringify(row).includes(token));
    // Move only this record into the past; no wall-clock sleeps or global mocks.
    database.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
  } finally { database.close(); }
  assert.equal((await f.anonymous(expired.path)).status, 404);
  assert.equal((await f.anonymous(expired.path, 'HEAD')).bytes.length, 0);
  await f.restart();
  assert.deepEqual((await f.anonymous(live.path)).bytes, photo);
  assert.equal((await f.anonymous(expired.path)).status, 404);
  assert.equal((await f.anonymous(revoked.path)).status, 404);
  assert.deepEqual((await f.api('/shares?bucket=photos&key=photo.png')).json().shares.map(x => x.id), [live.id]);
});

test('overwriting or deleting an object invalidates previous shares even when the replacement bytes are identical', async t => {
  const f = await fixture(t);
  for (const replacement of [photo, Buffer.from('a different image')]) {
    await f.upload();
    const old = await f.share();
    await f.upload('photo.png', replacement);
    assert.equal((await f.anonymous(old.path)).status, 404);
    assert.equal((await f.anonymous(old.path, 'HEAD')).status, 404);
    assert.deepEqual((await f.api('/shares?bucket=photos&key=photo.png')).json().shares, []);
    const current = await f.share();
    assert.deepEqual((await f.anonymous(current.path)).bytes, replacement);
  }
  const removed = await f.share();
  assert.equal((await f.api('/object?bucket=photos&key=photo.png', 'DELETE')).status, 200);
  assert.equal((await f.anonymous(removed.path)).status, 404);
  assert.equal((await f.api('/buckets/photos', 'DELETE')).status, 409, 'retained versions keep the bucket nonempty');
  assert.equal((await f.api('/trash/purge', 'POST', { bucket: 'photos', key: 'photo.png' })).status, 200);
  assert.equal((await f.api('/buckets/photos', 'DELETE')).status, 200);
  assert.equal((await f.api('/buckets', 'POST', { name: 'photos' })).status, 201);
  await f.upload();
  assert.equal((await f.anonymous(removed.path)).status, 404, 'recreating the same bucket/key must not revive an old URL');
});

test('S3 promotion of an old version or removal of a delete marker never revives a previous share', async t => {
  const f = await fixture(t);
  const account = f.app.auth.createKey({ label: 'versions-share-test', role: 'readwrite', buckets: [] });
  async function removeVersion(versionId) {
    const path = `/photos/photo.png?versionId=${encodeURIComponent(versionId)}`;
    const response = await f.anonymous(path, 'DELETE', { headers: signedHeaders(f.endpoint, 'DELETE', path, account) });
    assert.equal(response.status, 204, response.text);
  }
  const original = await f.share(), firstGeneration = f.app.storage.objectGeneration('photos', 'photo.png');
  const newer = await f.upload('photo.png', Buffer.from('newer'));
  const replaced = await f.share();
  await removeVersion(newer.versionId);
  assert.deepEqual((await f.api('/object?bucket=photos&key=photo.png')).bytes, photo);
  assert.notEqual(f.app.storage.objectGeneration('photos', 'photo.png'), firstGeneration);
  for (const old of [original, replaced]) for (const method of ['GET', 'HEAD']) assert.equal((await f.anonymous(old.path, method)).status, 404);
  const promoted = await f.share(), generation = f.app.storage.objectGeneration('photos', 'photo.png');
  await f.api('/object?bucket=photos&key=photo.png', 'DELETE');
  const versions = (await f.api('/versions?bucket=photos&key=photo.png')).json().versions;
  const marker = versions.find(version => version.isDeleteMarker);
  assert.ok(marker);
  await removeVersion(marker.versionId);
  assert.notEqual(f.app.storage.objectGeneration('photos', 'photo.png'), generation);
  assert.equal((await f.anonymous(promoted.path)).status, 404);
  assert.deepEqual((await f.api('/shares?bucket=photos&key=photo.png')).json().shares, []);
  const live = await f.share();
  await f.restart();
  assert.deepEqual((await f.anonymous(live.path)).bytes, photo);
  for (const old of [original, replaced, promoted]) assert.equal((await f.anonymous(old.path)).status, 404);
  // Removing an unrelated historical version leaves the current generation intact.
  const previous = (await f.api('/versions?bucket=photos&key=photo.png')).json().versions[0];
  await f.upload(); const current = await f.share();
  await removeVersion(previous.versionId);
  assert.deepEqual((await f.anonymous(current.path)).bytes, photo);
});

test('upgrading a legacy catalog preserves live shares and invalidates them after a version promotion', async t => {
  const f = await fixture(t), link = await f.share();
  const blob = f.app.storage.db.prepare('SELECT blob_id FROM objects WHERE bucket=? AND key=?').get('photos', 'photo.png').blob_id;
  // Reconstruct the pre-generation schema and its existing share binding.
  f.app.storage.db.exec('ALTER TABLE objects DROP COLUMN generation');
  f.app.shares.db.prepare('UPDATE shares SET blob_id=? WHERE id=?').run(blob, link.id);
  await f.restart();
  assert.equal(f.app.storage.objectGeneration('photos', 'photo.png'), blob);
  assert.deepEqual((await f.anonymous(link.path)).bytes, photo);
  const newer = await f.upload('photo.png', Buffer.from('replacement'));
  await f.app.storage.deleteObject('photos', 'photo.png', { versionId: newer.versionId });
  assert.equal((await f.anonymous(link.path)).status, 404);
  assert.notEqual(f.app.storage.objectGeneration('photos', 'photo.png'), blob);
});

test('share URLs use the configured public origin and ignore proxy origin spoofing', async t => {
  const f = await fixture(t, { publicOrigin: 'https://images.example.com' });
  const result = await f.api('/shares', 'POST', { bucket: 'photos', key: 'photo.png', expiresIn: 300 }, {
    'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http', host: 'untrusted.example',
  });
  assert.equal(result.status, 201, result.text);
  assert.equal(new URL(result.json().url).origin, 'https://images.example.com');
});

test('a share revoked, expired or replaced while its bytes are loading never starts a response stream', async t => {
  const f = await fixture(t);
  for (const action of ['revoke', 'expire', 'overwrite', 'delete']) {
    await f.upload();
    const link = await f.share();
    const original = f.app.storage.getObject;
    let reached, resume, heldStream;
    const loaded = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    f.app.storage.getObject = async function (...args) {
      const result = await original.apply(this, args);
      heldStream = result.stream;
      reached(); await gate;
      return result;
    };
    const response = f.anonymous(link.path);
    try {
      await Promise.race([loaded, response.then(() => { throw new Error('Response completed before its object was loaded'); })]);
      if (action === 'revoke') assert.equal((await f.api(`/shares/${link.id}`, 'DELETE')).status, 200);
      if (action === 'expire') f.app.shares.db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, link.id);
      if (action === 'overwrite') await f.upload();
      if (action === 'delete') assert.equal((await f.api('/object?bucket=photos&key=photo.png', 'DELETE')).status, 200);
      resume();
      const result = await response;
      assert.equal(result.status, 404, action);
      assert.ok(!result.bytes.equals(photo));
      assert.equal(heldStream.destroyed, true, `${action}: the unconsumed stream must release resources`);
    } finally {
      resume(); f.app.storage.getObject = original;
      await response;
    }
  }
});

test('the active share limit rejects excess links and expired records release capacity', async t => {
  const f = await fixture(t);
  const now = Date.now();
  f.app.shares.db.prepare(`WITH RECURSIVE sequence(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000
    ) INSERT INTO shares SELECT 'filler-' || n, 'filler-hash-' || n, 'photos', 'photo.png', ?, ?, ? FROM sequence`)
    .run(f.app.storage.objectGeneration('photos', 'photo.png'), now, now + 3600_000);
  const rejected = await f.api('/shares', 'POST', { bucket: 'photos', key: 'photo.png', expiresIn: 60 });
  assert.equal(rejected.status, 409);
  f.app.shares.db.prepare('UPDATE shares SET expires_at = ?').run(now - 1);
  const created = await f.share();
  assert.equal((await f.anonymous(created.path)).status, 200);
  assert.equal(f.app.shares.db.prepare('SELECT COUNT(*) AS count FROM shares').get().count, 1);
});

test('share errors do not reveal object paths and invalid share routes cannot access admin endpoints', async t => {
  const f = await fixture(t);
  const link = await f.share();
  assert.equal((await f.api(`/shares/${link.id}`, 'DELETE')).status, 200);
  const revoked = await f.anonymous(link.path);
  const unknown = await f.anonymous(`/share/${'a'.repeat(43)}`);
  assert.equal(revoked.status, 404); assert.equal(unknown.status, 404);
  assert.equal(revoked.text, unknown.text);
  assert.ok(!revoked.text.includes('photos')); assert.ok(!revoked.text.includes('photo.png'));
  assert.match(revoked.headers['cache-control'], /no-store/);
  for (const path of ['/share/', '/share/not-a-token', '/share/../api/session', '/share/%2e%2e/api/session', `${link.path}/extra`]) {
    const result = await f.anonymous(path);
    assert.equal(result.status, 404, path);
    assert.ok(!result.text.includes('authenticated'), 'a malformed share path cannot reach the session API');
  }
});

test('share is reserved for new buckets; legacy buckets and literal S3 paths keep authenticated access', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/buckets', 'POST', { name: 'share' })).status, 400);
  const key = f.app.auth.createKey({ label: 'share-routing-test', role: 'readwrite', buckets: [] });
  const reservedPath = '/sh%61re';
  const reserved = await f.anonymous(reservedPath, 'PUT', { headers: signedHeaders(f.endpoint, 'PUT', reservedPath, key) });
  assert.equal(reserved.status, 400); assert.match(reserved.text, /InvalidBucketName/);
  // Model a catalog created before the share route was introduced.
  f.app.storage.db.prepare('INSERT INTO buckets VALUES (?, ?)').run('share', new Date().toISOString());
  await f.upload('legacy.png', photo, 'image/png', 'share');
  const legacyPath = '/share/legacy.png';
  const legacy = await f.anonymous(legacyPath, 'GET', { headers: signedHeaders(f.endpoint, 'GET', legacyPath, key) });
  assert.equal(legacy.status, 200); assert.deepEqual(legacy.bytes, photo);
  assert.equal(legacy.headers['content-disposition'], 'attachment');
  assert.equal((await f.anonymous(legacyPath)).status, 404);
  const legacyLink = await f.share('legacy.png', 3600, 'share');
  assert.deepEqual((await f.anonymous(legacyLink.path)).bytes, photo);
  const link = await f.share();
  for (const path of [`/photos/..${link.path}`, `/photos/%2e%2e${link.path}`, `/photos/nested/../..${link.path}`]) {
    const payload = `literal object ${path}`;
    const put = await f.anonymous(path, 'PUT', { headers: signedHeaders(f.endpoint, 'PUT', path, key, payload), body: payload });
    assert.equal(put.status, 200, put.text);
    const get = await f.anonymous(path, 'GET', { headers: signedHeaders(f.endpoint, 'GET', path, key) });
    assert.equal(get.status, 200); assert.equal(get.text, payload);
    assert.equal((await f.anonymous(path)).status, 403, 'dot segments must not bypass S3 authentication');
  }
});

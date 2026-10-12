import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../src/server.mjs';
import { DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } from '../src/auth.mjs';

const setupToken = 'test-setup-token-with-32-characters';
const password = 'test-password-long-enough';
const digest = b => createHash('sha256').update(b).digest('hex');
const hmac = (key, b) => createHmac('sha256', key).update(b).digest();
function signature(endpoint, method, path, key, body = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = digest(body), host = new URL(endpoint).host;
  const [pathname, query = ''] = path.split('?');
  const canonicalQuery = [...new URLSearchParams(query)].sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${encodeURIComponent(a)}=${encodeURIComponent(b)}`).join('&');
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `${method}\n${pathname}\n${canonicalQuery}\nhost:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n\n${names}\n${hash}`;
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretKey}`, date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  const sig = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).toString('hex');
  return { 'x-amz-date': date, 'x-amz-content-sha256': hash, authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${sig}` };
}

// http.request preserves the request target, unlike fetch/WHATWG URL which
// normalize dot segments before the request ever reaches the server.
function rawRequest(endpoint, method, path, { headers = {}, body = '' } = {}) {
  const { hostname, port } = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, method, path, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('complete web and S3 workflow: default login, CSRF, permissions, persistence, safe downloads', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-app-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = await createApp({ dataDir, setupToken });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let endpoint = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  async function api(path, method = 'GET', value, headers = {}) {
    return fetch(`${endpoint}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }
  let response = await api('/session'); assert.deepEqual(await response.json(), { authenticated: false, defaultCredentials: true, setupTokenRequired: false });
  response = await api('/status'); assert.equal(response.status, 401);
  response = await api('/login', 'POST', { username: DEFAULT_ADMIN_USERNAME, password: DEFAULT_ADMIN_PASSWORD }); assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf;
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  response = await api('/password', 'PUT', { currentPassword: DEFAULT_ADMIN_PASSWORD, password }); assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
  const changed = await response.json(); csrf = changed.csrf; assert.equal(changed.defaultCredentials, false);
  response = await api('/session'); assert.equal((await response.json()).authenticated, true);
  response = await api('/buckets', 'POST', { name: 'documents' }, { 'x-csrf-token': 'invalid' }); assert.equal(response.status, 403);
  response = await api('/buckets', 'POST', { name: 'documents' }, { origin: 'https://attacker.example' }); assert.equal(response.status, 403);
  response = await api('/buckets', 'POST', { name: 'documents' }); assert.equal(response.status, 201);
  response = await api('/keys', 'POST', { label: 'application', role: 'readwrite', buckets: [] }); assert.equal(response.status, 201);
  const key = await response.json(); assert.ok(key.secretKey);
  response = await api('/keys'); assert.ok(!(await response.text()).includes(key.secretKey));
  const authDB = await readFile(join(dataDir, 'auth.sqlite')); assert.equal(authDB.includes(Buffer.from(key.secretKey)), false);
  const payload = '<svg onload="alert(1)"></svg>';
  response = await fetch(`${endpoint}/documents/test.svg`, { method: 'PUT', headers: { ...signature(endpoint, 'PUT', '/documents/test.svg', key, payload), 'content-type': 'image/svg+xml' }, body: payload });
  assert.equal(response.status, 200, await response.text());
  response = await fetch(`${endpoint}/documents/test.svg`, { headers: signature(endpoint, 'GET', '/documents/test.svg', key) });
  assert.equal(response.status, 200); assert.equal(await response.text(), payload); assert.equal(response.headers.get('content-disposition'), 'attachment');
  response = await fetch(`${endpoint}/documents?list-type=2`, { headers: signature(endpoint, 'GET', '/documents?list-type=2', key) });
  assert.equal(response.status, 200); assert.match(await response.text(), /test.svg/);
  response = await api('/object?bucket=documents&key=test.svg'); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /^attachment/); assert.match(response.headers.get('content-type'), /octet-stream/); await response.arrayBuffer();
  response = await api('/keys', 'POST', { label: 'read only', role: 'readonly', buckets: ['documents'] });
  const ro = await response.json();
  response = await fetch(`${endpoint}/documents/test.svg`, { method: 'DELETE', headers: signature(endpoint, 'DELETE', '/documents/test.svg', ro) }); assert.equal(response.status, 403); await response.text();
  response = await api('/settings', 'PUT', { cacheBytes: 1048576, concurrency: 2 }); assert.equal(response.status, 200);
  response = await api('/topology'); assert.equal((await response.json()).nodes[0].id, 'local');
  response = await api('/scrub', 'POST'); assert.equal(response.status, 200);
  response = await fetch(`${endpoint}/console/`); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await response.text(), /27g-StoregeS3/);
  await assert.rejects(createApp({ dataDir, setupToken }), /already owned/);
  await app.close(); app = null;
  app = await createApp({ dataDir, setupToken }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); endpoint = `http://127.0.0.1:${app.server.address().port}`;
  response = await api('/session'); assert.equal((await response.json()).authenticated, false);
  response = await api('/login', 'POST', { username: 'admin', password }); assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf;
  response = await fetch(`${endpoint}/documents/test.svg`, { headers: signature(endpoint, 'GET', '/documents/test.svg', key) }); assert.equal(await response.text(), payload);
  response = await api('/settings'); assert.equal((await response.json()).cacheBytes, 1048576);
  response = await api(`/keys/${key.id}`, 'DELETE'); assert.equal(response.status, 200);
  response = await fetch(`${endpoint}/documents/test.svg`, { headers: signature(endpoint, 'GET', '/documents/test.svg', key) }); assert.equal(response.status, 403); await response.text();
  response = await api('/password', 'PUT', { currentPassword: password, password: 'new-password-for-admin' }); assert.equal(response.status, 200);
  response = await api('/status'); assert.equal(response.status, 401, 'old session must be revoked after password change');
});

test('login throttling, secure cookie, and initialization never replaces an administrator', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-auth-'));
  const app = await createApp({ dataDir, setupToken, publicOrigin: 'https://storage.example.com' });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const session = await app.auth.login({ username: DEFAULT_ADMIN_USERNAME, password: DEFAULT_ADMIN_PASSWORD, setupToken }, 'test');
  assert.match(app.auth.cookie(session.token), /; Secure$/);
  const original = app.auth.db.prepare('SELECT * FROM users').all();
  await app.auth.initializeDefaults();
  assert.deepEqual(app.auth.db.prepare('SELECT * FROM users').all(), original);
  for (let i = 0; i < 8; i++) await assert.rejects(app.auth.login({ username: 'nobody', password: 'bad' }, 'attacker'), e => e.status === 401);
  await assert.rejects(app.auth.login({ username: 'admin', password }, 'attacker'), e => e.status === 429);
});

test('factory credentials persist until changed; custom password and revoked sessions survive restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-default-password-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = await createApp({ dataDir });
  const persistedToken = app.auth.setupToken;
  assert.ok(persistedToken.length >= 24);
  assert.equal(app.auth.defaultCredentials, true);
  await assert.rejects(app.auth.login({ username: 'admin', password: 'wrong-password' }, 'test'), e => e.status === 401);
  const originalHash = app.auth.db.prepare('SELECT password FROM users WHERE username = ?').get('admin').password;
  assert.notEqual(originalHash, DEFAULT_ADMIN_PASSWORD);
  await app.close(); app = null;

  app = await createApp({ dataDir });
  assert.equal(app.auth.setupToken, persistedToken);
  assert.equal(app.auth.defaultCredentials, true);
  assert.equal(app.auth.db.prepare('SELECT password FROM users WHERE username = ?').get('admin').password, originalHash);
  const session = await app.auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD, setupToken: persistedToken }, 'test');
  const requestSession = { headers: { cookie: `storeges3_session=${session.token}` } };
  await assert.rejects(app.auth.changePassword('admin', { currentPassword: DEFAULT_ADMIN_PASSWORD, password: 'too-short' }, 'test'), e => e.status === 400);
  assert.equal(app.auth.defaultCredentials, true);
  await app.auth.changePassword('admin', { currentPassword: DEFAULT_ADMIN_PASSWORD, password }, 'test');
  assert.equal(app.auth.defaultCredentials, false);
  assert.equal(app.auth.session(requestSession), null, 'changing the password must revoke previous sessions');
  await app.close(); app = null;

  app = await createApp({ dataDir });
  assert.equal(app.auth.defaultCredentials, false);
  await assert.rejects(app.auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD, setupToken: persistedToken }, 'test'), e => e.status === 401);
  assert.equal((await app.auth.login({ username: 'admin', password }, 'test')).user, 'admin');
  assert.equal(app.auth.db.prepare('SELECT count(*) AS count FROM users').get().count, 1);
});

test('factory login requires server token on wildcard listeners, public origins, and configured proxies', async t => {
  for (const scenario of [
    { name: 'wildcard', host: '0.0.0.0', options: {} },
    { name: 'public origin', host: '127.0.0.1', options: { publicOrigin: 'https://storage.example.com' } },
    { name: 'trusted proxy', host: '127.0.0.1', options: { trustedProxyIPs: '127.0.0.1' } },
  ]) await t.test(scenario.name, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-default-guard-'));
    const app = await createApp({ dataDir, setupToken, ...scenario.options });
    t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    app.server.listen(0, scenario.host); await once(app.server, 'listening');
    const endpoint = `http://127.0.0.1:${app.server.address().port}`;
    const state = await rawRequest(endpoint, 'GET', '/api/session');
    assert.deepEqual(JSON.parse(state.body), { authenticated: false, defaultCredentials: true, setupTokenRequired: true });
    assert.ok(!state.body.includes(setupToken));
    const login = (token, headers = {}) => rawRequest(endpoint, 'POST', '/api/login', {
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD, ...(token === undefined ? {} : { setupToken: token }) }),
    });
    assert.equal((await login()).status, 403);
    assert.equal((await login('wrong-token')).status, 403);
    assert.equal((await login(undefined, { 'x-27g-client-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', host: 'localhost' })).status, 403);
    assert.equal((await login(undefined, { 'x-27g-client-ip': 'invalid' })).status, 403);
    const accepted = await login(setupToken);
    assert.equal(accepted.status, 200);
    assert.equal(JSON.parse(accepted.body).defaultCredentials, true);
    assert.ok(!accepted.body.includes(setupToken));
    const cookie = accepted.headers['set-cookie'][0].split(';')[0];
    const status = await rawRequest(endpoint, 'GET', '/api/status', { headers: { cookie } });
    assert.equal(JSON.parse(status.body).security.defaultCredentials, true);
    const setup = await rawRequest(endpoint, 'POST', '/api/setup', {
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': JSON.parse(accepted.body).csrf },
      body: JSON.stringify({ username: 'replacement', password, setupToken }),
    });
    assert.equal(setup.status, 404, 'obsolete setup route must not create a replacement administrator');
    const changed = await rawRequest(endpoint, 'PUT', '/api/password', {
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': JSON.parse(accepted.body).csrf },
      body: JSON.stringify({ currentPassword: DEFAULT_ADMIN_PASSWORD, password }),
    });
    assert.equal(changed.status, 200);
    assert.equal(JSON.parse(changed.body).defaultCredentials, false);
    const updatedState = await rawRequest(endpoint, 'GET', '/api/session');
    assert.deepEqual(JSON.parse(updatedState.body), { authenticated: false, defaultCredentials: false, setupTokenRequired: false });
    const customLogin = await rawRequest(endpoint, 'POST', '/api/login', {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }),
    });
    assert.equal(customLogin.status, 200, 'a custom password must allow remote login without the setup token');
  });
});

test('existing installations without the factory preference retain username, password, and S3 keys', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-existing-admin-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = await createApp({ dataDir, setupToken });
  await app.auth.changePassword('admin', { currentPassword: DEFAULT_ADMIN_PASSWORD, password }, 'test');
  // Model the previous schema: an existing custom administrator has no factory flag.
  app.auth.db.prepare('UPDATE users SET username = ? WHERE username = ?').run('existing-owner', 'admin');
  app.auth.db.prepare('DELETE FROM preferences WHERE key = ?').run('defaultCredentials');
  const stored = app.auth.db.prepare('SELECT * FROM users').all();
  const key = app.auth.createKey({ label: 'existing-application' });
  await app.close(); app = null;
  app = await createApp({ dataDir, setupToken });
  assert.equal(app.auth.defaultCredentials, false);
  assert.deepEqual(app.auth.db.prepare('SELECT * FROM users').all(), stored);
  assert.equal((await app.auth.login({ username: 'existing-owner', password }, 'test')).user, 'existing-owner');
  await assert.rejects(app.auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD, setupToken }, 'test'), e => e.status === 401);
  assert.equal(app.auth.lookupKey(key.accessKey).secretKey, key.secretKey);
});

test('raw S3 dot-segment paths never dispatch to admin, console, or health routes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-raw-path-'));
  const app = await createApp({ dataDir, setupToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  await app.storage.createBucket('documents');
  const key = app.auth.createKey({ label: 'raw-path-test', role: 'readwrite', buckets: ['documents'] });
  for (const path of [
    '/documents/../api/session',
    '/documents/%2e%2e/api/session',
    '/documents/../console/',
    '/documents/../healthz',
    '/documents/nested/../../api/session',
  ]) {
    const payload = `literal S3 object: ${path}`;
    const put = await rawRequest(endpoint, 'PUT', path, { body: payload, headers: signature(endpoint, 'PUT', path, key, payload) });
    assert.equal(put.status, 200, `${path}: ${put.body}`);
    const get = await rawRequest(endpoint, 'GET', path, { headers: signature(endpoint, 'GET', path, key) });
    assert.equal(get.status, 200, `${path}: ${get.body}`);
    assert.equal(get.body, payload);
    assert.equal(get.headers['content-disposition'], 'attachment');
    const anonymous = await rawRequest(endpoint, 'GET', path);
    assert.equal(anonymous.status, 403, `${path} must require S3 authentication`);
    assert.match(anonymous.body, /<Code>AccessDenied<\/Code>/);
  }
  // The real endpoints remain available at their exact route paths.
  assert.equal((await rawRequest(endpoint, 'GET', '/api/session')).status, 200);
  assert.equal((await rawRequest(endpoint, 'GET', '/healthz')).status, 200);
});

test('an empty persisted setup token fails startup without an explicit token override', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-empty-setup-'));
  let app;
  const previousToken = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  t.after(async () => {
    if (previousToken === undefined) delete process.env.SETUP_TOKEN;
    else process.env.SETUP_TOKEN = previousToken;
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const tokenPath = join(dataDir, 'setup.token');
  await writeFile(tokenPath, '', { mode: 0o600 });
  await assert.rejects(async () => { app = await createApp({ dataDir }); }, /Invalid setup\.token/);
  assert.equal(await readFile(tokenPath, 'utf8'), '', 'startup must not silently replace a corrupted token');
  await assert.rejects(readFile(join(dataDir, 'coordinator.lock')), { code: 'ENOENT' });
  await writeFile(tokenPath, setupToken, { mode: 0o600 });
  app = await createApp({ dataDir });
  assert.equal(app.auth.setupToken, setupToken, 'repairing the token must allow a clean restart');
});

test('coordinator lock rejects a live owner but recovers a reused PID with stale start identity', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-lock-identity-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = await createApp({ dataDir, setupToken });
  const lockPath = join(dataDir, 'coordinator.lock');
  const liveRecord = await readFile(lockPath, 'utf8');
  const owner = JSON.parse(liveRecord);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.start, /^\d+$/);
  assert.ok(owner.boot);
  await assert.rejects(createApp({ dataDir, setupToken }), /already owned by a running coordinator/);
  assert.equal(await readFile(lockPath, 'utf8'), liveRecord, 'a failed contender must leave the live lock untouched');
  await app.close(); app = null;
  await writeFile(lockPath, JSON.stringify({ ...owner, start: (BigInt(owner.start) + 1n).toString() }), { mode: 0o600 });
  app = await createApp({ dataDir, setupToken });
  const replacement = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(replacement.pid, owner.pid);
  assert.equal(replacement.start, owner.start, 'the current /proc process identity must replace the stale one');
  assert.notEqual(replacement.nonce, owner.nonce);
});

test('simultaneous startups reclaim a stale lock with exactly one coordinator and release the lease on close', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-concurrent-lock-'));
  const instances = new Set();
  t.after(async () => {
    for (const app of instances) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const start = async () => {
    const app = await createApp({ dataDir, setupToken });
    instances.add(app);
    return app;
  };
  const initial = await start();
  const lockPath = join(dataDir, 'coordinator.lock');
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  await initial.close(); instances.delete(initial);
  await writeFile(lockPath, JSON.stringify({ ...owner, start: (BigInt(owner.start) + 1n).toString() }), { mode: 0o600 });

  const attempts = await Promise.allSettled([start(), start()]);
  const successful = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 1, 'only one concurrent contender may acquire the data directory');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already owned by a running coordinator/);
  const winner = successful[0].value;
  await winner.storage.createBucket('lease-survives');
  await winner.close(); instances.delete(winner);

  const restarted = await start();
  assert.ok((await restarted.storage.buckets()).some(bucket => bucket.name === 'lease-survives'), 'a subsequent process must recover data after the winner releases its lease');
});

test('untrusted clients cannot evade login throttling by spoofing proxy headers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storeges3-untrusted-proxy-'));
  const app = await createApp({ dataDir, setupToken, trustedProxyIPs: '' });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  for (let attempt = 1; attempt <= 9; attempt++) {
    const spoofed = `198.51.100.${attempt}`;
    const response = await rawRequest(endpoint, 'POST', '/api/login', {
      headers: { 'content-type': 'application/json', 'x-27g-client-ip': spoofed, 'x-forwarded-for': spoofed },
      body: JSON.stringify({ username: 'unknown', password: 'invalid-password' }),
    });
    assert.equal(response.status, attempt <= 8 ? 401 : 429, `attempt ${attempt} must be counted against the socket peer`);
  }
});

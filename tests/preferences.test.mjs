import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-language-'));
  let app, endpoint;
  async function start() { app = await createApp({ dataDir }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); endpoint = `http://127.0.0.1:${app.server.address().port}`; }
  const call = async (path, session, method = 'GET', body, headers = {}) => {
    const r = await fetch(endpoint + path, { method, headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, headers: r.headers, data: await r.json() };
  };
  async function login(username = 'admin', password = 'admin!123') {
    const r = await call('/api/login', null, 'POST', { username, password, setupToken: app.auth.setupToken });
    assert.equal(r.status, 200); return { ...r.data, cookie: r.headers.get('set-cookie').split(';')[0] };
  }
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  return { call, login, get auth() { return app.auth; }, async restart() { await app.close(); app = null; await start(); } };
}

test('language preference defaults to English and stays personal across sessions, restart and HA snapshots', async t => {
  const f = await fixture(t), password = 'language-test-password';
  assert.equal((await f.call('/api/session')).data.language, 'en');
  const admin = await f.login(); assert.equal(admin.language, 'en');
  for (const role of ['viewer', 'operator']) assert.equal((await f.call('/api/users', admin, 'POST', { username: role, password, role })).status, 201);
  const viewer = await f.login('viewer', password), otherViewer = await f.login('viewer', password), operator = await f.login('operator', password);
  assert.deepEqual((await f.call('/api/preferences', viewer)).data, { language: 'en' });
  assert.equal((await f.call('/api/preferences', viewer, 'PUT', { language: 'ru' })).status, 200);
  assert.equal((await f.call('/api/session', otherViewer)).data.language, 'ru');
  assert.deepEqual((await f.call('/api/preferences', operator)).data, { language: 'en' });
  assert.equal((await f.call('/api/session', admin)).data.language, 'en');
  assert.equal((await f.call('/api/preferences', operator, 'PUT', { language: 'ru' })).status, 200);
  const snapshot = f.auth.exportState();
  await f.call('/api/preferences', viewer, 'PUT', { language: 'en' });
  f.auth.importState(snapshot);
  assert.deepEqual(f.auth.userPreferences('viewer'), { language: 'ru' });
  await f.restart();
  assert.equal((await f.login('viewer', password)).language, 'ru');
  assert.equal((await f.login()).language, 'en');
  assert.equal((await f.call('/api/session')).data.language, 'en');
});

test('preference endpoint requires authentication and CSRF and rejects cross-user or unsupported settings', async t => {
  const f = await fixture(t), admin = await f.login();
  assert.equal((await f.call('/api/preferences')).status, 401);
  assert.equal((await f.call('/api/preferences', null, 'PUT', { language: 'ru' })).status, 401);
  assert.equal((await f.call('/api/preferences', admin, 'PUT', { language: 'ru' }, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await f.call('/api/preferences', admin, 'PUT', { language: 'ru' }, { origin: 'https://untrusted.example' })).status, 403);
  for (const body of [{}, {language:'fr'}, {language:'RU'}, {language:null}, {language:['ru']}, {language:'ru',username:'other'}, {language:'ru',role:'admin'}]) {
    assert.equal((await f.call('/api/preferences', admin, 'PUT', body)).status, 400);
  }
  assert.deepEqual((await f.call('/api/preferences', admin)).data, { language: 'en' });
  assert.equal((await f.call('/api/preferences', admin, 'PUT', { language: 'ru' })).status, 200);
  assert.equal((await f.call('/api/password', admin, 'PUT', { currentPassword:'admin!123',password:'new-language-password' })).data.language, 'ru');
});

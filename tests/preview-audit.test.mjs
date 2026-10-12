import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'storage-preview-'));
  const app = await createApp({ dataDir }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(endpoint + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin!123' }) });
  assert.equal(login.status, 200); const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  await app.storage.createBucket('preview-files');
  const put = (key, body, contentType = 'application/octet-stream') => app.storage.putObject('preview-files', key, Readable.from([Buffer.from(body)]), { contentType });
  const get = path => fetch(endpoint + path, { headers });
  return { app, endpoint, put, get };
}
test('preview requires login, pins image version and never serves executable content inline', async t => {
  const f = await fixture(t); await f.put('photo.png', png, 'image/png');
  const path = '/api/preview?bucket=preview-files&key=photo.png';
  assert.equal((await fetch(f.endpoint + path)).status, 401);
  const preview = await (await f.get(path)).json(); assert.equal(preview.kind, 'image'); assert.equal(preview.contentType, 'image/png'); assert.ok(preview.url.includes('versionId='));
  await f.put('photo.png', '<script>alert(1)</script>', 'image/png');
  let r = await f.get(preview.url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.match(r.headers.get('content-security-policy'), /sandbox/); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal((await (await f.get(path)).json()).kind, 'unsupported');
  assert.equal((await f.get(path + '&raw=1')).status, 415);
  for (const [key, type] of [['page.html', 'text/html'], ['vector.svg', 'image/svg+xml']]) {
    const source = '<svg onload="alert(1)"><script>danger()</script></svg>'; await f.put(key, source, type);
    const url = `/api/preview?bucket=preview-files&key=${key}`; const data = await (await f.get(url)).json();
    assert.equal(data.kind, 'text'); assert.equal(data.text, source); assert.equal((await f.get(url + '&raw=1')).status, 415);
  }
});
test('preview bounds text, rejects binary and unsupported formats', async t => {
  const f = await fixture(t);
  await f.put('notes.txt', 'a'.repeat(300 * 1024), 'text/plain');
  let data = await (await f.get('/api/preview?bucket=preview-files&key=notes.txt')).json(); assert.equal(data.kind, 'text'); assert.equal(data.text.length, 256 * 1024); assert.equal(data.truncated, true);
  await f.put('too-large.txt', 'a'.repeat(1024 * 1024 + 1), 'text/plain');
  await f.put('binary.txt', Buffer.from([0,1,2,3]), 'text/plain');
  await f.put('report.pdf', '%PDF-1.7\n', 'application/pdf');
  await f.put('bad-utf8.txt', Buffer.from([255,254,255]), 'text/plain');
  for (const key of ['too-large.txt', 'binary.txt', 'report.pdf', 'bad-utf8.txt']) {
    data = await (await f.get(`/api/preview?bucket=preview-files&key=${key}`)).json(); assert.equal(data.kind, 'unsupported', key);
  }
  const huge = Buffer.from(png); huge.writeUInt32BE(100000,16); huge.writeUInt32BE(100000,20); await f.put('huge.png', huge, 'image/png');
  assert.equal((await (await f.get('/api/preview?bucket=preview-files&key=huge.png')).json()).kind, 'unsupported');
});
test('audit defaults to 10 and only permits pages of 10, 25, 50', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 62; i++) f.app.auth.audit('pagination.fixture', String(i));
  let result = await (await f.get('/api/audit')).json(); assert.equal(result.pageSize, 10); assert.equal(result.page, 1); assert.equal(result.events.length, 10);
  const first = result.events.map(e => e.id);
  result = await (await f.get('/api/audit?page=2&pageSize=10')).json(); assert.equal(result.events.length, 10); assert.ok(result.events.every(e => !first.includes(e.id)));
  for (const size of [25, 50]) { result = await (await f.get(`/api/audit?pageSize=${size}`)).json(); assert.equal(result.events.length, size); assert.equal(result.pageSize, size); }
  for (const q of ['pageSize=11','pageSize=200','pageSize=0','page=0','page=-1','page=1.5','pageSize=no']) assert.equal((await f.get('/api/audit?' + q)).status,400,q);
  result = await (await f.get('/api/audit?page=9999')).json(); assert.equal(result.page, result.totalPages); assert.ok(result.events.length <= 10);
  assert.equal((await fetch(f.endpoint + '/api/audit')).status,401);
});

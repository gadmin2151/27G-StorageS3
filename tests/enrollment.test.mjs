import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Auth } from '../src/auth.mjs';
import { AgentEnrollment, enrollmentInput } from '../src/agent-enrollment.mjs';
import { createDiskAgent } from '../src/disk-agent.mjs';
const exec = promisify(execFile), sha = v => createHash('sha256').update(v).digest('hex');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), '27g-enrollment-'));
  let auth = new Auth({ dataDir: directory }); await auth.initializeDefaults();
  let service = new AgentEnrollment({ auth, ...options });
  t.after(async () => { auth.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get auth() { return auth; }, get service() { return service; }, async restart() { auth.close(); auth = new Auth({ dataDir: directory }); service = new AgentEnrollment({ auth, ...options }); } };
}
async function issue(f, input = {}) {
  const issued = await f.service.create(input, { origin: 'http://127.0.0.1:9000', owner: 'admin' });
  const row = f.service.rows().find(r => r.id === issued.id), token = [...issued.command.matchAll(/[a-f0-9]{64}/g)].map(m => m[0]).find(value => sha(value) === row.tokenHash);
  assert.ok(token); return { ...issued, token };
}

test('enrollment uses deterministic allowlisted source bundles and verified one-line installer', async t => {
  const f = await fixture(t), first = await issue(f), assets = await f.service.assets();
  assert.equal(sha(assets.bundle), first.sourceSha256);
  assert.ok(!first.command.includes('\n')); assert.match(first.command, /sha256sum -c/); assert.match(first.command, /sudo -n bash/);
  assert.ok(!first.command.includes(`Bearer ${first.token}`));
  const archive = join(f.directory, 'source.tar.gz'); await writeFile(archive, assets.bundle);
  const listing = (await exec('tar', ['-tzf', archive])).stdout.trim().split('\n');
  assert.ok(listing.includes('Dockerfile.disk-agent')); assert.ok(listing.includes('src/disk-agent.mjs')); assert.ok(listing.includes('package.json'));
  assert.ok(listing.every(name => name === 'package.json' || name === 'Dockerfile.disk-agent' || /^src\/[a-zA-Z0-9_.-]+\.mjs$/.test(name)));
  assert.ok(!listing.some(name => /^(secrets|data|\.git)\//.test(name)));
  await f.restart(); assert.equal((await f.service.assets()).sourceSha256, first.sourceSha256); assert.equal(f.service.authorize(first.token).id, first.id);
  assert.ok(!JSON.stringify(f.service.list()).includes(first.token)); assert.ok(!JSON.stringify(f.service.list()).includes(sha(first.token)));
});

test('one-time enrollment registers an authenticated reachable agent; tokens remain encrypted', async t => {
  const f = await fixture(t), agentToken = 'a'.repeat(64), agent = await createDiskAgent({ dataDir: join(f.directory, 'agent'), token: agentToken, allowedRoots: [f.directory] });
  agent.server.listen(0, '127.0.0.1'); await once(agent.server, 'listening'); t.after(() => agent.close());
  const agentUrl = `http://127.0.0.1:${agent.server.address().port}`, issued = await issue(f, { label: 'Storage host', agentUrl });
  const result = await f.service.complete(issued.token, { agentToken, sourceSha256: issued.sourceSha256 }, '127.0.0.1');
  assert.equal(result.agentUrl, agentUrl); assert.equal(f.service.list()[0].status, 'connected');
  const agents = f.auth.preference('diskAgents', []); assert.equal(agents.length, 1); assert.equal(f.auth.decrypt(agents[0].secret), agentToken);
  assert.ok(!JSON.stringify(f.auth.exportState()).includes(agentToken));
  await f.restart(); assert.equal(f.service.list()[0].status, 'connected');
  await assert.rejects(f.service.complete(issued.token, { agentToken, sourceSha256: issued.sourceSha256 }, '127.0.0.1'), { status: 401 });
  const duplicate = await issue(f, { agentUrl }); await assert.rejects(f.service.complete(duplicate.token, { agentToken, sourceSha256: duplicate.sourceSha256 }, '127.0.0.1'), { status: 409 });
  assert.equal(f.auth.preference('diskAgents', []).length, 1);
});

test('expiration, revocation and concurrent claims never register more than one agent', async t => {
  let time = 123_000, finishProbe, probing;
  const f = await fixture(t, { now: () => time, probe: async () => { probing?.(); await new Promise(done => { finishProbe = done; }); } });
  const issued = await issue(f), input = { agentToken: 'b'.repeat(64), sourceSha256: issued.sourceSha256 };
  const started = new Promise(done => { probing = done; }), finishing = f.service.complete(issued.token, input, '192.168.1.8'); await started;
  await assert.rejects(f.service.complete(issued.token, input, '192.168.1.8'), { status: 409 });
  f.service.revoke(issued.id); finishProbe(); await assert.rejects(finishing, { status: 401 }); assert.deepEqual(f.auth.preference('diskAgents', []), []);
  const expired = await issue(f); time = expired.expiresAt; assert.throws(() => f.service.authorize(expired.token), { status: 401 }); assert.equal(f.service.list().find(r => r.id === expired.id).status, 'expired');
  assert.throws(() => f.service.authorize('0'.repeat(64)), { status: 401 });
});

test('unreachable agent leaves command available for retry; wrong source does not register', async t => {
  let fail = true, lastUrl;
  const f = await fixture(t, { probe: async url => { lastUrl = url; if (fail) throw new Error('offline'); } });
  const issued = await issue(f, { port: 9300 }), input = { agentToken: 'c'.repeat(64), sourceSha256: issued.sourceSha256 };
  await assert.rejects(f.service.complete(issued.token, { ...input, sourceSha256: '0'.repeat(64) }, '::1'), { status: 400 });
  await assert.rejects(f.service.complete(issued.token, input, '::1'), { status: 409 }); assert.equal(f.service.list()[0].status, 'pending');
  fail = false; await f.service.complete(issued.token, input, '::1'); assert.equal(lastUrl, 'http://[::1]:9300');
});

test('installer public routes bind bundle to bearer token and block browser origins', async t => {
  const f = await fixture(t), issued = await issue(f), assets = await f.service.assets();
  const request = (path, method, headers = {}) => ({ method, headers, url: path });
  const response = () => ({ status: 0, headers: {}, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
  let path = `/api/agent-install/script/${assets.scriptSha256}.sh`, req = request(path, 'GET'), res = response();
  assert.equal(await f.service.handlePublic(req, res, new URL(path, 'http://local')), true); assert.equal(sha(res.body), assets.scriptSha256);
  path = `/api/agent-install/bundle/${issued.sourceSha256}`;
  await assert.rejects(f.service.handlePublic(request(path, 'POST'), response(), new URL(path, 'http://local')), { status: 401 });
  await assert.rejects(f.service.handlePublic(request(path, 'POST', { authorization: `Bearer ${issued.token}`, origin: 'https://evil.example' }), response(), new URL(path, 'http://local')), { status: 403 });
  res = response(); await f.service.handlePublic(request(path, 'POST', { authorization: `Bearer ${issued.token}` }), res, new URL(path, 'http://local')); assert.equal(sha(res.body), issued.sourceSha256);
  assert.equal(f.service.list()[0].status, 'pending', 'downloading is not registration');
});

test('input validation rejects command injection, sensitive roots and privileged mode typos', () => {
  assert.equal(enrollmentInput({}).mode, 'folders');
  for (const directory of ['/', '/dev', '/etc', '/srv/../../etc', '/tmp/$(touch nope)', '/srv/a,b', '/srv/a\nb']) assert.throws(() => enrollmentInput({ directory }), { status: 400 });
  for (const agentUrl of ['https://x/path', 'https://u:p@x', 'file:///etc/passwd']) assert.throws(() => enrollmentInput({ agentUrl }), { status: 400 });
  assert.throws(() => enrollmentInput({ mode: 'privileged' }), { status: 400 }); assert.throws(() => enrollmentInput({ port: 22 }), { status: 400 });
});

test('installer verifies bundle before docker build/run or persistent host writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), '27g-installcheck-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'); await mkdir(bin); const trace = join(directory, 'trace');
  const fake = async (name, content) => { const path = join(bin, name); await writeFile(path, '#!/bin/bash\n' + content); await chmod(path, 0o700); };
  await fake('id', 'echo 0\n'); await fake('uname', 'echo Linux\n');
  await fake('docker', `printf '%s\\n' "$*" >> '${trace}'\n[[ $1 == info ]]\n`);
  await fake('curl', 'while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then printf invalid-archive > "$2"; exit 0; fi; shift; done; exit 1\n');
  const script = resolve('scripts/install-agent.sh');
  await assert.rejects(exec('bash', ['-c', 'printf "%s\\n" "$BOOTSTRAP" | bash "$SCRIPT" http://127.0.0.1:9000 "$HASH" 9200 /srv/27g-test-agent folders ""'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOOTSTRAP: 'a'.repeat(64), HASH: '0'.repeat(64), SCRIPT: script } }), error => /Контрольная сумма/.test(error.stderr));
  assert.equal((await readFile(trace, 'utf8')).trim(), 'info');
});


test('generated copy-paste command verifies script hash and passes bootstrap through stdin', async t => {
  const f = await fixture(t), issued = await issue(f), bin = join(f.directory, 'fake-tools'); await mkdir(bin);
  const captured = join(f.directory, 'captured'), scriptPath = resolve('scripts/install-agent.sh');
  const fake = async (name, contents) => { const path = join(bin, name); await writeFile(path, '#!/bin/bash\nset -e\n' + contents); await chmod(path, 0o700); };
  await fake('curl', 'while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then if [[ ${CORRUPT:-} == yes ]]; then printf corrupt > "$2"; else cp "$PINNED_SCRIPT" "$2"; fi; exit 0; fi; shift; done; exit 1\n');
  await fake('sudo', 'if [[ $1 == -v ]]; then exit 0; fi; [[ $1 == -n && $2 == bash && -f $3 ]]; cat > "$CAPTURED"; printf "%s\\n" "$4" "$5" "$6" "$7" "$8" "$9" > "$CAPTURED.args"\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PINNED_SCRIPT: scriptPath, CAPTURED: captured };
  await exec('bash', ['-c', issued.command], { env });
  assert.equal(await readFile(captured, 'utf8'), issued.token + '\n');
  assert.equal(await readFile(captured + '.args', 'utf8'), `http://127.0.0.1:9000\n${issued.sourceSha256}\n9200\n/srv/27g-storeges3/disks\nfolders\n\n`);
  await rm(captured);
  await assert.rejects(exec('bash', ['-c', issued.command], { env: { ...env, CORRUPT: 'yes' } }));
  await assert.rejects(readFile(captured), { code: 'ENOENT' });
});

test('application HTTP integration enforces admin/CSRF and registers without browser session', async t => {
  const { createApp } = await import('../src/server.mjs');
  const directory = await mkdtemp(join(tmpdir(), '27g-enrollment-http-'));
  const app = await createApp({ dataDir: join(directory, 'coordinator') }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const agentToken = 'd'.repeat(64), agent = await createDiskAgent({ dataDir: join(directory, 'agent'), token: agentToken, allowedRoots: [directory] });
  agent.server.listen(0, '127.0.0.1'); await once(agent.server, 'listening');
  t.after(async () => { await agent.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${app.server.address().port}`, agentUrl = `http://127.0.0.1:${agent.server.address().port}`;
  const request = (path, method = 'GET', value, headers = {}) => fetch(endpoint + path, { method, headers: { ...headers, ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  assert.equal((await request('/api/agent-enrollments')).status, 401);
  const login = await request('/api/login', 'POST', { username: 'admin', password: 'admin!123', setupToken: app.auth.setupToken }); assert.equal(login.status, 200);
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0], headers = { cookie, 'x-csrf-token': session.csrf };
  assert.equal((await request('/api/agent-enrollments', 'POST', { agentUrl }, { cookie })).status, 403);
  assert.equal((await request('/api/agent-enrollments', 'POST', { agentUrl }, { ...headers, origin: 'https://other.example' })).status, 403);
  const created = await request('/api/agent-enrollments', 'POST', { label: 'HTTP integration', agentUrl }, headers); assert.equal(created.status, 201); const issued = await created.json();
  const row = app.enrollment.rows().find(r => r.id === issued.id), token = [...issued.command.matchAll(/[a-f0-9]{64}/g)].map(m => m[0]).find(value => sha(value) === row.tokenHash), assets = await app.enrollment.assets();
  const script = await request(`/api/agent-install/script/${assets.scriptSha256}.sh`); assert.equal(script.status, 200); assert.equal(sha(Buffer.from(await script.arrayBuffer())), assets.scriptSha256);
  let bundle = await request(`/api/agent-install/bundle/${issued.sourceSha256}`, 'POST'); assert.equal(bundle.status, 401);
  const bearer = { authorization: `Bearer ${token}` };
  bundle = await request(`/api/agent-install/bundle/${issued.sourceSha256}`, 'POST', undefined, bearer); assert.equal(bundle.status, 200); assert.equal(sha(Buffer.from(await bundle.arrayBuffer())), issued.sourceSha256);
  const body = { agentToken, sourceSha256: issued.sourceSha256 };
  assert.equal((await request('/api/agent-install/complete', 'POST', body, { ...bearer, origin: endpoint })).status, 403);
  assert.equal((await request('/api/agent-install/complete', 'POST', body, bearer)).status, 201);
  assert.equal((await request('/api/agent-install/complete', 'POST', body, bearer)).status, 401);
  const agents = await (await request('/api/disk-agents', 'GET', undefined, headers)).json(); assert.equal(agents.agents.length, 1); assert.equal(agents.agents[0].url, agentUrl); assert.ok(!JSON.stringify(agents).includes(agentToken));
  const list = await (await request('/api/agent-enrollments', 'GET', undefined, headers)).json(); assert.equal(list.enrollments[0].status, 'connected'); assert.ok(!JSON.stringify(list).includes(token));
  await app.auth.createUser({ username: 'observer', password: 'a-strong-viewer-password', role: 'viewer' });
  const viewerLogin = await request('/api/login', 'POST', { username: 'observer', password: 'a-strong-viewer-password' }), viewerSession = await viewerLogin.json();
  const viewerHeaders = { cookie: viewerLogin.headers.get('set-cookie').split(';')[0], 'x-csrf-token': viewerSession.csrf };
  assert.equal((await request('/api/agent-enrollments', 'GET', undefined, viewerHeaders)).status, 403);
  assert.equal((await request('/api/agent-enrollments', 'POST', { agentUrl }, viewerHeaders)).status, 403);
});

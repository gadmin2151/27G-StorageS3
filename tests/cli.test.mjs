import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { runCli } from '../src/cli.mjs';
import { createApp } from '../src/server.mjs';

const run = promisify(execFile);
const fakeCredentials = { AWS_ACCESS_KEY_ID: 'CLI-TEST-KEY', AWS_SECRET_ACCESS_KEY: 'test-only-client-secret-at-least-32-characters' };
const existsXML = '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>Bucket already exists.</Message></Error>';

async function call(args, env = {}, options = {}) {
  let stdout = '', stderr = '';
  const status = await runCli(args, { env, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, ...options });
  return { status, stdout, stderr };
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-cli-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = await createApp({ dataDir, initEnv: {} });
  const requests = [];
  app.server.on('request', req => requests.push({ method: req.method, path: req.url }));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const keyEnv = (options = {}) => {
    const key = app.auth.createKey({ label: 'CLI test key', role: 'readwrite', permissions: ['createBucket'], ...options });
    return { S3_ENDPOINT: endpoint, AWS_ACCESS_KEY_ID: key.accessKey, AWS_SECRET_ACCESS_KEY: key.secretKey };
  };
  return { ...app, dataDir, requests, keyEnv, endpoint };
}

async function responding(t, handler) {
  const server = createServer(handler);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, env: { ...fakeCredentials, S3_ENDPOINT: `http://127.0.0.1:${server.address().port}` } };
}

test('CLI creates a bucket with only createBucket permission using exactly one signed PUT', async t => {
  const f = await fixture(t), env = f.keyEnv({ buckets: ['my-bucket'] });
  const result = await call(['create-bucket', 'my-bucket', '--if-not-exists'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Created bucket "my-bucket".\n');
  assert.deepEqual(f.requests, [{ method: 'PUT', path: '/my-bucket' }]);
  assert.equal((await f.storage.buckets())[0].name, 'my-bucket');
  assert.equal((await f.bucketPolicies.get('my-bucket')).mode, 'private');
});

test('idempotent aliases preserve an existing bucket, contents, versions, quotas and policy', async t => {
  const f = await fixture(t), env = f.keyEnv({ buckets: ['my-bucket'] });
  await f.storage.createBucket('my-bucket');
  await f.storage.putObject('my-bucket', 'photo.txt', Readable.from(['retained content']), { contentType: 'text/plain' });
  await f.storage.setBucketQuota('my-bucket', { maxBytes: 1000, maxObjects: 10 });
  await f.bucketPolicies.set('my-bucket', { mode: 'public-read', readPrefixes: ['photo'] });
  const before = { storage: f.storage.exportState(), policy: await f.bucketPolicies.get('my-bucket') };
  for (const flag of ['--if-not-exists', '--if-no-exists']) {
    const result = await call(['create-bucket', flag, 'my-bucket'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Already exists:/);
  }
  assert.deepEqual({ storage: f.storage.exportState(), policy: await f.bucketPolicies.get('my-bucket') }, before);
  const duplicate = await call(['create-bucket', 'my-bucket'], env);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /409, BucketAlreadyOwnedByYou/);
  assert.equal(duplicate.stdout, '');
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(req => req.method === 'PUT'));
});

test('concurrent idempotent commands create once and all succeed', async t => {
  const f = await fixture(t), env = f.keyEnv({ buckets: ['concurrent-bucket'] });
  const results = await Promise.all(Array.from({ length: 8 }, () => call(['create-bucket', 'concurrent-bucket', '--if-not-exists'], env)));
  assert.ok(results.every(result => result.status === 0));
  assert.equal(results.filter(result => result.stdout.startsWith('Created')).length, 1);
  assert.equal(results.filter(result => result.stdout.startsWith('Already exists')).length, 7);
  assert.equal((await f.storage.buckets()).length, 1);
  assert.equal(f.requests.length, 8);
});

test('existing unauthorized buckets, readonly keys and incorrect secrets remain failures', async t => {
  const f = await fixture(t);
  await f.storage.createBucket('private-bucket');
  const scoped = f.keyEnv({ buckets: ['allowed-bucket'] });
  const readonly = f.keyEnv({ role: 'readonly', permissions: ['read', 'list'] });
  const invalid = { ...f.keyEnv(), AWS_SECRET_ACCESS_KEY: 'incorrect-client-secret-at-least-32-characters' };
  for (const env of [scoped, readonly, invalid]) {
    const result = await call(['create-bucket', 'private-bucket', '--if-not-exists'], env);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 403/);
    assert.ok(!result.stderr.includes(env.AWS_ACCESS_KEY_ID));
    assert.ok(!result.stderr.includes(env.AWS_SECRET_ACCESS_KEY));
  }
  assert.equal((await f.storage.buckets()).length, 1);
});

test('only exact 409 XML BucketAlreadyOwnedByYou is suppressible', async t => {
  let status = 409, body = existsXML;
  const { env } = await responding(t, (_req, res) => { res.writeHead(status); res.end(body); });
  for (const malformed of [
    '<Error><Code>BucketAlreadyExists</Code></Error>',
    '<html>BucketAlreadyOwnedByYou</html>',
    '<Error><Code>BucketAlreadyOwnedByYou</Code>',
    '<Error><Message><Code>BucketAlreadyOwnedByYou</Code></Message></Error>',
    '<Error><Code>AccessDenied</Code><Code>BucketAlreadyOwnedByYou</Code></Error>',
    '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>invalid & text</Message></Error>',
    '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>unclosed</Error>',
    '<Error><Code>BucketAlreadyOwnedByYou</Code></Error><Error></Error>',
    '<?xml version="1.0\'?><Error><Code>BucketAlreadyOwnedByYou</Code></Error>',
    '<Error xmlns="invalid\'><Code>BucketAlreadyOwnedByYou</Code></Error>',
    Buffer.concat([Buffer.from('<Error><Code>BucketAlreadyOwnedByYou</Code><Message>'), Buffer.from([0xff]), Buffer.from('</Message></Error>')]),
    JSON.stringify({ Code: 'BucketAlreadyOwnedByYou' }),
  ]) {
    body = malformed;
    assert.equal((await call(['create-bucket', 'my-bucket', '--if-not-exists'], env)).status, 1);
  }
  body = existsXML;
  for (status of [400, 403, 404, 500, 503]) assert.equal((await call(['create-bucket', 'my-bucket', '--if-not-exists'], env)).status, 1);
  status = 409;
  body = '<?xml version="1.0" encoding="UTF-8"?><Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Code>BucketAlreadyOwnedByYou</Code><Message>exists &amp; retained</Message></Error>';
  assert.equal((await call(['create-bucket', 'my-bucket', '--if-not-exists'], env)).status, 0);
  status = 200; body = existsXML;
  assert.equal((await call(['create-bucket', 'my-bucket', '--if-not-exists'], env)).status, 1, 'an error body is not a successful CreateBucket response');
});

test('redirects are never followed and server text is never printed', async t => {
  let requests = 0;
  const marker = 'private-reflected-value-12345678901234567890';
  const { env } = await responding(t, (_req, res) => {
    requests++;
    res.writeHead(307, { location: `/redirect-${marker}` });
    res.end(`<Error><Code>${marker}</Code><Message>${marker}</Message></Error>`);
  });
  const result = await call(['create-bucket', 'my-bucket', '--if-not-exists'], env);
  assert.equal(result.status, 1); assert.equal(requests, 1);
  assert.match(result.stderr, /Redirects are not followed/);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('responses are bounded at 64 KiB even when a duplicate code occurs first', async t => {
  const { env } = await responding(t, (_req, res) => {
    res.writeHead(409);
    res.end(`<Error><Code>BucketAlreadyOwnedByYou</Code><Message>${'x'.repeat(65536)}</Message></Error>`);
  });
  const result = await call(['create-bucket', 'my-bucket', '--if-not-exists'], env);
  assert.equal(result.status, 1); assert.match(result.stderr, /64 KiB/);
});

test('absolute request timeout covers a server that never sends headers', async t => {
  const { env } = await responding(t, () => {});
  const start = Date.now();
  const result = await call(['create-bucket', 'my-bucket'], env, { timeoutMs: 80 });
  assert.equal(result.status, 1); assert.match(result.stderr, /timed out/);
  assert.ok(Date.now() - start < 1500);
});

test('absolute request timeout also interrupts a continuously trickled response', async t => {
  const { env } = await responding(t, (_req, res) => {
    res.writeHead(409); res.write('<Error>');
    const interval = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(interval));
  });
  const result = await call(['create-bucket', 'my-bucket', '--if-not-exists'], env, { timeoutMs: 80 });
  assert.equal(result.status, 1); assert.match(result.stderr, /timed out/);
});

test('connection failures do not leak endpoint values or Node error strings', async t => {
  const { server, env } = await responding(t, () => {});
  await new Promise(resolve => server.close(resolve));
  const result = await call(['create-bucket', 'my-bucket'], env);
  assert.equal(result.status, 1); assert.match(result.stderr, /connection failed/);
  assert.ok(!result.stderr.includes(env.S3_ENDPOINT));
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|stack|Authorization|Credential=/);
});

test('an interrupted response cannot be mistaken for a confirmed existing bucket', async t => {
  const { env } = await responding(t, (_req, res) => {
    res.writeHead(409, { 'content-length': '10000' });
    res.write(existsXML);
    setImmediate(() => res.destroy());
  });
  const result = await call(['create-bucket', 'my-bucket', '--if-not-exists'], env);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
});

test('file credentials trim one newline and work against the real signed API', async t => {
  const f = await fixture(t), original = f.keyEnv({ buckets: ['file-bucket'] });
  const accessFile = join(f.dataDir, 'access.key'), secretFile = join(f.dataDir, 'secret.key');
  await writeFile(accessFile, original.AWS_ACCESS_KEY_ID + '\r\n', { mode: 0o600 });
  await writeFile(secretFile, original.AWS_SECRET_ACCESS_KEY + '\n', { mode: 0o600 });
  const env = { S3_ENDPOINT: f.endpoint, AWS_ACCESS_KEY_ID_FILE: accessFile, AWS_SECRET_ACCESS_KEY_FILE: secretFile, AWS_DEFAULT_REGION: 'us-east-1' };
  assert.equal((await call(['create-bucket', 'file-bucket'], env)).status, 0);
  await writeFile(secretFile, original.AWS_SECRET_ACCESS_KEY + '\n\n');
  assert.equal((await call(['create-bucket', 'other-bucket'], env)).status, 2, 'must not silently trim multiple newlines');
  await writeFile(secretFile, original.AWS_SECRET_ACCESS_KEY + ' \n');
  assert.equal((await call(['create-bucket', 'other-bucket'], env)).status, 2, 'must not silently trim spaces');
});

test('invalid secret files and value/file conflicts fail without exposing contents or paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), '27g-cli-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'PRIVATE-PATH-DO-NOT-ECHO');
  const base = { ...fakeCredentials, AWS_SECRET_ACCESS_KEY: undefined, AWS_SECRET_ACCESS_KEY_FILE: path };
  for (const content of [Buffer.alloc(4097, 's'), Buffer.from([0xff, 0xfe]), Buffer.from('')]) {
    await writeFile(path, content);
    const result = await call(['create-bucket', 'my-bucket'], base);
    assert.equal(result.status, 2); assert.ok(!result.stderr.includes(path));
  }
  for (const env of [
    { ...base, AWS_SECRET_ACCESS_KEY_FILE: dir },
    { ...base, AWS_SECRET_ACCESS_KEY_FILE: join(dir, 'absent') },
    { ...base, AWS_SECRET_ACCESS_KEY: fakeCredentials.AWS_SECRET_ACCESS_KEY },
  ]) {
    const result = await call(['create-bucket', 'my-bucket'], env);
    assert.equal(result.status, 2); assert.ok(!result.stderr.includes(dir));
    assert.ok(!result.stderr.includes(fakeCredentials.AWS_SECRET_ACCESS_KEY));
  }
});

test('configuration rejects endpoint credentials/paths, session tokens and invalid arguments', async () => {
  for (const endpoint of ['file:///tmp/private', 'ftp://localhost', 'http://user:password@localhost', 'http://localhost/console/', 'http://localhost/a/..', 'http:localhost', 'http://localhost/?secret=private', 'http://localhost/#private', 'http://localhost?', 'http://localhost#', ' http://localhost', 'http:\\localhost']) {
    const result = await call(['create-bucket', 'my-bucket'], { ...fakeCredentials, S3_ENDPOINT: endpoint });
    assert.equal(result.status, 2); assert.ok(!result.stderr.includes(endpoint));
  }
  for (const env of [{}, { ...fakeCredentials, AWS_SESSION_TOKEN: 'hidden' }, { ...fakeCredentials, AWS_SECURITY_TOKEN: 'hidden' }, { ...fakeCredentials, AWS_REGION: 'bad/region' }, { ...fakeCredentials, AWS_ACCESS_KEY_ID: 'bad\nkey' }]) {
    assert.equal((await call(['create-bucket', 'my-bucket'], env)).status, 2);
  }
  for (const args of [[], ['bad-command'], ['create-bucket'], ['create-bucket', 'My-Bucket'], ['create-bucket', 'my-bucket', 'second-bucket'], ['create-bucket', 'my-bucket', '—if-no-exists'], ['create-bucket', 'my-bucket', '--unknown'], ['create-bucket', 'my-bucket', '--if-not-exists', '--if-no-exists']]) {
    assert.equal((await call(args, fakeCredentials)).status, 2);
  }
});

test('CLI help is credential-free and the actual executable does not load SQLite', async () => {
  for (const args of [['--help'], ['-h'], ['create-bucket', '--help']]) {
    const result = await call(args, { AWS_SESSION_TOKEN: 'ignored-for-help' });
    assert.equal(result.status, 0); assert.match(result.stdout, /create-bucket NAME/); assert.equal(result.stderr, '');
  }
  const result = await run(process.execPath, ['src/cli.mjs', '--help'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, timeout: 3000 });
  assert.match(result.stdout, /27G-StorageS3 client/); assert.equal(result.stderr, '');
  const source = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:\.\/|node:sqlite)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Auth, DEFAULT_ADMIN_PASSWORD } from '../src/auth.mjs';
import { Storage } from '../src/storage.mjs';
import { BucketPolicies } from '../src/bucket-policy.mjs';
import { initializeSystem } from '../src/bootstrap.mjs';
import { createApp } from '../src/server.mjs';

const password = 'initial-test-password-2026';
const suppliedSecret = 'test-only-bootstrap-secret-at-least-32-characters';
const body = value => Readable.from([Buffer.from(value)]);
const run = promisify(execFile);

const directory = () => mkdtemp(join(tmpdir(), '27g-bootstrap-'));

async function fixture(t) {
  const root = await directory(), dataDir = join(root, 'data');
  let auth, storage;
  t.after(async () => { auth?.close(); await storage?.close(); await rm(root, { recursive: true, force: true }); });
  async function open() {
    storage = await new Storage({ dataDir }).init();
    auth = new Auth({ dataDir });
    storage.quotaPolicy = owner => owner ? auth.userPolicy(owner) : {};
  }
  await open();
  return {
    root, dataDir,
    get auth() { return auth; }, get storage() { return storage; },
    initialize: (env = {}) => initializeSystem({ auth, storage, env }),
    async restart() { auth.close(); await storage.close(); await open(); },
    async config(value) {
      const path = join(root, 'initial.json');
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      return { INIT_CONFIG_FILE: path };
    },
  };
}

async function credentials(f) {
  const path = join(f.dataDir, 'init-credentials.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'initial credentials must only be readable by their owner');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function noPlaintextInDatabase(f, secrets) {
  const snapshot = JSON.stringify({ auth: f.auth.exportState(), storage: f.storage.exportState() });
  for (const secret of secrets) assert.ok(!snapshot.includes(secret), 'metadata snapshots must not contain plaintext credentials');
  for (const name of await readdir(f.dataDir)) {
    if (!/\.sqlite(?:-(?:wal|shm))?$/.test(name)) continue;
    const data = await readFile(join(f.dataDir, name));
    for (const secret of secrets) assert.ok(!data.includes(Buffer.from(secret)), 'SQLite files and journals must not contain plaintext credentials');
  }
}

function validConfig() {
  return { version: 1, users: [{ username: 'owner', password, role: 'admin' }],
    buckets: [{ name: 'documents', quotaBytes: 100, quotaObjects: 5, access: { mode: 'private', readPrefixes: [] } }],
    keys: [{ label: 'documents application', owner: 'owner', role: 'readwrite', buckets: ['documents'], permissions: ['read', 'list', 'write'] }] };
}

test('a supplied setup token is persisted once and runtime overrides never replace the stored token', async t => {
  const dataDir = await directory(), tokenPath = join(dataDir, 'setup.token');
  const initialToken = 'test-initial-setup-token-at-least-24-characters';
  const runtimeToken = 'test-runtime-override-token-at-least-24-characters';
  let auth;
  t.after(async () => { auth?.close(); await rm(dataDir, { recursive: true, force: true }); });
  auth = new Auth({ dataDir, setupToken: initialToken });
  assert.equal(auth.setupToken, initialToken);
  const original = await readFile(tokenPath), identity = await stat(tokenPath);
  assert.ok(original.equals(Buffer.from(initialToken)), 'the initial supplied token must be written exactly');
  assert.equal(identity.mode & 0o777, 0o600);

  auth.close(); auth = undefined;
  auth = new Auth({ dataDir });
  assert.equal(auth.setupToken, initialToken);
  assert.equal((await stat(tokenPath)).ino, identity.ino);

  auth.close(); auth = undefined;
  auth = new Auth({ dataDir, setupToken: runtimeToken });
  assert.equal(auth.setupToken, runtimeToken, 'a configured runtime override retains the established behavior');
  assert.ok((await readFile(tokenPath)).equals(original), 'a runtime override must not rewrite the persisted token');
  assert.equal((await stat(tokenPath)).ino, identity.ino);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);

  auth.close(); auth = undefined;
  auth = new Auth({ dataDir });
  assert.equal(auth.setupToken, initialToken, 'removing the override restores the original persisted token');
});

test('no initialization inputs preserve default-admin behavior without generating a credentials file', async t => {
  const f = await fixture(t);
  assert.equal((await f.initialize()).status, 'defaults');
  assert.deepEqual(f.auth.listUsers().map(user => user.username), ['admin']);
  assert.equal(f.auth.defaultCredentials, true);
  assert.equal((await f.auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD, setupToken: f.auth.setupToken }, 'default-login')).user, 'admin');
  assert.deepEqual(await f.storage.buckets(), []);
  assert.deepEqual(f.auth.listKeys(), []);
  await assert.rejects(readFile(join(f.dataDir, 'init-credentials.json')), { code: 'ENOENT' });
});

test('opt-in generates a private administrator password and stores it only in the protected credentials file', async t => {
  const f = await fixture(t);
  const result = await f.initialize({ INIT_ENABLED: 'true' });
  assert.equal(result.status, 'initialized');
  assert.equal(result.credentialsFile, join(f.dataDir, 'init-credentials.json'));
  const saved = await credentials(f);
  assert.equal(saved.version, 1);
  assert.equal(saved.users.length, 1);
  const admin = saved.users[0];
  assert.equal(admin.username, 'admin');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.generated, true);
  assert.ok(admin.password.length >= 24);
  assert.notEqual(admin.password, DEFAULT_ADMIN_PASSWORD);
  assert.equal(f.auth.defaultCredentials, false);
  assert.equal((await f.auth.login({ username: admin.username, password: admin.password }, 'generated-login')).user, 'admin');
  assert.deepEqual(saved.keys, []);
  assert.equal(f.auth.preference('initialBootstrap', null).status, 'done');
  assert.equal(Object.hasOwn(f.auth.preference('initialBootstrap', null), 'credentials'), false, 'completed markers must not retain recoverable initial secrets');
  await noPlaintextInDatabase(f, [admin.password]);
});

test('environment initialization creates a scoped key, public-read prefix policy and enforced bucket quotas', async t => {
  const f = await fixture(t);
  const result = await f.initialize({ INIT_ADMIN_USERNAME: 'owner', INIT_ADMIN_PASSWORD: password,
    INIT_BUCKET: 'pictures', INIT_BUCKET_ACCESS: 'public-read', INIT_BUCKET_READ_PREFIXES: '["public/"]',
    INIT_BUCKET_QUOTA_BYTES: '4', INIT_BUCKET_QUOTA_OBJECTS: '1' });
  assert.equal(result.status, 'initialized');
  const saved = await credentials(f);
  assert.equal(saved.users[0].generated, false);
  assert.equal(saved.users[0].password, password);
  assert.equal(saved.keys.length, 1);
  const key = f.auth.lookupKey(saved.keys[0].accessKey);
  assert.ok(key.secretKey === saved.keys[0].secretKey, 'the saved generated key must authenticate');
  assert.equal(key.owner, 'owner');
  assert.deepEqual(key.buckets, ['pictures']);
  assert.ok(key.permissions.includes('write'));
  const policies = new BucketPolicies(f);
  assert.deepEqual(await policies.get('pictures'), { bucket: 'pictures', mode: 'public-read', readPrefixes: ['public/'], anonymousList: false });
  assert.equal(await policies.allowsAnonymousRead('pictures', 'public/photo.jpg'), true);
  assert.equal(await policies.allowsAnonymousRead('pictures', 'private/photo.jpg'), false);
  assert.equal(await policies.allowsAnonymousRead('pictures', ''), false);
  await f.storage.putObject('pictures', 'public/one', body('1234'), { owner: 'owner' });
  await assert.rejects(f.storage.putObject('pictures', 'two', body('x'), { owner: 'owner' }), { code: 'QuotaExceeded' });
  // Replacing an object would retain a version, so it also consumes the quota.
  await assert.rejects(f.storage.putObject('pictures', 'public/one', body('x'), { owner: 'owner' }), { code: 'QuotaExceeded' });
  const stored = await f.storage.getObject('pictures', 'public/one');
  assert.equal(await stored.stream.toArray().then(chunks => Buffer.concat(chunks).toString()), '1234');
  await noPlaintextInDatabase(f, [password, saved.keys[0].secretKey]);
});

test('secret files and JSON configuration preserve roles, language, exact credentials and user quotas', async t => {
  const f = await fixture(t);
  const passwordFile = join(f.root, 'admin-password'), secretKeyFile = join(f.root, 'application-secret');
  await writeFile(passwordFile, `${password}\r\n`, { mode: 0o600 });
  await writeFile(secretKeyFile, `${suppliedSecret}\n`, { mode: 0o600 });
  const config = { version: 1, users: [
    { username: 'owner', passwordFile: 'admin-password', role: 'admin', language: 'ru' },
    { username: 'worker', role: 'operator', quotaBytes: 3, quotaObjects: 1, language: 'en' },
    { username: 'reader', password: 'reader-password-for-test', role: 'viewer', quotaBytes: 0, quotaObjects: 0 },
  ], buckets: [{ name: 'documents' }], keys: [
    { label: 'read documents', owner: 'reader', role: 'readonly', buckets: ['documents'], prefixes: ['public/'], permissions: ['read', 'list'], accessKey: 'INITIAL-READER-KEY', secretKeyFile: 'application-secret' },
    { label: 'write documents', owner: 'worker', role: 'readwrite', buckets: ['documents'], prefixes: ['inbox/'], permissions: ['read', 'list', 'write'] },
  ] };
  assert.equal((await f.initialize(await f.config(config))).status, 'initialized');
  const saved = await credentials(f);
  assert.equal(saved.users.length, 3);
  const admin = saved.users.find(user => user.username === 'owner'), worker = saved.users.find(user => user.username === 'worker');
  assert.equal(admin.password, password);
  assert.equal(admin.generated, false);
  assert.equal(worker.generated, true);
  assert.equal((await f.auth.login({ username: 'owner', password }, 'file-login')).role, 'admin');
  assert.equal((await f.auth.login({ username: 'worker', password: worker.password }, 'worker-login')).role, 'operator');
  assert.equal(f.auth.userPreferences('owner').language, 'ru');
  assert.equal(f.auth.userPreferences('worker').language, 'en');
  assert.equal(f.auth.userPolicy('reader').quotaBytes, 0);
  const key = f.auth.lookupKey('INITIAL-READER-KEY');
  assert.equal(key.secretKey, suppliedSecret);
  assert.equal(key.role, 'readonly');
  assert.equal(key.owner, 'reader');
  assert.deepEqual(key.prefixes, ['public/']);
  assert.deepEqual(key.permissions, ['read', 'list']);
  assert.deepEqual(saved.keys.find(item => item.accessKey === 'INITIAL-READER-KEY').generated, { accessKey: false, secretKey: false });
  assert.equal((await new BucketPolicies(f).get('documents')).mode, 'private');
  await f.storage.putObject('documents', 'inbox/first', body('123'), { owner: 'worker' });
  await assert.rejects(f.storage.putObject('documents', 'inbox/second', body('x'), { owner: 'worker' }), { code: 'QuotaExceeded' });
  await noPlaintextInDatabase(f, [password, suppliedSecret, worker.password, 'reader-password-for-test']);
});

test('environment secret files import the requested key without exposing plaintext in database state', async t => {
  const f = await fixture(t), passwordFile = join(f.root, 'password'), secretFile = join(f.root, 'secret');
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  await writeFile(secretFile, `${suppliedSecret}\n`, { mode: 0o600 });
  await f.initialize({ INIT_ADMIN_PASSWORD_FILE: passwordFile, INIT_BUCKET: 'archive', INIT_S3_ACCESS_KEY: 'EXISTING-APPLICATION', INIT_S3_SECRET_KEY_FILE: secretFile });
  assert.equal((await f.auth.login({ username: 'admin', password }, 'environment-file-login')).role, 'admin');
  const key = f.auth.lookupKey('EXISTING-APPLICATION');
  assert.equal(key.secretKey, suppliedSecret);
  assert.deepEqual(key.buckets, ['archive']);
  await noPlaintextInDatabase(f, [password, suppliedSecret]);
});

test('partially supplied keys generate only the missing component and save a usable complete pair', async t => {
  const f = await fixture(t), config = validConfig();
  config.keys = [
    { label: 'fixed access', owner: 'owner', buckets: ['documents'], accessKey: 'FIXED-ACCESS-KEY' },
    { label: 'fixed secret', owner: 'owner', buckets: ['documents'], secretKey: suppliedSecret },
  ];
  await f.initialize(await f.config(config));
  const saved = await credentials(f);
  const fixedAccess = saved.keys.find(key => key.label === 'fixed access');
  const fixedSecret = saved.keys.find(key => key.label === 'fixed secret');
  assert.equal(fixedAccess.accessKey, 'FIXED-ACCESS-KEY');
  assert.deepEqual(fixedAccess.generated, { accessKey: false, secretKey: true });
  assert.ok(fixedAccess.secretKey.length >= 32);
  assert.deepEqual(fixedSecret.generated, { accessKey: true, secretKey: false });
  assert.ok(fixedSecret.secretKey === suppliedSecret, 'provided secret must remain unchanged');
  for (const key of saved.keys) assert.ok(f.auth.lookupKey(key.accessKey).secretKey === key.secretKey, 'each saved pair must authenticate');
  await noPlaintextInDatabase(f, [password, suppliedSecret, fixedAccess.secretKey]);
});

test('the whole JSON configuration is validated before users, keys, buckets or markers are created', async t => {
  const scenarios = [
    ['unsupported version', config => { config.version = 2; }],
    ['unknown field', config => { config.adminPassword = password; }],
    ['no administrator', config => { config.users[0].role = 'operator'; }],
    ['unknown role', config => { config.users.push({ username: 'second', password, role: 'root' }); }],
    ['invalid language', config => { config.users[0].language = 'de'; }],
    ['duplicate users', config => { config.users.push({ ...config.users[0] }); }],
    ['negative user quota', config => { config.users[0].quotaBytes = -1; }],
    ['invalid trailing bucket', config => { config.buckets.push({ name: 'Not A Bucket' }); }],
    ['reserved bucket', config => { config.buckets.push({ name: 'console' }); }],
    ['fractional bucket quota', config => { config.buckets[0].quotaObjects = 0.5; }],
    ['invalid public prefix', config => { config.buckets[0].access = { mode: 'public-read', readPrefixes: ['a\0b'] }; }],
    ['unknown key owner', config => { config.keys[0].owner = 'missing'; }],
    ['invalid key permissions', config => { config.keys[0].permissions = ['read', 'imaginary']; }],
    ['readonly key with write access', config => { config.keys[0].role = 'readonly'; }],
    ['prefix key with bucket creation', config => { config.keys[0].prefixes = ['public/']; config.keys[0].permissions = ['createBucket']; }],
    ['secret too short', config => { config.keys[0].secretKey = 'short'; }],
  ];
  for (const [name, change] of scenarios) await t.test(name, async t => {
    const f = await fixture(t), config = validConfig(); change(config);
    const beforeAuth = f.auth.exportState(), beforeStorage = f.storage.exportState();
    await assert.rejects(f.initialize(await f.config(config)));
    assert.deepEqual(f.auth.exportState(), beforeAuth, 'failed validation must not create authentication records');
    assert.deepEqual(f.storage.exportState(), beforeStorage, 'failed validation must not change catalog records');
    assert.equal(f.auth.preference('initialBootstrap', null), null);
    await assert.rejects(readFile(join(f.dataDir, 'init-credentials.json')), { code: 'ENOENT' });
  });
});

test('conflicting environment/file inputs, missing secrets and malformed configuration fail before mutation', async t => {
  const cases = [
    ['disabled with inputs', { INIT_ENABLED: 'false', INIT_BUCKET: 'documents' }],
    ['file with facade inputs', { INIT_CONFIG_FILE: 'config', INIT_BUCKET: 'documents' }],
    ['password and password file', { INIT_ADMIN_PASSWORD: password, INIT_ADMIN_PASSWORD_FILE: 'absent' }],
    ['secret and secret file', { INIT_BUCKET: 'documents', INIT_S3_ACCESS_KEY: 'TESTKEY', INIT_S3_SECRET_KEY: suppliedSecret, INIT_S3_SECRET_KEY_FILE: 'absent' }],
    ['invalid access key', { INIT_BUCKET: 'documents', INIT_S3_ACCESS_KEY: 'contains spaces' }],
    ['invalid quota', { INIT_BUCKET: 'documents', INIT_BUCKET_QUOTA_BYTES: 'not-a-number' }],
    ['invalid prefix JSON', { INIT_BUCKET: 'documents', INIT_BUCKET_READ_PREFIXES: 'public/' }],
    ['missing secret file', { INIT_ADMIN_PASSWORD_FILE: 'absent' }],
    ['malformed JSON', { INIT_CONFIG_FILE: 'broken' }],
  ];
  for (const [name, input] of cases) await t.test(name, async t => {
    const f = await fixture(t), env = { ...input };
    const config = (await f.config(validConfig())).INIT_CONFIG_FILE;
    const malformed = join(f.root, 'broken.json'); await writeFile(malformed, '{"version":');
    for (const [key, value] of Object.entries(env)) if (value === 'absent') env[key] = join(f.root, 'does-not-exist');
    if (env.INIT_CONFIG_FILE === 'config') env.INIT_CONFIG_FILE = config;
    if (env.INIT_CONFIG_FILE === 'broken') env.INIT_CONFIG_FILE = malformed;
    const beforeAuth = f.auth.exportState(), beforeStorage = f.storage.exportState();
    await assert.rejects(f.initialize(env));
    assert.deepEqual(f.auth.exportState(), beforeAuth);
    assert.deepEqual(f.storage.exportState(), beforeStorage);
  });
});

test('completed initialization never replays changed or deleted configuration, resets accounts, or resurrects removed keys', async t => {
  const f = await fixture(t), env = await f.config(validConfig());
  await f.initialize(env);
  const initialKey = f.auth.listKeys()[0];
  await f.auth.changePassword('owner', { currentPassword: password, password: 'administrator-changed-password' }, 'change-password');
  f.auth.revokeKey(initialKey.id);
  await f.storage.putObject('documents', 'retained', body('keep me'), { owner: 'owner' });
  await f.storage.setBucketQuota('documents', { maxBytes: 50, maxObjects: 3 });
  await new BucketPolicies(f).set('documents', { mode: 'public-read', readPrefixes: ['retained'] });
  await rm(join(f.dataDir, 'init-credentials.json'));
  await f.restart();
  const beforeAuth = f.auth.exportState(), beforeStorage = f.storage.exportState();
  await writeFile(env.INIT_CONFIG_FILE, '{broken changed config');
  assert.equal((await f.initialize(env)).status, 'skipped');
  await rm(env.INIT_CONFIG_FILE);
  assert.equal((await f.initialize(env)).status, 'skipped');
  assert.deepEqual(f.auth.exportState(), beforeAuth);
  assert.deepEqual(f.storage.exportState(), beforeStorage);
  assert.equal((await f.auth.login({ username: 'owner', password: 'administrator-changed-password' }, 'restart-login')).role, 'admin');
  assert.equal(f.auth.lookupKey(initialKey.accessKey), null);
  await assert.rejects(readFile(join(f.dataDir, 'init-credentials.json')), { code: 'ENOENT' });
});

test('pre-existing accounts and data skip initialization before attempting to read missing configuration', async t => {
  const f = await fixture(t);
  await f.auth.createUser({ username: 'existing-owner', password, role: 'admin' });
  await f.storage.createBucket('existing-data');
  await f.storage.putObject('existing-data', 'important', body('preserved'), { owner: 'existing-owner' });
  const key = f.auth.createKey({ label: 'existing client', owner: 'existing-owner' });
  const beforeAuth = f.auth.exportState(), beforeStorage = f.storage.exportState();
  assert.equal((await f.initialize({ INIT_CONFIG_FILE: join(f.root, 'absent.json') })).status, 'skipped');
  assert.deepEqual(f.auth.exportState(), beforeAuth);
  assert.deepEqual(f.storage.exportState(), beforeStorage);
  assert.ok(f.auth.lookupKey(key.accessKey).secretKey === key.secretKey, 'existing key must retain its secret');
  assert.equal(f.auth.preference('initialBootstrap', null), null);
});

test('pending initialization resumes after restart without inputs or replacement of generated credentials', async t => {
  const f = await fixture(t), config = validConfig();
  delete config.users[0].password;
  const env = await f.config(config), failure = new Error('simulated shutdown before bucket settings');
  f.storage.setBucketQuota = async () => { throw failure; };
  await assert.rejects(f.initialize(env), error => error === failure || error.message.includes(failure.message));
  const pending = f.auth.preference('initialBootstrap', null);
  assert.equal(pending.status, 'pending');
  assert.equal(typeof pending.credentials, 'string');
  const original = JSON.parse(f.auth.decrypt(pending.credentials));
  await noPlaintextInDatabase(f, [...original.users.map(user => user.password), ...original.keys.map(key => key.secretKey)]);
  await rm(env.INIT_CONFIG_FILE);
  await f.restart();
  assert.equal((await f.initialize(env)).status, 'resumed');
  assert.ok(JSON.stringify(await credentials(f)) === JSON.stringify(original), 'resume must preserve the exact initial credential file');
  assert.equal(f.auth.preference('initialBootstrap', null).status, 'done');
  assert.equal(Object.hasOwn(f.auth.preference('initialBootstrap', null), 'credentials'), false);
  assert.equal(f.auth.listUsers().length, 1);
  assert.equal(f.auth.listKeys().length, 1);
  const bucket = (await f.storage.buckets())[0];
  assert.equal(bucket.quotaBytes, 100);
  assert.equal(bucket.quotaObjects, 5);
  assert.equal((await f.auth.login({ username: original.users[0].username, password: original.users[0].password }, 'resumed-login')).role, 'admin');
  assert.ok(f.auth.lookupKey(original.keys[0].accessKey).secretKey === original.keys[0].secretKey, 'resumed keys must keep their original generated secret');
});

test('resume preserves an existing credential file and removes only matching regular UUID temporary copies', async t => {
  const f = await fixture(t), failure = new Error('simulated shutdown after credentials output');
  const savePreference = f.auth.setPreference.bind(f.auth);
  f.auth.setPreference = (key, value) => {
    if (key === 'initialBootstrap' && value.status === 'done') throw failure;
    return savePreference(key, value);
  };
  await assert.rejects(f.initialize({ INIT_ENABLED: 'true', INIT_BUCKET: 'documents' }), error => error === failure);
  assert.equal(f.auth.preference('initialBootstrap', null).status, 'pending');
  const outputPath = join(f.dataDir, 'init-credentials.json');
  const original = await readFile(outputPath), identity = await stat(outputPath);
  const matchingOrphan = `${outputPath}.${randomUUID()}.tmp`;
  const partialOrphan = `${outputPath}.${randomUUID()}.tmp`;
  const differingOrphan = `${outputPath}.${randomUUID()}.tmp`;
  const unrelatedFile = `${outputPath}.manual-backup.tmp`;
  const symlinkPath = `${outputPath}.${randomUUID()}.tmp`, symlinkTarget = join(f.root, 'preserved-target');
  const different = Buffer.from(original); different[different.length - 1] = 0x20;
  await writeFile(matchingOrphan, original, { mode: 0o600 });
  await writeFile(partialOrphan, original.subarray(0, Math.floor(original.length / 2)), { mode: 0o600 });
  await writeFile(differingOrphan, different, { mode: 0o600 });
  await writeFile(unrelatedFile, original, { mode: 0o600 });
  await writeFile(symlinkTarget, original, { mode: 0o600 });
  await symlink(symlinkTarget, symlinkPath);

  await f.restart();
  assert.equal((await f.initialize({ INIT_CONFIG_FILE: join(f.root, 'unavailable.json') })).status, 'resumed');
  assert.ok((await readFile(outputPath)).equals(original), 'the existing credential bytes must not change during resume');
  assert.equal((await stat(outputPath)).ino, identity.ino, 'resume must keep the existing output file');
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  await assert.rejects(lstat(matchingOrphan), { code: 'ENOENT' });
  await assert.rejects(lstat(partialOrphan), { code: 'ENOENT' });
  assert.ok((await readFile(differingOrphan)).equals(different), 'different temporary contents must not be removed');
  assert.ok((await readFile(unrelatedFile)).equals(original), 'unrelated filenames must not be removed');
  assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true, 'cleanup must not remove or follow symlinks');
  assert.equal(await readlink(symlinkPath), symlinkTarget);
  assert.ok((await readFile(symlinkTarget)).equals(original), 'symlink targets must remain untouched');
  const done = f.auth.preference('initialBootstrap', null);
  assert.equal(done.status, 'done');
  assert.equal(Object.hasOwn(done, 'credentials'), false);
  const saved = JSON.parse(original);
  assert.equal(f.auth.listUsers().length, 1);
  assert.equal(f.auth.listKeys().length, 1);
  assert.equal((await f.auth.login({ username: saved.users[0].username, password: saved.users[0].password }, 'existing-output-login')).role, 'admin');
  assert.ok(f.auth.lookupKey(saved.keys[0].accessKey).secretKey === saved.keys[0].secretKey, 'the preserved credential pair must remain usable');
});

const digest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
function signature(endpoint, method, path, key, value = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = digest(value), host = new URL(endpoint).host, names = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `${method}\n${path}\n\nhost:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n\n${names}\n${hash}`;
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretKey}`, date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  return { 'x-amz-date': date, 'x-amz-content-sha256': hash,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).toString('hex')}` };
}

test('createApp initializes before serving real login, signed S3 operations and prefix-limited public reads', async t => {
  const root = await directory(), dataDir = join(root, 'data');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await createApp({ dataDir, initEnv: { INIT_ADMIN_USERNAME: 'owner', INIT_ADMIN_PASSWORD: password,
    INIT_BUCKET: 'documents', INIT_BUCKET_ACCESS: 'public-read', INIT_BUCKET_READ_PREFIXES: '["public/"]',
    INIT_S3_ACCESS_KEY: 'BOOTSTRAP-S3-KEY', INIT_S3_SECRET_KEY: suppliedSecret } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${endpoint}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: endpoint }, body: JSON.stringify({ username: 'owner', password }) });
  assert.equal(login.status, 200);
  assert.ok(login.headers.get('set-cookie'));
  const key = { accessKey: 'BOOTSTRAP-S3-KEY', secretKey: suppliedSecret };
  for (const path of ['/documents/public/hello.txt', '/documents/private/hello.txt']) {
    const response = await fetch(endpoint + path, { method: 'PUT', headers: signature(endpoint, 'PUT', path, key, 'hello'), body: 'hello' });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const signed = await fetch(`${endpoint}/documents/private/hello.txt`, { headers: signature(endpoint, 'GET', '/documents/private/hello.txt', key) });
  assert.equal(signed.status, 200); assert.equal(await signed.text(), 'hello');
  const anonymous = await fetch(`${endpoint}/documents/public/hello.txt`);
  assert.equal(anonymous.status, 200); assert.equal(await anonymous.text(), 'hello');
  for (const [method, path] of [['GET', '/documents/private/hello.txt'], ['GET', '/documents?list-type=2'], ['GET', '/'], ['HEAD', '/documents']]) {
    const response = await fetch(endpoint + path, { method });
    assert.equal(response.status, 403, 'public reads must not allow private paths or anonymous enumeration');
    await response.arrayBuffer();
  }
  const outside = await fetch(`${endpoint}/another-bucket/key`, { method: 'PUT', headers: signature(endpoint, 'PUT', '/another-bucket/key', key, 'x'), body: 'x' });
  assert.equal(outside.status, 403); await outside.arrayBuffer();
});

test('--init-only finishes without binding a listener and logs no passwords or S3 secrets', async t => {
  const root = await directory(), dataDir = join(root, 'data');
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, DATA_DIR: dataDir, INIT_ENABLED: 'true', INIT_BUCKET: 'documents',
    HOST: 'not-a-valid-hostname.invalid', PORT: 'not-a-port' };
  // An ordinary server start rejects this port. Successful exit proves the
  // one-shot path never reaches the listener setup or leaves maintenance alive.
  const result = await run(process.execPath, ['src/server.mjs', '--init-only'], { cwd: new URL('..', import.meta.url), env, timeout: 15000 });
  const saved = JSON.parse(await readFile(join(dataDir, 'init-credentials.json'), 'utf8'));
  for (const secret of [...saved.users.map(user => user.password), ...saved.keys.map(key => key.secretKey)]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), 'CLI output must not expose generated credentials');
  }
  assert.match(result.stdout, /initialization complete/i);
  const again = await createApp({ dataDir, initOnly: true, initEnv: { INIT_CONFIG_FILE: join(root, 'deleted.json') } });
  try { assert.equal(again.server.listening, false); assert.equal(again.auth.listUsers().length, 1); assert.equal(again.auth.listKeys().length, 1); }
  finally { await again.close(); }
});

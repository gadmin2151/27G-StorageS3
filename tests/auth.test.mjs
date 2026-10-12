import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Auth, DEFAULT_ADMIN_PASSWORD, KEY_PERMISSIONS } from '../src/auth.mjs';

const password = 'a-secure-test-password';
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-auth-users-'));
  const f = { dataDir, auth: new Auth({ dataDir }) };
  t.after(async () => { f.auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  await f.auth.initializeDefaults();
  await f.auth.changePassword('admin', { currentPassword: DEFAULT_ADMIN_PASSWORD, password }, 'setup');
  return f;
}
function request(session) { return { headers: { cookie: `storeges3_session=${session.token}` } }; }
// Independent RFC 6238 calculation, not the implementation's private helpers.
function code(secret, when = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bitString = '';
  for (const character of secret) bitString += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(bitString.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(when / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('users preserve one enabled administrator, enforce disable and invalidate sessions', async t => {
  const { auth } = await fixture(t);
  await assert.rejects(auth.updateUser('admin', { enabled: false }), e => e.status === 409);
  await assert.rejects(auth.updateUser('admin', { role: 'viewer' }), e => e.status === 409);
  await auth.createUser({ username: 'operator', password, role: 'operator', quotaBytes: 1000, quotaObjects: 5 });
  const login = await auth.login({ username: 'operator', password }, 'user');
  assert.equal(login.role, 'operator');
  assert.equal(auth.session(request(login)).role, 'operator');
  assert.equal(auth.userPolicy('operator').quotaBytes, 1000);
  const key = auth.createKey({ label: 'operator app' }, { owner: 'operator' });
  assert.equal(auth.lookupKey(key.accessKey).owner, 'operator');
  await auth.updateUser('operator', { role: 'viewer' });
  assert.equal(auth.session(request(login)), null);
  assert.deepEqual(auth.lookupKey(key.accessKey).permissions, ['read', 'list']);
  await auth.updateUser('operator', { enabled: false });
  assert.equal(auth.lookupKey(key.accessKey), null);
  await assert.rejects(auth.login({ username: 'operator', password }, 'disabled'), e => e.status === 401);
  await auth.updateUser('operator', { enabled: true, role: 'admin' });
  const results = await Promise.allSettled([auth.updateUser('admin', { role: 'viewer', password: password + '-new' }), auth.updateUser('operator', { role: 'viewer', password: password + '-new' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(auth.listUsers().filter(user => user.enabled && user.role === 'admin').length, 1);
  assert.ok(!JSON.stringify(auth.listUsers()).includes('password'));
});

test('granular keys persist owner and restrictions, expire, and limit viewer permissions', async t => {
  const { auth } = await fixture(t);
  await auth.createUser({ username: 'viewer', password, role: 'viewer' });
  const key = auth.createKey({ label: 'photos only', buckets: ['photos'], prefixes: ['public/'], permissions: ['read', 'list'], expiresAt: new Date(Date.now() + 3600_000).toISOString() }, { owner: 'viewer' });
  assert.deepEqual(auth.lookupKey(key.accessKey).prefixes, ['public/']);
  assert.deepEqual(auth.lookupKey(key.accessKey).buckets, ['photos']);
  assert.equal(auth.listKeys('admin').length, 0);
  assert.equal(auth.listKeys('viewer').length, 1);
  assert.ok(!JSON.stringify(auth.listKeys()).includes(key.secretKey));
  assert.throws(() => auth.revokeKey(key.id, 'admin'), e => e.status === 404);
  assert.throws(() => auth.createKey({ label: 'cannot write' }, { owner: 'viewer' }), e => e.status === 403);
  assert.throws(() => auth.createKey({ label: 'unsafe prefix', prefixes: ['public/'], permissions: ['deleteBucket'] }), e => e.status === 400);
  assert.throws(() => auth.createKey({ label: 'readonly', role: 'readonly', permissions: ['write'] }), e => e.status === 400);
  assert.throws(() => auth.createKey({ label: 'unknown', permissions: ['unknown'] }), e => e.status === 400);
  assert.throws(() => auth.createKey({ label: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() }), e => e.status === 400);
  const unrestricted = auth.createKey({ label: 'all' });
  assert.deepEqual(auth.lookupKey(unrestricted.accessKey).permissions, KEY_PERMISSIONS);
  auth.db.prepare('UPDATE access_keys SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', key.id);
  assert.equal(auth.lookupKey(key.accessKey), null);
  auth.revokeKey(key.id, 'viewer');
  assert.equal(auth.listKeys('viewer').length, 0);
});

test('MFA requires possession, encrypts secret, rejects replays and consumes recovery once across restart', async t => {
  const f = await fixture(t); let now = 1_900_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const session = f.auth.newSession('admin');
  await assert.rejects(f.auth.beginMfaEnrollment('admin', { currentPassword: 'wrong' }, 'mfa'), e => e.status === 403);
  const enrollment = await f.auth.beginMfaEnrollment('admin', { currentPassword: password }, 'mfa');
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(f.auth.mfaStatus('admin').enabled, false);
  assert.throws(() => f.auth.confirmMfaEnrollment('admin', { code: 'wrong' }, 'mfa'), e => e.status === 400);
  const { recoveryCodes } = f.auth.confirmMfaEnrollment('admin', { code: code(enrollment.secret) }, 'mfa');
  assert.equal(recoveryCodes.length, 10);
  assert.equal(f.auth.session(request(session)), null);
  assert.deepEqual(f.auth.mfaStatus('admin'), { enabled: true, recoveryCodesRemaining: 10 });
  const stored = f.auth.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  assert.ok(!JSON.stringify(stored).includes(enrollment.secret));
  assert.ok(!JSON.stringify(stored).includes(recoveryCodes[0]));
  await assert.rejects(f.auth.login({ username: 'admin', password }, 'mfa-login'), e => e.code === 'MFA_REQUIRED');
  await assert.rejects(f.auth.login({ username: 'admin', password, code: code(enrollment.secret) }, 'mfa-login'), e => e.status === 401);
  now += 30_000;
  assert.equal((await f.auth.login({ username: 'admin', password, code: code(enrollment.secret) }, 'mfa-login')).role, 'admin');
  await assert.rejects(f.auth.login({ username: 'admin', password, code: code(enrollment.secret) }, 'mfa-login'), e => e.status === 401);
  assert.equal((await f.auth.login({ username: 'admin', password, code: recoveryCodes[0] }, 'mfa-login')).user, 'admin');
  f.auth.close(); f.auth = new Auth({ dataDir: f.dataDir });
  await assert.rejects(f.auth.login({ username: 'admin', password, code: recoveryCodes[0] }, 'recovery'), e => e.status === 401);
  await assert.rejects(f.auth.login({ username: 'admin', password, code: code(enrollment.secret) }, 'recovery'), e => e.status === 401);
  assert.equal(f.auth.mfaStatus('admin').recoveryCodesRemaining, 9);
  await assert.rejects(f.auth.disableMfa('admin', { currentPassword: password, code: '123' }, 'disable'), e => e.status === 403);
  await f.auth.disableMfa('admin', { currentPassword: password, code: recoveryCodes[1] }, 'disable');
  assert.deepEqual(f.auth.mfaStatus('admin'), { enabled: false, recoveryCodesRemaining: 0 });
  assert.equal((await f.auth.login({ username: 'admin', password }, 'disabled-mfa')).user, 'admin');
});

test('MFA enrollment expires, account changes invalidate it, and attempts are rate limited', async t => {
  const { auth } = await fixture(t); let now = 1_900_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const expired = await auth.beginMfaEnrollment('admin', { currentPassword: password }, 'enroll');
  now += 601_000;
  assert.throws(() => auth.confirmMfaEnrollment('admin', { code: code(expired.secret) }, 'enroll'), e => e.status === 409);
  const fresh = await auth.beginMfaEnrollment('admin', { currentPassword: password }, 'enroll');
  await auth.updateUser('admin', { password: password + '-updated' });
  assert.throws(() => auth.confirmMfaEnrollment('admin', { code: code(fresh.secret) }, 'enroll'), e => e.status === 409);
  now += 61_000;
  const pending = await auth.beginMfaEnrollment('admin', { currentPassword: password + '-updated' }, 'enroll');
  for (let i = 0; i < 7; i++) assert.throws(() => auth.confirmMfaEnrollment('admin', { code: 'not-a-code' }, `distributed-${i}`), e => e.status === 400);
  assert.throws(() => auth.confirmMfaEnrollment('admin', { code: code(pending.secret) }, 'another-ip'), e => e.status === 429);
});

test('auth snapshot restores metadata atomically, rejects another master, and invalidates sessions', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.auth.createUser({ username: 'worker', password, role: 'operator', quotaBytes: 0, quotaObjects: 4 });
  const key = first.auth.createKey({ label: 'snapshot-key' }, { owner: 'worker' });
  const state = first.auth.exportState();
  const session = first.auth.newSession('admin');
  await first.auth.updateUser('worker', { enabled: false });
  first.auth.importState(state);
  assert.equal(first.auth.session(request(session)), null);
  assert.equal(first.auth.lookupKey(key.accessKey).secretKey, key.secretKey);
  assert.deepEqual(first.auth.userPolicy('worker').quotaBytes, 0);
  const before = second.auth.exportState();
  assert.throws(() => second.auth.importState(state));
  assert.deepEqual(second.auth.exportState(), before);
  const invalid = structuredClone(state); invalid.users.forEach(user => { user.enabled = 0; });
  assert.throws(() => first.auth.importState(invalid), /active administrator/);
  assert.equal(first.auth.userPolicy('admin').enabled, true);
  await assert.rejects(first.auth.updateUser('worker', { quotaBytes: -1 }), e => e.status === 400);
  await assert.rejects(first.auth.updateUser('worker', { quotaObjects: 0.5 }), e => e.status === 400);
});

test('legacy two-column users and access keys migrate without replacing credentials', async t => {
  const original = await fixture(t);
  const digest = original.auth.db.prepare('SELECT password FROM users WHERE username=?').get('admin').password;
  const dataDir = await mkdtemp(join(tmpdir(), '27g-auth-legacy-'));
  const db = new DatabaseSync(join(dataDir, 'auth.sqlite'));
  db.exec('CREATE TABLE users (username TEXT PRIMARY KEY,password TEXT NOT NULL)');
  db.prepare('INSERT INTO users VALUES (?,?)').run('old-owner', digest); db.close();
  const auth = new Auth({ dataDir });
  t.after(async () => { auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  await auth.initializeDefaults();
  assert.equal((await auth.login({ username: 'old-owner', password }, 'legacy')).role, 'admin');
  assert.equal(auth.defaultCredentials, false);
  assert.equal(auth.userPolicy('admin'), null);
  const key = auth.createKey({ label: 'legacy' });
  assert.equal(auth.lookupKey(key.accessKey).owner, 'old-owner');
});

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
export const USER_ROLES = ['admin', 'operator', 'viewer'];
export const KEY_PERMISSIONS = ['read', 'list', 'write', 'delete', 'createBucket', 'deleteBucket'];
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += base32Alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decodeBase32(secret) {
  let bits = 0, value = 0; const bytes = [];
  for (const c of secret) { const n = base32Alphabet.indexOf(c); if (n < 0) throw new Error('Invalid MFA secret'); value = (value << 5) | n; bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(bytes);
}
function totp(secret, step) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function quota(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, `${name}: требуется целое неотрицательное число или null.`);
  return value;
}
function publicUser(row) {
  return { username: row.username, role: row.role, enabled: !!row.enabled, quotaBytes: row.quota_bytes, quotaObjects: row.quota_objects, mfaEnabled: !!row.mfa_secret };
}
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'admin!123';
export const equal = (a, b) => {
  const aa = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requirePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024)
    throw new ApiError(400, 'Пароль должен содержать от 12 до 1024 байт.');
}
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const digest = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${digest.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const salt = stored.split(':')[0];
  return equal(await passwordHash(password, salt), stored);
}

export class Auth {
  constructor({ dataDir, setupToken, secureCookies = false }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.secureCookies = secureCookies;
    const masterPath = join(dataDir, 'master.key');
    try { this.masterKey = readFileSync(masterPath); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.masterKey = randomBytes(32);
      writeFileSync(masterPath, this.masterKey, { flag: 'wx', mode: 0o600, flush: true });
    }
    if (this.masterKey.length !== 32) throw new Error('Invalid master.key: expected 32 bytes');
    chmodSync(masterPath, 0o600);
    this.db = new DatabaseSync(join(dataDir, 'auth.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_keys (id TEXT PRIMARY KEY, access_key TEXT UNIQUE NOT NULL,
        secret TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL, buckets TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Additive migration preserves old passwords, keys, and factory protection.
    const migrate = (table, fields) => {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const [name, declaration] of Object.entries(fields)) if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    };
    migrate('users', { role: "TEXT NOT NULL DEFAULT 'admin'", enabled: 'INTEGER NOT NULL DEFAULT 1', quota_bytes: 'INTEGER', quota_objects: 'INTEGER', mfa_secret: 'TEXT', mfa_last_step: 'INTEGER NOT NULL DEFAULT -1', recovery_hashes: "TEXT NOT NULL DEFAULT '[]'" });
    migrate('access_keys', { owner: 'TEXT', prefixes: "TEXT NOT NULL DEFAULT '[]'", permissions: 'TEXT', expires_at: 'TEXT' });
    const legacyOwner = this.db.prepare("SELECT username FROM users WHERE role='admin' AND enabled=1 ORDER BY username LIMIT 1").get();
    if (legacyOwner) this.db.prepare('UPDATE access_keys SET owner=? WHERE owner IS NULL').run(legacyOwner.username);
    chmodSync(join(dataDir, 'auth.sqlite'), 0o600);
    this.sessions = new Map(); this.attempts = new Map(); this.pendingMfa = new Map(); this.busy = 0;
    const tokenPath = join(dataDir, 'setup.token');
    if (setupToken && (typeof setupToken !== 'string' || setupToken.length < 24)) throw new Error('SETUP_TOKEN must contain at least 24 characters');
    try { this.setupToken = setupToken || readFileSync(tokenPath, 'utf8').trim(); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.setupToken = randomBytes(32).toString('base64url');
      writeFileSync(tokenPath, this.setupToken, { mode: 0o600, flag: 'wx', flush: true });
    }
    if (this.setupToken.length < 24 || this.setupToken.length > 512) { this.db.close(); throw new Error('Invalid setup.token: expected 24–512 characters'); }
    try { chmodSync(tokenPath, 0o600); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    this.dummyHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
  }
  get defaultCredentials() { return this.preference('defaultCredentials', false) === true; }
  async initializeDefaults() {
    if (this.db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
    const digest = await passwordHash(DEFAULT_ADMIN_PASSWORD);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Initialization must never replace an existing administrator or password.
      if (!this.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
        this.db.prepare('INSERT INTO users (username,password) VALUES (?, ?)').run(DEFAULT_ADMIN_USERNAME, digest);
        this.setPreference('defaultCredentials', true);
        this.audit('admin.default_created', DEFAULT_ADMIN_USERNAME);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  encrypt(secret) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value) {
    const b = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.masterKey, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString();
  }
  throttle(ip) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until < now) this.attempts.delete(key);
    let entry = this.attempts.get(ip);
    if (!entry) {
      if (this.attempts.size >= 10000) throw new ApiError(429, 'Слишком много запросов. Повторите позже.');
      entry = { count: 0, until: now + 60_000 }; this.attempts.set(ip, entry);
    }
    if (++entry.count > 8 || this.busy >= 4) throw new ApiError(429, 'Слишком много попыток входа. Подождите минуту.');
  }
  async login({ username, password, setupToken, code }, ip, { allowDefaultWithoutToken = false } = {}) {
    this.throttle(ip);
    if (typeof username === 'string') this.throttle(`account:${username.slice(0, 100)}`);
    const row = typeof username === 'string' ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    this.busy++;
    let verified;
    try { verified = await verifyPassword(password, row?.password || this.dummyHash); } finally { this.busy--; }
    const current = row && this.db.prepare('SELECT * FROM users WHERE username = ?').get(row.username);
    if (!row || !verified || !current?.enabled || current.password !== row.password) {
      this.audit('admin.login_failed', ip); throw new ApiError(401, 'Неверный логин или пароль.');
    }
    if (this.defaultCredentials && row.username === DEFAULT_ADMIN_USERNAME && !allowDefaultWithoutToken && !equal(setupToken, this.setupToken)) {
      this.audit('admin.login_failed', ip);
      throw new ApiError(403, 'Для входа со стандартным паролем нужен токен первоначальной настройки из журнала сервера.');
    }
    if (current.mfa_secret) {
      if (!code) { const error = new ApiError(401, 'Введите код приложения-аутентификатора или код восстановления.'); error.code = 'MFA_REQUIRED'; throw error; }
      if (!this._consumeMfa(current, code)) { this.audit('mfa.failed', row.username); throw new ApiError(401, 'Неверный или уже использованный код MFA.'); }
    }
    this.audit('admin.login', row.username);
    return this.newSession(row.username);
  }
  newSession(user) {
    const account = this.userPolicy(user);
    if (!account?.enabled) throw new ApiError(403, 'Учётная запись отключена.');
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expires < now) this.sessions.delete(id);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const session = { user, role: account.role, csrf: randomBytes(32).toString('base64url'), expires: now + 8 * 3600_000 };
    this.sessions.set(hash(token), session);
    return { token, ...session };
  }
  cookie(token, clear = false) {
    return `storeges3_session=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${clear ? 0 : 8 * 3600}${this.secureCookies ? '; Secure' : ''}`;
  }
  session(req) {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('storeges3_session='))?.slice(18);
    if (!token) return null;
    const id = hash(token), session = this.sessions.get(id);
    if (!session) return null;
    if (session.expires < Date.now()) { this.sessions.delete(id); return null; }
    const user = this.userPolicy(session.user);
    if (!user?.enabled) { this.sessions.delete(id); return null; }
    return { ...session, role: user.role, id };
  }
  requireSession(req, mutation = false) {
    const session = this.session(req);
    if (!session) throw new ApiError(401, 'Войдите в панель управления.');
    if (mutation && !equal(req.headers['x-csrf-token'], session.csrf)) throw new ApiError(403, 'Запрос отклонён: неверный CSRF-токен. Обновите страницу.');
    return session;
  }
  logout(req) { const session = this.session(req); if (session) this.sessions.delete(session.id); }
  async changePassword(user, { currentPassword, password }, ip) {
    this.throttle(ip); requirePassword(password);
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(user);
    this.busy++;
    try {
      if (!row || !await verifyPassword(currentPassword, row.password)) throw new ApiError(403, 'Текущий пароль неверен.');
      const digest = await passwordHash(password);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = this.db.prepare('UPDATE users SET password = ? WHERE username = ? AND password = ?').run(digest, user, row.password);
        if (!result.changes) throw new ApiError(409, 'Пароль уже изменён. Войдите в панель заново.');
        if (user === DEFAULT_ADMIN_USERNAME) this.setPreference('defaultCredentials', false);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } finally { this.busy--; }
    this._revokeSessions(user); this.audit('admin.password_changed', user);
    return this.newSession(user);
  }
  _revokeSessions(user) {
    for (const [id, session] of this.sessions) if (session.user === user) this.sessions.delete(id);
    this.pendingMfa.delete(user);
  }
  userPolicy(username) {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    return row ? publicUser(row) : null;
  }
  listUsers() { return this.db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser); }
  async createUser({ username, password, role = 'viewer', quotaBytes = null, quotaObjects = null }) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$/.test(username)) throw new ApiError(400, 'Логин: 3–80 латинских букв, цифр, точек, дефисов, @ или _.');
    requirePassword(password);
    if (!USER_ROLES.includes(role)) throw new ApiError(400, 'Неверная роль пользователя.');
    const bytes = quota(quotaBytes, 'Квота объёма'), objects = quota(quotaObjects, 'Квота объектов');
    if (this.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new ApiError(409, 'Такой пользователь уже существует.');
    if (this.listUsers().length >= 1000) throw new ApiError(409, 'Достигнут лимит в 1000 пользователей.');
    const digest = await passwordHash(password);
    // Re-check after scrypt: another request may have created the same account.
    if (this.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new ApiError(409, 'Такой пользователь уже существует.');
    if (this.listUsers().length >= 1000) throw new ApiError(409, 'Достигнут лимит в 1000 пользователей.');
    this.db.prepare('INSERT INTO users (username,password,role,quota_bytes,quota_objects) VALUES (?,?,?,?,?)').run(username, digest, role, bytes, objects);
    this.audit('user.created', username); return this.userPolicy(username);
  }
  async updateUser(username, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ApiError(400, 'Неверные настройки пользователя.');
    if (changes.role !== undefined && !USER_ROLES.includes(changes.role)) throw new ApiError(400, 'Неверная роль пользователя.');
    if (changes.enabled !== undefined && typeof changes.enabled !== 'boolean') throw new ApiError(400, 'enabled должен быть boolean.');
    if (changes.password !== undefined) requirePassword(changes.password);
    const bytes = changes.quotaBytes === undefined ? undefined : quota(changes.quotaBytes, 'Квота объёма');
    const objects = changes.quotaObjects === undefined ? undefined : quota(changes.quotaObjects, 'Квота объектов');
    const digest = changes.password === undefined ? undefined : await passwordHash(changes.password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!row) throw new ApiError(404, 'Пользователь не найден.');
      const role = changes.role ?? row.role, enabled = changes.enabled === undefined ? row.enabled : Number(changes.enabled);
      if (row.role === 'admin' && row.enabled && (role !== 'admin' || !enabled) && this.db.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND enabled=1").get().count <= 1)
        throw new ApiError(409, 'Нельзя отключить или понизить роль последнего активного администратора.');
      this.db.prepare('UPDATE users SET password=?,role=?,enabled=?,quota_bytes=?,quota_objects=? WHERE username=?').run(digest ?? row.password, role, enabled, bytes === undefined ? row.quota_bytes : bytes, objects === undefined ? row.quota_objects : objects, username);
      if (digest && username === DEFAULT_ADMIN_USERNAME) this.setPreference('defaultCredentials', false);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this._revokeSessions(username); this.audit('user.updated', username); return this.userPolicy(username);
  }
  mfaStatus(user) {
    const row = this.db.prepare('SELECT mfa_secret,recovery_hashes FROM users WHERE username=?').get(user);
    if (!row) throw new ApiError(404, 'Пользователь не найден.');
    return { enabled: !!row.mfa_secret, recoveryCodesRemaining: JSON.parse(row.recovery_hashes).length };
  }
  async beginMfaEnrollment(user, { currentPassword }, ip) {
    this.throttle(`mfa:${ip}`); this.throttle(`mfa-account:${user}`);
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(user);
    this.busy++;
    let verified;
    try { verified = await verifyPassword(currentPassword, row?.password || this.dummyHash); } finally { this.busy--; }
    const current = this.db.prepare('SELECT * FROM users WHERE username=?').get(user);
    if (!row || !verified || !current?.enabled || current.password !== row.password) throw new ApiError(403, 'Текущий пароль неверен.');
    if (current.mfa_secret) throw new ApiError(409, 'MFA уже включена.');
    for (const [name, pending] of this.pendingMfa) if (pending.expires < Date.now()) this.pendingMfa.delete(name);
    if (this.pendingMfa.size >= 1000 && !this.pendingMfa.has(user)) throw new ApiError(429, 'Слишком много ожидающих настроек MFA.');
    const secret = base32(randomBytes(20)), expires = Date.now() + 10 * 60_000;
    this.pendingMfa.set(user, { secret, expires, password: row.password });
    return { secret, expiresAt: new Date(expires).toISOString(), otpauthUri: `otpauth://totp/${encodeURIComponent(`27G-StorageS3:${user}`)}?secret=${secret}&issuer=27G-StorageS3&algorithm=SHA1&digits=6&period=30` };
  }
  confirmMfaEnrollment(user, { code }, ip) {
    this.throttle(`mfa:${ip}`); this.throttle(`mfa-account:${user}`);
    const pending = this.pendingMfa.get(user), row = this.db.prepare('SELECT * FROM users WHERE username=?').get(user);
    if (!pending || pending.expires <= Date.now() || !row?.enabled || row.password !== pending.password) { this.pendingMfa.delete(user); throw new ApiError(409, 'Настройка MFA истекла. Начните заново.'); }
    if (row.mfa_secret) throw new ApiError(409, 'MFA уже включена.');
    const step = this._totpStep(pending.secret, code);
    if (step === null) throw new ApiError(400, 'Неверный код приложения-аутентификатора.');
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex').match(/.{5}/g).join('-'));
    this.db.prepare('UPDATE users SET mfa_secret=?,mfa_last_step=?,recovery_hashes=? WHERE username=?').run(this.encrypt(pending.secret), step, JSON.stringify(recoveryCodes.map(value => this._recoveryHash(user, value))), user);
    this._revokeSessions(user); this.audit('mfa.enabled', user);
    return { recoveryCodes };
  }
  _totpStep(secret, code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const now = Math.floor(Date.now() / 30_000);
    for (const offset of [0, -1, 1]) if (now + offset >= 0 && equal(totp(secret, now + offset), code)) return now + offset;
    return null;
  }
  _recoveryHash(user, code) { return hash(`${user}\0${String(code).replace(/-/g, '').toLowerCase()}`); }
  _consumeMfa(row, code) {
    if (typeof code !== 'string' || code.length > 128) return false;
    if (/^\d{6}$/.test(code)) {
      const step = this._totpStep(this.decrypt(row.mfa_secret), code);
      if (step === null || step <= row.mfa_last_step) return false;
      return !!this.db.prepare('UPDATE users SET mfa_last_step=? WHERE username=? AND mfa_last_step<? AND mfa_secret=?').run(step, row.username, step, row.mfa_secret).changes;
    }
    if (!/^(?:[a-fA-F0-9]{20}|[a-fA-F0-9]{5}(?:-[a-fA-F0-9]{5}){3})$/.test(code)) return false;
    const hashes = JSON.parse(row.recovery_hashes), candidate = this._recoveryHash(row.username, code), index = hashes.findIndex(value => equal(value, candidate));
    if (index < 0) return false;
    hashes.splice(index, 1);
    return !!this.db.prepare('UPDATE users SET recovery_hashes=? WHERE username=? AND recovery_hashes=? AND mfa_secret=?').run(JSON.stringify(hashes), row.username, row.recovery_hashes, row.mfa_secret).changes;
  }
  async disableMfa(user, { currentPassword, code }, ip) {
    this.throttle(`mfa:${ip}`); this.throttle(`mfa-account:${user}`);
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(user);
    this.busy++; let verified;
    try { verified = await verifyPassword(currentPassword, row?.password || this.dummyHash); } finally { this.busy--; }
    const current = this.db.prepare('SELECT * FROM users WHERE username=?').get(user);
    if (!row || !verified || !current?.enabled || current.password !== row.password) throw new ApiError(403, 'Текущий пароль неверен.');
    if (!current.mfa_secret || !this._consumeMfa(current, code)) throw new ApiError(403, 'Неверный или уже использованный код MFA.');
    this.db.prepare("UPDATE users SET mfa_secret=NULL,mfa_last_step=-1,recovery_hashes='[]' WHERE username=?").run(user);
    this._revokeSessions(user); this.audit('mfa.disabled', user);
    return { enabled: false };
  }
  listKeys(owner) {
    const rows = owner === undefined ? this.db.prepare('SELECT * FROM access_keys ORDER BY created_at DESC').all() : this.db.prepare('SELECT * FROM access_keys WHERE owner=? ORDER BY created_at DESC').all(owner);
    return rows.map(k => ({ id: k.id, accessKey: k.access_key, label: k.label, role: k.role, buckets: JSON.parse(k.buckets), createdAt: k.created_at, owner: k.owner, prefixes: JSON.parse(k.prefixes), permissions: k.permissions ? JSON.parse(k.permissions) : (k.role === 'readonly' ? ['read', 'list'] : [...KEY_PERMISSIONS]), expiresAt: k.expires_at }));
  }
  createKey({ label, role = 'readwrite', buckets = [], prefixes = [], permissions, expiresAt = null, owner: requestedOwner }, { owner } = {}) {
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) throw new ApiError(400, 'Название ключа: от 1 до 100 символов.');
    if (!['readonly', 'readwrite'].includes(role) || !Array.isArray(buckets) || buckets.length > 100 || buckets.some(b => typeof b !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)))
      throw new ApiError(400, 'Неверная роль или список бакетов.');
    if (!Array.isArray(prefixes) || prefixes.length > 100 || prefixes.some(p => typeof p !== 'string' || !p.length || Buffer.byteLength(p) > 1024 || p.includes('\0'))) throw new ApiError(400, 'Неверный список префиксов.');
    permissions ??= role === 'readonly' ? ['read', 'list'] : [...KEY_PERMISSIONS];
    if (!Array.isArray(permissions) || !permissions.length || permissions.length > KEY_PERMISSIONS.length || permissions.some(p => !KEY_PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length) throw new ApiError(400, 'Неверные разрешения ключа.');
    if (role === 'readonly' && permissions.some(p => !['read', 'list'].includes(p))) throw new ApiError(400, 'Ключ только для чтения не может изменять данные.');
    if (prefixes.length && permissions.some(p => ['createBucket', 'deleteBucket'].includes(p))) throw new ApiError(400, 'Ключ с префиксами не может создавать или удалять целые бакеты.');
    if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new ApiError(400, 'Срок действия ключа должен быть в будущем.');
    const keyOwner = owner ?? requestedOwner ?? this.db.prepare("SELECT username FROM users WHERE enabled=1 AND role='admin' ORDER BY username LIMIT 1").get()?.username;
    const account = keyOwner && this.userPolicy(keyOwner);
    if (!account?.enabled) throw new ApiError(400, 'Владелец ключа не найден или отключён.');
    if (account.role === 'viewer' && permissions.some(p => !['read', 'list'].includes(p))) throw new ApiError(403, 'Наблюдатель может иметь только ключи чтения.');
    if (this.listKeys().length >= 1000) throw new ApiError(409, 'Достигнут лимит в 1000 ключей.');
    const id = randomUUID(), accessKey = `G27${randomBytes(10).toString('hex').toUpperCase()}`, secretKey = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO access_keys (id,access_key,secret,label,role,buckets,created_at,owner,prefixes,permissions,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, accessKey, this.encrypt(secretKey), label, role, JSON.stringify(buckets), new Date().toISOString(), keyOwner, JSON.stringify([...new Set(prefixes)]), JSON.stringify(permissions), expiresAt === null ? null : new Date(expiresAt).toISOString());
    this.audit('key.created', `${accessKey} (${role})`);
    return { id, accessKey, secretKey };
  }
  revokeKey(id, owner) {
    const result = owner === undefined ? this.db.prepare('DELETE FROM access_keys WHERE id = ?').run(id) : this.db.prepare('DELETE FROM access_keys WHERE id = ? AND owner=?').run(id, owner);
    if (!result.changes) throw new ApiError(404, 'Ключ не найден.');
    this.audit('key.revoked', id);
  }
  lookupKey(accessKey) {
    const row = this.db.prepare('SELECT * FROM access_keys WHERE access_key = ?').get(accessKey);
    if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return null;
    const owner = this.userPolicy(row.owner);
    if (!owner?.enabled) return null;
    let permissions = row.permissions ? JSON.parse(row.permissions) : row.role === 'readonly' ? ['read', 'list'] : [...KEY_PERMISSIONS];
    if (owner.role === 'viewer') permissions = permissions.filter(p => ['read', 'list'].includes(p));
    return { secretKey: this.decrypt(row.secret), role: owner.role === 'viewer' ? 'readonly' : row.role, buckets: JSON.parse(row.buckets), prefixes: JSON.parse(row.prefixes), permissions, owner: row.owner, expiresAt: row.expires_at };
  }
  // Internal HA/backup API. Contains encrypted secrets and password hashes; never
  // expose it through the public administration API or put it in diagnostics.
  exportState() {
    return { version: 1, users: this.db.prepare('SELECT * FROM users ORDER BY username').all(), accessKeys: this.db.prepare('SELECT * FROM access_keys ORDER BY id').all(), preferences: this.db.prepare('SELECT * FROM preferences ORDER BY key').all(), audit: this.db.prepare('SELECT * FROM audit ORDER BY id').all() };
  }
  importState(state) {
    if (!state || state.version !== 1) throw new Error('Unsupported auth snapshot');
    const tables = [['users', 'users', 1000], ['access_keys', 'accessKeys', 1000], ['preferences', 'preferences', 1000], ['audit', 'audit', 10000]];
    for (const [table, key, limit] of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!Array.isArray(state[key]) || state[key].length > limit) throw new Error('Invalid auth snapshot rows');
      for (const row of state[key]) {
        if (!row || Object.keys(row).length !== columns.length || columns.some(name => !Object.hasOwn(row, name)) || Object.values(row).some(value => value !== null && !['string', 'number'].includes(typeof value))) throw new Error('Invalid auth snapshot columns');
      }
    }
    if (!state.users.some(user => user.role === 'admin' && user.enabled === 1)) throw new Error('Auth snapshot requires an active administrator');
    if (state.users.some(user => !USER_ROLES.includes(user.role) || ![0, 1].includes(user.enabled))) throw new Error('Invalid auth snapshot user');
    for (const user of state.users) {
      quota(user.quota_bytes, 'Snapshot quota'); quota(user.quota_objects, 'Snapshot quota');
      if (user.mfa_secret) this.decrypt(user.mfa_secret); // Reject a different master.key before changing local state.
      if (!Array.isArray(JSON.parse(user.recovery_hashes))) throw new Error('Invalid MFA recovery snapshot');
    }
    const owners = new Set(state.users.map(user => user.username));
    for (const key of state.accessKeys) {
      if (!owners.has(key.owner)) throw new Error('Unknown access key owner in snapshot');
      this.decrypt(key.secret);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, key] of tables) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        this.db.exec(`DELETE FROM ${table}`);
        const statement = this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of state[key]) statement.run(...columns.map(name => row[name]));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.sessions.clear(); this.pendingMfa.clear();
  }
  audit(action, detail = '') {
    this.db.prepare('INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), action, String(detail).slice(0, 1000));
    this.db.prepare('DELETE FROM audit WHERE id <= (SELECT max(id) - 10000 FROM audit)').run();
  }
  events() { return this.db.prepare('SELECT at, action, detail FROM audit ORDER BY id DESC LIMIT 200').all(); }
  eventPage({ page = 1, pageSize = 10 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || ![10, 25, 50].includes(pageSize)) throw new ApiError(400, 'Страница должна быть положительным числом, размер страницы — 10, 25 или 50.');
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM audit').get().total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, totalPages);
    return { events: this.db.prepare('SELECT id, at, action, detail FROM audit ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize), total, page, pageSize, totalPages };
  }
  preference(key, fallback) { const row = this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  setPreference(key, value) { this.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close() { this.sessions.clear(); this.pendingMfa.clear(); this.db.close(); }
}

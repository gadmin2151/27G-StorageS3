import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
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
    chmodSync(join(dataDir, 'auth.sqlite'), 0o600);
    this.sessions = new Map(); this.attempts = new Map(); this.busy = 0;
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
  get setupRequired() { return !this.db.prepare('SELECT 1 FROM users LIMIT 1').get(); }
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
  async setup({ username, password, setupToken }, ip) {
    this.throttle(ip);
    if (!this.setupRequired) throw new ApiError(409, 'Первоначальная настройка уже завершена.');
    if (!equal(setupToken, this.setupToken)) throw new ApiError(403, 'Неверный токен первоначальной настройки.');
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{3,64}$/.test(username)) throw new ApiError(400, 'Логин: 3–64 латинских символа, цифры, _, ., @ или -.');
    requirePassword(password);
    this.busy++;
    let digest;
    try { digest = await passwordHash(password); } finally { this.busy--; }
    if (!this.setupRequired) throw new ApiError(409, 'Первоначальная настройка уже завершена.');
    this.db.prepare('INSERT INTO users VALUES (?, ?)').run(username, digest);
    this.audit('admin.setup', username);
    return this.newSession(username);
  }
  async login({ username, password }, ip) {
    this.throttle(ip);
    const row = typeof username === 'string' ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    this.busy++;
    let verified;
    try { verified = await verifyPassword(password, row?.password || this.dummyHash); } finally { this.busy--; }
    if (!row || !verified) { this.audit('admin.login_failed', ip); throw new ApiError(401, 'Неверный логин или пароль.'); }
    this.audit('admin.login', row.username);
    return this.newSession(row.username);
  }
  newSession(user) {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expires < now) this.sessions.delete(id);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const session = { user, csrf: randomBytes(32).toString('base64url'), expires: now + 8 * 3600_000 };
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
    return { ...session, id };
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
      this.db.prepare('UPDATE users SET password = ? WHERE username = ?').run(digest, user);
    } finally { this.busy--; }
    this.sessions.clear(); this.audit('admin.password_changed', user);
    return this.newSession(user);
  }
  listKeys() {
    return this.db.prepare('SELECT id, access_key AS accessKey, label, role, buckets, created_at AS createdAt FROM access_keys ORDER BY created_at DESC').all().map(k => ({ ...k, buckets: JSON.parse(k.buckets) }));
  }
  createKey({ label, role = 'readwrite', buckets = [] }) {
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) throw new ApiError(400, 'Название ключа: от 1 до 100 символов.');
    if (!['readonly', 'readwrite'].includes(role) || !Array.isArray(buckets) || buckets.length > 100 || buckets.some(b => typeof b !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)))
      throw new ApiError(400, 'Неверная роль или список бакетов.');
    if (this.listKeys().length >= 1000) throw new ApiError(409, 'Достигнут лимит в 1000 ключей.');
    const id = randomUUID(), accessKey = `G27${randomBytes(10).toString('hex').toUpperCase()}`, secretKey = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO access_keys VALUES (?,?,?,?,?,?,?)').run(id, accessKey, this.encrypt(secretKey), label, role, JSON.stringify(buckets), new Date().toISOString());
    this.audit('key.created', `${accessKey} (${role})`);
    return { id, accessKey, secretKey };
  }
  revokeKey(id) {
    const result = this.db.prepare('DELETE FROM access_keys WHERE id = ?').run(id);
    if (!result.changes) throw new ApiError(404, 'Ключ не найден.');
    this.audit('key.revoked', id);
  }
  lookupKey(accessKey) {
    const row = this.db.prepare('SELECT * FROM access_keys WHERE access_key = ?').get(accessKey);
    return row ? { secretKey: this.decrypt(row.secret), role: row.role, buckets: JSON.parse(row.buckets) } : null;
  }
  audit(action, detail = '') {
    this.db.prepare('INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), action, String(detail).slice(0, 1000));
    this.db.prepare('DELETE FROM audit WHERE id <= (SELECT max(id) - 10000 FROM audit)').run();
  }
  events() { return this.db.prepare('SELECT at, action, detail FROM audit ORDER BY id DESC LIMIT 200').all(); }
  preference(key, fallback) { const row = this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  setPreference(key, value) { this.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close() { this.sessions.clear(); this.db.close(); }
}

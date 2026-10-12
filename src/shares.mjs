import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from './auth.mjs';

const hash = token => createHash('sha256').update(token).digest('hex');
const summary = row => ({ id: row.id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() });
export const MAX_ACTIVE_SHARES = 10000;

export class Shares {
  constructor({ dataDir }) {
    this.db = new DatabaseSync(join(dataDir, 'shares.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
        bucket TEXT NOT NULL, object_key TEXT NOT NULL, blob_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shares_expiry ON shares(expires_at);
      CREATE INDEX IF NOT EXISTS shares_object ON shares(bucket, object_key, blob_id);`);
    chmodSync(join(dataDir, 'shares.sqlite'), 0o600);
    this.prune();
  }
  prune() { this.db.prepare('DELETE FROM shares WHERE expires_at <= ?').run(Date.now()); }
  create({ bucket, key, blobId, expiresIn = 3600 }) {
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 604800)
      throw new ApiError(400, 'Срок ссылки: от 60 секунд до 7 дней.');
    this.prune();
    if (this.db.prepare('SELECT COUNT(*) AS count FROM shares').get().count >= MAX_ACTIVE_SHARES)
      throw new ApiError(409, 'Достигнут лимит в 10000 временных ссылок. Отзовите ненужные ссылки.');
    const token = randomBytes(32).toString('base64url');
    const row = { id: randomUUID(), created_at: Date.now() };
    row.expires_at = row.created_at + expiresIn * 1000;
    this.db.prepare('INSERT INTO shares VALUES (?,?,?,?,?,?,?)')
      .run(row.id, hash(token), bucket, key, blobId, row.created_at, row.expires_at);
    // Only the creation response contains the bearer token; the database stores its hash.
    return { ...summary(row), token };
  }
  list(bucket, key, blobId) {
    return this.db.prepare('SELECT id, created_at, expires_at FROM shares WHERE bucket=? AND object_key=? AND blob_id=? AND expires_at>? ORDER BY created_at DESC')
      .all(bucket, key, blobId, Date.now()).map(summary);
  }
  get(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM shares WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    return row || null;
  }
  revoke(id) {
    if (!this.db.prepare('DELETE FROM shares WHERE id=?').run(id).changes)
      throw new ApiError(404, 'Ссылка не найдена.');
  }
  exportState() { return { version: 1, shares: this.db.prepare('SELECT * FROM shares ORDER BY id').all() }; }
  importState(state) {
    if (state?.version !== 1 || !Array.isArray(state.shares) || state.shares.length > MAX_ACTIVE_SHARES) throw new Error('Invalid shares snapshot');
    const columns = ['id', 'token_hash', 'bucket', 'object_key', 'blob_id', 'created_at', 'expires_at'];
    for (const row of state.shares) if (!row || columns.some(column => !Object.hasOwn(row, column)) || !/^[a-f0-9]{64}$/.test(row.token_hash) || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at)) throw new Error('Invalid share snapshot row');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.exec('DELETE FROM shares'); const insert = this.db.prepare('INSERT INTO shares VALUES(?,?,?,?,?,?,?)'); for (const row of state.shares) insert.run(...columns.map(column => row[column])); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

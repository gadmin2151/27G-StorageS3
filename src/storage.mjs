import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink, stat, statfs, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export class StorageError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'StorageError'; this.code = code; this.status = status; }
}
const fail = (code, message, status = 400) => { throw new StorageError(code, message, status); };
export const validBlobId = id => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id);
const clean = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
export async function syncDirectory(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
export async function writeStreamFile(path, source, limit) {
  const fd = await open(path, 'wx', 0o600); const sha = createHash('sha256'); const md5 = createHash('md5'); let size = 0;
  try {
    for await (const part of source) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); size += chunk.length;
      if (size > limit) fail('EntityTooLarge', 'Object exceeds the configured size limit.', 413);
      sha.update(chunk); md5.update(chunk);
      let offset = 0; while (offset < chunk.length) { const result = await fd.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new Error('Short disk write'); offset += result.bytesWritten; }
    }
    await fd.sync(); return { size, sha256: sha.digest('hex'), etag: md5.digest('hex') };
  } catch (error) { await clean(path).catch(() => {}); throw error; } finally { await fd.close(); }
}
async function digestFile(path) {
  const sha = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { sha.update(chunk); size += chunk.length; }
  return { size, sha256: sha.digest('hex') };
}
function validBucket(name) {
  if (['api', 'console', 'healthz'].includes(name)) fail('InvalidBucketName', 'This bucket name is reserved for the control panel.');
  if (typeof name !== 'string' || name.length < 3 || name.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name) || name.includes('..') || name.includes('.-') || name.includes('-.') || /^\d+\.\d+\.\d+\.\d+$/.test(name) || /^(xn--|sthree-|amzn-s3-demo-)/.test(name) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(name)) fail('InvalidBucketName', 'Bucket names must be DNS-compatible, 3–63 lowercase characters.');
}
function validKey(key) { if (typeof key !== 'string' || !key.length || Buffer.byteLength(key) > 1024 || key.includes('\0')) fail('InvalidArgument', 'Object key must contain 1–1024 UTF-8 bytes and no NUL.'); }
const redact = ({ token, ...node }) => node;
const metadata = row => ({ key: row.key, size: Number(row.size), etag: row.etag, sha256: row.sha256, modifiedAt: row.modified_at, contentType: row.content_type });

export class Storage {
  constructor({ dataDir, maxObjectBytes = 5 * 1024 ** 3, cacheBytes = 64 * 1024 ** 2, concurrency = 4, queueLimit = 64 } = {}) {
    if (!dataDir) throw new Error('dataDir is required');
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || !Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > 1024 ** 3 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64 || !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 10000) throw new Error('Invalid storage size, cache or queue limits.');
    this.dataDir = dataDir; this.blobDir = join(dataDir, 'blobs'); this.tempDir = join(dataDir, 'tmp');
    this.maxObjectBytes = maxObjectBytes; this.cacheBytes = cacheBytes; this.concurrency = concurrency; this.queueLimit = queueLimit;
    this.cache = new Map(); this.cacheSize = 0; this.hits = 0; this.misses = 0; this.active = 0; this.pending = []; this.lock = Promise.resolve(); this.readers = new Map(); this.probes = new Map();
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); await chmod(this.dataDir, 0o700);
    await mkdir(this.blobDir, { recursive: true, mode: 0o700 }); await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.dataDir, 'catalog.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (bucket TEXT NOT NULL REFERENCES buckets(name), key TEXT NOT NULL, blob_id TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, sha256 TEXT NOT NULL, modified_at TEXT NOT NULL, content_type TEXT NOT NULL, replicas TEXT NOT NULL, PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS garbage (blob_id TEXT PRIMARY KEY, nodes TEXT NOT NULL, retired_at INTEGER NOT NULL);`);
    await chmod(join(this.dataDir, 'catalog.sqlite'), 0o600);
    const config = this.db.prepare("SELECT value FROM settings WHERE key='topology'").get();
    this.config = config ? JSON.parse(config.value) : { mode: 'raid0', nodes: [{ id: 'local', url: 'local', label: 'Coordinator storage' }] };
    if (!config) this._persist('topology', this.config);
    const runtime = this.db.prepare("SELECT value FROM settings WHERE key='runtime'").get();
    if (runtime) Object.assign(this, JSON.parse(runtime.value));
    for (const name of await readdir(this.tempDir)) { const path = join(this.tempDir, name); const info = await stat(path); if (Date.now() - info.mtimeMs > 3600000) await clean(path); }
    return this;
  }
  _persist(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  async _locked(work) { let release; const previous = this.lock; this.lock = new Promise(resolve => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  async _queued(work) {
    if (this.active >= this.concurrency) {
      if (this.pending.length >= this.queueLimit) fail('SlowDown', 'Upload queue is full. Retry later.', 503);
      await new Promise(resolve => this.pending.push(resolve));
    } else this.active++;
    try { return await work(); } finally { this.active--; this._drain(); }
  }
  _drain() { while (this.pending.length && this.active < this.concurrency) { this.active++; this.pending.shift()(); } }
  _bucket(name) { const row = this.db.prepare('SELECT * FROM buckets WHERE name=?').get(name); if (!row) fail('NoSuchBucket', 'The specified bucket does not exist.', 404); return row; }
  _object(bucket, key) { this._bucket(bucket); validKey(key); const row = this.db.prepare('SELECT * FROM objects WHERE bucket=? AND key=?').get(bucket, key); if (!row) fail('NoSuchKey', 'The specified object does not exist.', 404); return row; }
  async buckets() { return this.db.prepare('SELECT b.name,b.created_at AS createdAt,COUNT(o.key) AS objects,COALESCE(SUM(o.size),0) AS bytes FROM buckets b LEFT JOIN objects o ON o.bucket=b.name GROUP BY b.name ORDER BY b.name').all(); }
  async createBucket(name) { validBucket(name); return this._locked(() => { if (this.db.prepare('SELECT 1 FROM buckets WHERE name=?').get(name)) fail('BucketAlreadyOwnedByYou', 'Bucket already exists.', 409); const createdAt = new Date().toISOString(); this.db.prepare('INSERT INTO buckets VALUES (?,?)').run(name, createdAt); return { name, createdAt }; }); }
  async deleteBucket(name) { return this._locked(() => { this._bucket(name); if (this.db.prepare('SELECT 1 FROM objects WHERE bucket=? LIMIT 1').get(name)) fail('BucketNotEmpty', 'The bucket is not empty.', 409); this.db.prepare('DELETE FROM buckets WHERE name=?').run(name); }); }
  async listObjects(bucket, { prefix = '', maxKeys = 1000, continuationToken, delimiter = '', startAfter = '' } = {}) {
    this._bucket(bucket); if (typeof prefix !== 'string' || typeof delimiter !== 'string' || !Number.isInteger(maxKeys) || maxKeys < 0 || maxKeys > 1000) fail('InvalidArgument', 'Invalid object-list arguments.');
    let after = typeof startAfter === 'string' ? startAfter : '';
    if (typeof startAfter !== 'string') fail('InvalidArgument', 'Invalid start-after key.');
    if (continuationToken) { try { const token = JSON.parse(Buffer.from(continuationToken, 'base64url').toString()); if (token.bucket !== bucket || token.prefix !== prefix || token.delimiter !== delimiter || typeof token.after !== 'string') throw new Error(); after = token.after; } catch { fail('InvalidArgument', 'Invalid continuation token.'); } }
    const objects = [], commonPrefixes = [], seen = new Set(); let last = after; let isTruncated = false;
    if (maxKeys) for (const row of this.db.prepare('SELECT * FROM objects WHERE bucket=? AND substr(key,1,length(?))=? AND key>? ORDER BY key').iterate(bucket, prefix, prefix, after)) {
      const slash = delimiter ? row.key.indexOf(delimiter, prefix.length) : -1;
      const group = slash < 0 ? null : row.key.slice(0, slash + delimiter.length);
      if (group && group <= startAfter) { last = row.key; continue; }
      if (group && seen.has(group)) { last = row.key; continue; }
      if (objects.length + commonPrefixes.length >= maxKeys) { isTruncated = true; break; }
      if (group) { seen.add(group); commonPrefixes.push(group); } else objects.push(metadata(row));
      last = row.key;
    }
    return { objects, commonPrefixes, isTruncated, nextContinuationToken: isTruncated ? Buffer.from(JSON.stringify({ bucket, prefix, delimiter, after: last })).toString('base64url') : undefined };
  }
  _placements(bucket, key, config = this.config) {
    const nodes = config.nodes;
    if (config.mode === 'raid1') return nodes;
    const groups = config.mode === 'raid10' ? Array.from({ length: nodes.length / 2 }, (_, i) => nodes.slice(i * 2, i * 2 + 2)) : nodes.map(node => [node]);
    return groups.map(group => ({ group, score: createHash('sha256').update(`${bucket}\0${key}\0${group.map(n => n.id).join('\0')}`).digest('hex') })).sort((a, b) => b.score.localeCompare(a.score))[0].group;
  }
  async _fetch(node, path, options = {}) { try { return await fetch(`${node.url}${path}`, { ...options, headers: { ...options.headers, authorization: `Bearer ${node.token}` }, signal: AbortSignal.timeout(options.method === 'PUT' ? 120000 : 30000), redirect: 'error' }); } catch { fail('ServiceUnavailable', `Storage node ${node.id} is unavailable.`, 503); } }
  async _replicate(node, id, path, info) {
    if (node.url === 'local') {
      const target = join(this.blobDir, id), temporary = join(this.tempDir, randomUUID());
      try { await writeStreamFile(temporary, createReadStream(path), this.maxObjectBytes); await rename(temporary, target); await syncDirectory(this.blobDir); } finally { await clean(temporary); }
    } else {
      const response = await this._fetch(node, `/blobs/${id}`, { method: 'PUT', body: createReadStream(path), duplex: 'half', headers: { 'content-length': String(info.size), 'x-content-sha256': info.sha256 } });
      if (!response.ok) { await response.body?.cancel(); fail('ServiceUnavailable', `Storage node ${node.id} rejected the write.`, 503); }
      const result = await response.json(); if (result.sha256 !== info.sha256 || result.size !== info.size) fail('InternalError', 'Replica checksum verification failed.', 502);
    }
  }
  _retire(id, nodes) {
    const previous = this.db.prepare('SELECT nodes FROM garbage WHERE blob_id=?').get(id);
    const combined = new Map((previous ? JSON.parse(previous.nodes) : []).map(node => [node.url, node]));
    for (const node of nodes) combined.set(node.url, node);
    this.db.prepare('INSERT INTO garbage VALUES(?,?,?) ON CONFLICT(blob_id) DO UPDATE SET nodes=excluded.nodes, retired_at=excluded.retired_at').run(id, JSON.stringify([...combined.values()]), Date.now());
  }
  _invalidate(bucket, key) { const cacheKey = `${bucket}\0${key}`, cached = this.cache.get(cacheKey); if (cached) { this.cacheSize -= cached.data.length; this.cache.delete(cacheKey); } }
  _remember(bucket, key, row, data) {
    if (this.cacheBytes === 0 || data.length > Math.min(this.cacheBytes, 1024 ** 2)) return;
    this._invalidate(bucket, key);
    while ((this.cacheSize + data.length > this.cacheBytes || this.cache.size >= 4096) && this.cache.size) { const first = this.cache.keys().next().value; this.cacheSize -= this.cache.get(first).data.length; this.cache.delete(first); }
    this.cache.set(`${bucket}\0${key}`, { id: row.blob_id, data }); this.cacheSize += data.length;
  }
  async putObject(bucket, key, source, { contentType = 'application/octet-stream', expectedSha256, expectedMd5 } = {}) {
    this._bucket(bucket); validKey(key);
    if (typeof contentType !== 'string' || contentType.length > 255 || /[\r\n\0]/.test(contentType)) fail('InvalidArgument', 'Invalid content type.');
    return this._queued(async () => {
      const temporary = join(this.tempDir, randomUUID());
      try {
        const info = await writeStreamFile(temporary, source, this.maxObjectBytes);
        if (expectedSha256 && (!/^[a-f\d]{64}$/i.test(expectedSha256) || info.sha256 !== expectedSha256.toLowerCase())) fail('XAmzContentSHA256Mismatch', 'Payload SHA256 does not match the signed checksum.');
        if (expectedMd5 && Buffer.from(info.etag, 'hex').toString('base64') !== expectedMd5) fail('BadDigest', 'Content-MD5 does not match the payload.');
        return await this._locked(async () => {
          this._bucket(bucket); const targets = this._placements(bucket, key); const id = randomUUID();
          this._retire(id, targets); // Durable intent reclaims abandoned replicas after a crash.
          const results = await Promise.allSettled(targets.map(node => this._replicate(node, id, temporary, info)));
          const error = results.find(result => result.status === 'rejected');
          if (error) { this._retire(id, targets); throw error.reason; }
          const modifiedAt = new Date().toISOString(); const previous = this.db.prepare('SELECT * FROM objects WHERE bucket=? AND key=?').get(bucket, key);
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET blob_id=excluded.blob_id,size=excluded.size,etag=excluded.etag,sha256=excluded.sha256,modified_at=excluded.modified_at,content_type=excluded.content_type,replicas=excluded.replicas').run(bucket, key, id, info.size, info.etag, info.sha256, modifiedAt, contentType, JSON.stringify(targets.map(node => node.id)));
            this.db.prepare('DELETE FROM garbage WHERE blob_id=?').run(id);
            if (previous) this._retire(previous.blob_id, this.config.nodes.filter(node => JSON.parse(previous.replicas).includes(node.id)));
            this.db.exec('COMMIT');
          } catch (error) { this.db.exec('ROLLBACK'); this._retire(id, targets); throw error; }
          this._invalidate(bucket, key); return { key, ...info, modifiedAt, contentType };
        });
      } finally { await clean(temporary); }
    });
  }
  async headObject(bucket, key) { return metadata(this._object(bucket, key)); }
  async _verifiedReplica(node, row) {
    if (node.url === 'local') { const path = join(this.blobDir, row.blob_id); const info = await digestFile(path); if (info.size !== row.size || info.sha256 !== row.sha256) throw new Error('Replica checksum mismatch'); return { path, temporary: false }; }
    const response = await this._fetch(node, `/blobs/${row.blob_id}`);
    if (!response.ok) { await response.body?.cancel(); throw new Error('Replica unavailable'); }
    const path = join(this.tempDir, randomUUID());
    try { const info = await writeStreamFile(path, Readable.fromWeb(response.body), Math.min(this.maxObjectBytes, row.size)); if (info.size !== row.size || info.sha256 !== row.sha256) throw new Error('Replica checksum mismatch'); return { path, temporary: true }; } catch (error) { await clean(path); throw error; }
  }
  async getObject(bucket, key) {
    const row = this._object(bucket, key); const cacheKey = `${bucket}\0${key}`, cached = this.cache.get(cacheKey);
    if (cached?.id === row.blob_id) { this.hits++; this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); return { metadata: metadata(row), stream: Readable.from([cached.data]) }; }
    this.misses++; this.readers.set(row.blob_id, (this.readers.get(row.blob_id) || 0) + 1);
    try {
      const nodes = JSON.parse(row.replicas).map(id => this.config.nodes.find(node => node.id === id)).filter(Boolean).sort((a, b) => Number(b.url === 'local') - Number(a.url === 'local'));
      for (const node of nodes) {
        let replica;
        try {
          replica = await this._verifiedReplica(node, row);
          const fd = await open(replica.path, 'r');
          if (this.cacheBytes > 0 && row.size <= Math.min(1024 ** 2, this.cacheBytes)) {
            let data; try { data = await fd.readFile(); } finally { await fd.close(); }
            // An overwrite may commit while the read is verifying; cache only the current generation.
            if (this.db.prepare('SELECT blob_id FROM objects WHERE bucket=? AND key=?').get(bucket, key)?.blob_id === row.blob_id) this._remember(bucket, key, row, data);
            if (replica.temporary) await clean(replica.path);
            return { metadata: metadata(row), stream: Readable.from([data]) };
          }
          const stream = fd.createReadStream();
          if (replica.temporary) await clean(replica.path); // The open descriptor keeps this immutable snapshot available.
          return { metadata: metadata(row), stream };
        } catch { if (replica?.temporary) await clean(replica.path).catch(() => {}); }
      }
      fail('ServiceUnavailable', 'No healthy replica is available for this object.', 503);
    } finally { const count = this.readers.get(row.blob_id) - 1; if (count) this.readers.set(row.blob_id, count); else this.readers.delete(row.blob_id); }
  }
  async deleteObject(bucket, key) {
    this._bucket(bucket); validKey(key);
    return this._locked(() => {
      const row = this.db.prepare('SELECT * FROM objects WHERE bucket=? AND key=?').get(bucket, key); if (!row) return;
      this.db.exec('BEGIN IMMEDIATE');
      try { this._retire(row.blob_id, this.config.nodes.filter(node => JSON.parse(row.replicas).includes(node.id))); this.db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(bucket, key); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this._invalidate(bucket, key);
    });
  }
  async topology() { return { mode: this.config.mode, nodes: this.config.nodes.map(redact) }; }
  async configure({ mode, nodes, migrate = false }) {
    if (!['raid0', 'raid1', 'raid10'].includes(mode) || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 64) fail('InvalidArgument', 'Select raid0, raid1 or raid10 and 1–64 storage nodes.');
    const normalized = nodes.map(node => {
      if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id)) fail('InvalidArgument', 'Node ID must contain 1–64 letters, digits, underscores or hyphens.');
      const label = typeof node.label === 'string' ? node.label.slice(0, 100) : node.id;
      if (node.id === 'local' || node.url === 'local') { if (node.id !== 'local' || node.url !== 'local') fail('InvalidArgument', 'The local node must have both ID and URL local.'); return { id: 'local', url: 'local', label }; }
      let url; try { url = new URL(node.url); } catch { fail('InvalidArgument', 'Invalid storage node URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('InvalidArgument', 'Node URL must be an HTTP(S) origin without credentials, path or query.');
      const old = this.config.nodes.find(previous => previous.id === node.id && previous.url === url.origin);
      const token = node.token || old?.token;
      if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) fail('InvalidArgument', 'Node token must contain 32–512 characters.');
      return { id: node.id, label, url: url.origin, token };
    });
    if (new Set(normalized.map(node => node.id)).size !== normalized.length || new Set(normalized.map(node => node.url)).size !== normalized.length) fail('InvalidArgument', 'Node IDs and URLs must be unique.');
    if (mode === 'raid1' && nodes.length < 2) fail('InvalidArgument', 'RAID1 requires at least two nodes.');
    if (mode === 'raid10' && (nodes.length < 4 || nodes.length % 2)) fail('InvalidArgument', 'RAID10 requires an even number of nodes, at least four.');
    return this._locked(async () => {
      const objects = this.db.prepare('SELECT * FROM objects').all();
      if (objects.length && !migrate) fail('TopologyLocked', 'Existing objects require explicit migration when changing topology.', 409);
      const next = { mode, nodes: normalized }, previous = this.config; const copied = [];
      this.migration = { active: true, completed: 0, total: objects.length };
      try {
        for (const row of objects) {
          let source;
          for (const id of JSON.parse(row.replicas)) {
            const node = previous.nodes.find(item => item.id === id); if (!node) continue;
            try { source = await this._verifiedReplica(node, row); break; } catch {}
          }
          if (!source) fail('ServiceUnavailable', `Migration stopped: no healthy replica for ${row.bucket}/${row.key}.`, 503);
          const targets = this._placements(row.bucket, row.key, next); copied.push({ row, targets });
          this._retire(row.blob_id, targets);
          try {
            const results = await Promise.allSettled(targets.map(node => this._replicate(node, row.blob_id, source.path, { size: row.size, sha256: row.sha256 })));
            const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
          } finally { if (source.temporary) await clean(source.path); }
          this.migration.completed++;
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const { row, targets } of copied) {
            this.db.prepare('UPDATE objects SET replicas=? WHERE bucket=? AND key=?').run(JSON.stringify(targets.map(node => node.id)), row.bucket, row.key);
            this._retire(row.blob_id, previous.nodes.filter(node => JSON.parse(row.replicas).includes(node.id)));
          }
          this._persist('topology', next); this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        this.config = next; this.probes.clear(); return { ...await this.topology(), migrated: objects.length };
      } catch (error) {
        for (const { row, targets } of copied) this._retire(row.blob_id, targets);
        throw error;
      } finally { this.migration.active = false; }
    });
  }
  async updateSettings({ cacheBytes = this.cacheBytes, concurrency = this.concurrency } = {}) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > 1024 ** 3 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) fail('InvalidArgument', 'Cache must be 0–1 GiB; concurrency must be 1–64.');
    this.cacheBytes = cacheBytes; this.concurrency = concurrency;
    while ((this.cacheSize > cacheBytes || cacheBytes === 0) && this.cache.size) { const key = this.cache.keys().next().value; this.cacheSize -= this.cache.get(key).data.length; this.cache.delete(key); }
    this._persist('runtime', { cacheBytes, concurrency }); this._drain(); return { cacheBytes, concurrency };
  }
  async _health(node) {
    const known = this.probes.get(node.id); if (known && Date.now() - known.at < 5000) return known.value;
    let value;
    try {
      if (node.url === 'local') { const fs = await statfs(this.blobDir); value = { online: true, capacityBytes: Number(fs.blocks) * Number(fs.bsize), freeBytes: Number(fs.bavail) * Number(fs.bsize) }; }
      else { const response = await fetch(`${node.url}/health`, { headers: { authorization: `Bearer ${node.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!response.ok) throw new Error(); const info = await response.json(); value = { online: true, capacityBytes: info.capacityBytes, freeBytes: info.freeBytes }; }
    } catch { value = { online: false }; }
    this.probes.set(node.id, { at: Date.now(), value }); return value;
  }
  async status() {
    const summary = this.db.prepare('SELECT COUNT(*) AS objectCount,COALESCE(SUM(size),0) AS totalBytes FROM objects').get();
    const nodes = await Promise.all(this.config.nodes.map(async node => ({ ...redact(node), ...await this._health(node) })));
    return { mode: this.config.mode, nodes, ...summary, bucketCount: this.db.prepare('SELECT COUNT(*) AS n FROM buckets').get().n, cache: { bytes: this.cacheSize, entries: this.cache.size, limit: this.cacheBytes, hits: this.hits, misses: this.misses }, queue: { active: this.active, pending: this.pending.length, concurrency: this.concurrency, limit: this.queueLimit }, maxObjectBytes: this.maxObjectBytes, pendingGarbage: this.db.prepare('SELECT COUNT(*) AS n FROM garbage').get().n, singleCoordinator: true, migration: this.migration || { active: false, completed: 0, total: 0 } };
  }
  async garbageCollect() { return this._locked(() => this._collectGarbage()); }
  async _collectGarbage() {
    let removed = 0, failed = 0;
    for (const row of this.db.prepare('SELECT * FROM garbage WHERE retired_at<?').all(Date.now() - 3600000)) {
      if (this.readers.has(row.blob_id)) continue;
      let okay = true;
      const live = this.db.prepare('SELECT replicas FROM objects WHERE blob_id=? LIMIT 1').get(row.blob_id);
      const liveUrls = new Set(live ? this.config.nodes.filter(node => JSON.parse(live.replicas).includes(node.id)).map(node => node.url) : []);
      for (const node of JSON.parse(row.nodes).filter(node => !liveUrls.has(node.url))) try { if (node.url === 'local') await clean(join(this.blobDir, row.blob_id)); else { const response = await this._fetch(node, `/blobs/${row.blob_id}`, { method: 'DELETE' }); await response.body?.cancel(); if (!response.ok && response.status !== 404) throw new Error(); } } catch { okay = false; }
      if (okay) { this.db.prepare('DELETE FROM garbage WHERE blob_id=?').run(row.blob_id); removed++; } else failed++;
    }
    return { removed, failed };
  }
  async scrub() {
    return this._locked(async () => {
      const result = { checked: 0, repaired: 0, unrecoverable: 0, repairFailed: 0 };
      for (const row of this.db.prepare('SELECT * FROM objects').all()) {
        result.checked++; this._invalidate(row.bucket, row.key);
        const targets = JSON.parse(row.replicas).map(id => this.config.nodes.find(node => node.id === id)).filter(Boolean); const bad = []; let good;
        for (const node of targets) try { const verified = await this._verifiedReplica(node, row); if (!good) good = verified; else if (verified.temporary) await clean(verified.path); } catch { bad.push(node); }
        if (!good) { result.unrecoverable++; continue; }
        try { for (const node of bad) try { await this._replicate(node, row.blob_id, good.path, { size: row.size, sha256: row.sha256 }); result.repaired++; } catch { result.repairFailed++; } } finally { if (good.temporary) await clean(good.path); }
      }
      result.garbage = await this._collectGarbage(); return result;
    });
  }
  close() { this.db?.close(); }
}

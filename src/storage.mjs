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
  if (['api', 'console', 'healthz', 'share'].includes(name)) fail('InvalidBucketName', 'This bucket name is reserved for the control panel.');
  if (typeof name !== 'string' || name.length < 3 || name.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name) || name.includes('..') || name.includes('.-') || name.includes('-.') || /^\d+\.\d+\.\d+\.\d+$/.test(name) || /^(xn--|sthree-|amzn-s3-demo-)/.test(name) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(name)) fail('InvalidBucketName', 'Bucket names must be DNS-compatible, 3–63 lowercase characters.');
}
function validKey(key) { if (typeof key !== 'string' || !key.length || Buffer.byteLength(key) > 1024 || key.includes('\0')) fail('InvalidArgument', 'Object key must contain 1–1024 UTF-8 bytes and no NUL.'); }
const redact = ({ token, ...node }) => node;
const metadata = row => ({ versionId: row.version_id || row.blob_id, isDeleteMarker: Boolean(row.delete_marker), owner: row.owner || '', key: row.key, size: Number(row.size), etag: row.etag, sha256: row.sha256, modifiedAt: row.modified_at, contentType: row.content_type });

export class Storage {
  constructor({ dataDir, maxObjectBytes = 5 * 1024 ** 3, cacheBytes = 64 * 1024 ** 2, concurrency = 4, queueLimit = 64 } = {}) {
    if (!dataDir) throw new Error('dataDir is required');
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || !Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > 1024 ** 3 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64 || !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 10000) throw new Error('Invalid storage size, cache or queue limits.');
    this.dataDir = dataDir; this.blobDir = join(dataDir, 'blobs'); this.tempDir = join(dataDir, 'tmp');
    this.maxObjectBytes = maxObjectBytes; this.cacheBytes = cacheBytes; this.concurrency = concurrency; this.queueLimit = queueLimit;
    this.runtimeDefaults = Object.freeze({ cacheBytes, concurrency });
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
      CREATE TABLE IF NOT EXISTS garbage (blob_id TEXT PRIMARY KEY, nodes TEXT NOT NULL, retired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS object_versions (seq INTEGER PRIMARY KEY AUTOINCREMENT,version_id TEXT UNIQUE NOT NULL,bucket TEXT NOT NULL REFERENCES buckets(name),key TEXT NOT NULL,blob_id TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT NOT NULL,sha256 TEXT NOT NULL,modified_at TEXT NOT NULL,content_type TEXT NOT NULL,replicas TEXT NOT NULL,delete_marker INTEGER NOT NULL DEFAULT 0,owner TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS versions_key ON object_versions(bucket,key,seq DESC);
      CREATE INDEX IF NOT EXISTS versions_blob ON object_versions(blob_id);
      CREATE TABLE IF NOT EXISTS multipart_uploads (upload_id TEXT PRIMARY KEY,bucket TEXT NOT NULL REFERENCES buckets(name),key TEXT NOT NULL,content_type TEXT NOT NULL,initiated TEXT NOT NULL,owner TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS multipart_parts (upload_id TEXT NOT NULL REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE,part_number INTEGER NOT NULL,blob_id TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT NOT NULL,sha256 TEXT NOT NULL,modified_at TEXT NOT NULL,replicas TEXT NOT NULL,PRIMARY KEY(upload_id,part_number));
      CREATE TABLE IF NOT EXISTS bucket_quotas (bucket TEXT PRIMARY KEY REFERENCES buckets(name) ON DELETE CASCADE,max_bytes INTEGER,max_objects INTEGER);
      CREATE TABLE IF NOT EXISTS upload_reservations (id TEXT PRIMARY KEY,bucket TEXT NOT NULL REFERENCES buckets(name),owner TEXT NOT NULL,bytes INTEGER NOT NULL,objects INTEGER NOT NULL);
      INSERT INTO object_versions(version_id,bucket,key,blob_id,size,etag,sha256,modified_at,content_type,replicas)
      SELECT blob_id,bucket,key,blob_id,size,etag,sha256,modified_at,content_type,replicas FROM objects WHERE NOT EXISTS(SELECT 1 FROM object_versions v WHERE v.bucket=objects.bucket AND v.key=objects.key);
      DELETE FROM upload_reservations;`);
    // Existing shares used the current blob ID as their access generation. Keep
    // those valid across upgrade, then issue a never-reused token whenever the
    // visible version changes (including promotion of a historical version).
    if (!this.db.prepare('PRAGMA table_info(objects)').all().some(column => column.name === 'generation')) this.db.exec("BEGIN IMMEDIATE; ALTER TABLE objects ADD COLUMN generation TEXT NOT NULL DEFAULT ''; UPDATE objects SET generation=blob_id; COMMIT;");
    await chmod(join(this.dataDir, 'catalog.sqlite'), 0o600);
    const config = this.db.prepare("SELECT value FROM settings WHERE key='topology'").get();
    this.config = config ? JSON.parse(config.value) : { mode: 'raid0', nodes: [{ id: 'local', url: 'local', label: 'Coordinator storage' }] };
    if (!config) this._persist('topology', this.config);
    const runtime = this.db.prepare("SELECT value FROM settings WHERE key='runtime'").get();
    Object.assign(this, this.runtimeDefaults, runtime ? JSON.parse(runtime.value) : {});
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
  _object(bucket, key, { versionId } = {}) {
    this._bucket(bucket); validKey(key);
    const row = versionId === undefined ? this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? ORDER BY seq DESC LIMIT 1').get(bucket, key) : this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? AND version_id=?').get(bucket, key, versionId);
    if (!row) fail(versionId === undefined ? 'NoSuchKey' : 'NoSuchVersion', 'The specified object version does not exist.', 404);
    if (row.delete_marker) { const error = new StorageError(versionId === undefined ? 'NoSuchKey' : 'MethodNotAllowed', 'The object version is a delete marker.', versionId === undefined ? 404 : 405); error.deleteMarker = true; error.versionId = row.version_id; throw error; }
    return row;
  }
  async buckets() {
    return this.db.prepare('SELECT b.name,b.created_at AS createdAt,COUNT(o.key) AS objects,COALESCE(SUM(o.size),0) AS bytes FROM buckets b LEFT JOIN objects o ON o.bucket=b.name GROUP BY b.name ORDER BY b.name').all().map(bucket => ({ ...this.bucketUsage(bucket.name), ...bucket, usedBytes: this.bucketUsage(bucket.name).bytes, usedObjects: this.bucketUsage(bucket.name).objects, quotaBytes: this.db.prepare('SELECT max_bytes FROM bucket_quotas WHERE bucket=?').get(bucket.name)?.max_bytes ?? null, quotaObjects: this.db.prepare('SELECT max_objects FROM bucket_quotas WHERE bucket=?').get(bucket.name)?.max_objects ?? null }));
  }
  async createBucket(name) { validBucket(name); return this._locked(() => { if (this.db.prepare('SELECT 1 FROM buckets WHERE name=?').get(name)) fail('BucketAlreadyOwnedByYou', 'Bucket already exists.', 409); const createdAt = new Date().toISOString(); this.db.prepare('INSERT INTO buckets VALUES (?,?)').run(name, createdAt); return { name, createdAt }; }); }
  async deleteBucket(name) { return this._locked(() => { this._bucket(name); if (this.db.prepare('SELECT 1 FROM object_versions WHERE bucket=? LIMIT 1').get(name) || this.db.prepare('SELECT 1 FROM multipart_uploads WHERE bucket=? LIMIT 1').get(name) || this.db.prepare('SELECT 1 FROM upload_reservations WHERE bucket=? LIMIT 1').get(name)) fail('BucketNotEmpty', 'Remove all object versions, delete markers and multipart uploads first.', 409); this.db.prepare('DELETE FROM buckets WHERE name=?').run(name); }); }
  async listObjects(bucket, { prefix = '', maxKeys = 1000, continuationToken, delimiter = '', startAfter = '' } = {}) {
    this._bucket(bucket); if (typeof prefix !== 'string' || typeof delimiter !== 'string' || !Number.isInteger(maxKeys) || maxKeys < 0 || maxKeys > 1000) fail('InvalidArgument', 'Invalid object-list arguments.');
    let after = typeof startAfter === 'string' ? startAfter : '';
    if (typeof startAfter !== 'string') fail('InvalidArgument', 'Invalid start-after key.');
    if (continuationToken) { try { const token = JSON.parse(Buffer.from(continuationToken, 'base64url').toString()); if (token.bucket !== bucket || token.prefix !== prefix || token.delimiter !== delimiter || typeof token.after !== 'string') throw new Error(); after = token.after; } catch { fail('InvalidArgument', 'Invalid continuation token.'); } }
    const objects = [], commonPrefixes = [], seen = new Set(); let last = after; let isTruncated = false;
    if (maxKeys) for (const row of this.db.prepare('SELECT o.*,(SELECT v.version_id FROM object_versions v WHERE v.bucket=o.bucket AND v.key=o.key ORDER BY seq DESC LIMIT 1) AS version_id FROM objects o WHERE bucket=? AND substr(key,1,length(?))=? AND key>? ORDER BY key').iterate(bucket, prefix, prefix, after)) {
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
  _assertWritableTopology(config=this.config) {
    if(this.requireRemoteMirrors && (config.nodes.some(node=>node.url==='local') || !(config.mode==='raid1'&&config.nodes.length>=2 || config.mode==='raid10'&&config.nodes.length>=4&&config.nodes.length%2===0))) fail('UnsafeTopology','HA requires mirrored replicas on remote storage nodes.',409);
  }
  _validateContentType(contentType) { if (typeof contentType !== 'string' || contentType.length > 255 || /[\r\n\0]/.test(contentType)) fail('InvalidArgument', 'Invalid content type.'); }
  _nodesFor(row) { return this.config.nodes.filter(node => JSON.parse(row.replicas).includes(node.id)); }
  _allBlobs() {
    return [...this.db.prepare('SELECT * FROM object_versions WHERE delete_marker=0').all(), ...this.db.prepare("SELECT p.*,u.bucket,u.key,u.content_type,u.owner FROM multipart_parts p JOIN multipart_uploads u USING(upload_id)").all()];
  }
  _usage({ bucket, owner } = {}) {
    const field = bucket === undefined ? 'owner' : 'bucket', value = bucket === undefined ? owner : bucket;
    const versions = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM object_versions WHERE ${field}=? AND delete_marker=0`).get(value);
    const uploads = this.db.prepare(`SELECT COUNT(*) AS count FROM multipart_uploads WHERE ${field}=?`).get(value);
    const parts = this.db.prepare(`SELECT COALESCE(SUM(p.size),0) AS bytes FROM multipart_parts p JOIN multipart_uploads u USING(upload_id) WHERE u.${field}=?`).get(value);
    const reservations = this.db.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(objects),0) AS count FROM upload_reservations WHERE ${field}=?`).get(value);
    return { bytes: versions.bytes + parts.bytes + reservations.bytes, objects: versions.count + uploads.count + reservations.count, retainedBytes: versions.bytes, versionCount: versions.count, multipartBytes: parts.bytes, multipartUploads: uploads.count, reservedBytes: reservations.bytes, reservedObjects: reservations.count };
  }
  bucketUsage(bucket) { this._bucket(bucket); return this._usage({ bucket }); }
  ownerUsage(owner) { return this._usage({ owner }); }
  async setBucketQuota(bucket, { maxBytes = null, maxObjects = null } = {}) {
    for (const value of [maxBytes,maxObjects]) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail('InvalidArgument','Quota must be a nonnegative integer or null.');
    return this._locked(() => { this._bucket(bucket); this.db.prepare('INSERT INTO bucket_quotas VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET max_bytes=excluded.max_bytes,max_objects=excluded.max_objects').run(bucket,maxBytes,maxObjects); return { maxBytes,maxObjects,...this.bucketUsage(bucket) }; });
  }
  async _checkQuota(bucket, owner, addBytes = 0, addObjects = 0, options = {}) {
    const limits = this.db.prepare('SELECT * FROM bucket_quotas WHERE bucket=?').get(bucket);
    const check = (usage, bytes, objects) => { if (bytes != null && usage.bytes + addBytes > bytes || objects != null && usage.objects + addObjects > objects) fail('QuotaExceeded','Storage quota exceeded; remove old versions or unfinished uploads.',403); };
    check(this._usage({ bucket }),limits?.max_bytes,limits?.max_objects);
    if (owner) {
      const policy = this.quotaPolicy ? await this.quotaPolicy(owner) : options;
      if (this.quotaPolicy && (!policy || policy.enabled === false)) fail('AccessDenied','The upload owner is disabled or missing.',403);
      check(this._usage({ owner }),policy?.quotaBytes,policy?.quotaObjects);
    }
  }
  async _reservation(bucket, owner, objects, options) {
    return this._locked(async () => { this._bucket(bucket); this._assertWritableTopology(); await this._checkQuota(bucket,owner,0,objects,options); const id=randomUUID(); this.db.prepare('INSERT INTO upload_reservations VALUES(?,?,?,?,?)').run(id,bucket,owner,0,objects); return id; });
  }
  async *_reservedBody(source, reservation, options) {
    for await (const raw of source) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); await this._locked(async () => { const row = this.db.prepare('SELECT * FROM upload_reservations WHERE id=?').get(reservation); if (!row) fail('OperationAborted','The upload reservation no longer exists.',409); await this._checkQuota(row.bucket,row.owner,chunk.length,0,options); this.db.prepare('UPDATE upload_reservations SET bytes=bytes+? WHERE id=?').run(chunk.length,reservation); }); yield chunk; }
  }
  _assertChecks(info, {expectedSha256,expectedMd5} = {}) { if (expectedSha256 && (!/^[a-f\d]{64}$/i.test(expectedSha256) || info.sha256 !== expectedSha256.toLowerCase())) fail('XAmzContentSHA256Mismatch','Payload SHA256 does not match the signed checksum.'); if (expectedMd5 && Buffer.from(info.etag,'hex').toString('base64') !== expectedMd5) fail('BadDigest','Content-MD5 does not match the payload.'); }
  _insertVersion(row) {
    this.db.prepare('INSERT INTO object_versions(version_id,bucket,key,blob_id,size,etag,sha256,modified_at,content_type,replicas,delete_marker,owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.version_id,row.bucket,row.key,row.blob_id,row.size,row.etag,row.sha256,row.modified_at,row.content_type,row.replicas,row.delete_marker || 0,row.owner || '');
  }
  _refreshCurrent(bucket,key) {
    const row = this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? ORDER BY seq DESC LIMIT 1').get(bucket,key);
    const previous = this.db.prepare('SELECT blob_id,generation FROM objects WHERE bucket=? AND key=?').get(bucket,key);
    this.db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(bucket,key);
    if (row && !row.delete_marker) {
      const generation = previous?.blob_id === row.blob_id ? previous.generation : `access:${randomUUID()}`;
      this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?)').run(bucket,key,row.blob_id,row.size,row.etag,row.sha256,row.modified_at,row.content_type,row.replicas,generation);
    }
    this._invalidate(bucket,key);
  }
  _trimVersions(bucket,key) {
    for (const row of this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? AND delete_marker=0 ORDER BY seq DESC LIMIT -1 OFFSET 5').all(bucket,key)) { this._retire(row.blob_id,this._nodesFor(row)); this.db.prepare('DELETE FROM object_versions WHERE version_id=?').run(row.version_id); }
    // A current tombstone is sufficient for the recycle bin; old tombstones carry no data.
    this.db.prepare('DELETE FROM object_versions WHERE bucket=? AND key=? AND delete_marker=1 AND seq<(SELECT MAX(seq) FROM object_versions WHERE bucket=? AND key=?)').run(bucket,key,bucket,key);
  }
  async _publishFile(bucket,key,temporary,info,{contentType='application/octet-stream',owner='',reservation,uploadId} = {}) {
    this._bucket(bucket); this._assertWritableTopology(); const targets=this._placements(bucket,key), id=randomUUID(); this._retire(id,targets);
    const results=await Promise.allSettled(targets.map(node=>this._replicate(node,id,temporary,info))); const error=results.find(result=>result.status==='rejected'); if(error) throw error.reason;
    const row={bucket,key,version_id:randomUUID(),blob_id:id,...info,modified_at:new Date().toISOString(),content_type:contentType,replicas:JSON.stringify(targets.map(node=>node.id)),owner};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this._insertVersion(row); if(reservation) this.db.prepare('DELETE FROM upload_reservations WHERE id=?').run(reservation);
      if(uploadId) { for(const part of this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id=?').all(uploadId)) this._retire(part.blob_id,this._nodesFor(part)); this.db.prepare('DELETE FROM multipart_uploads WHERE upload_id=?').run(uploadId); }
      this._trimVersions(bucket,key); this._refreshCurrent(bucket,key); this.db.prepare('DELETE FROM garbage WHERE blob_id=?').run(id); this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return metadata(row);
  }
  async putObject(bucket,key,source,options={}) {
    const {contentType='application/octet-stream',owner=''}=options; this._bucket(bucket); validKey(key); this._validateContentType(contentType);
    return this._queued(async()=>{ const reservation=await this._reservation(bucket,owner,1,options), temporary=join(this.tempDir,randomUUID());
      try { const info=await writeStreamFile(temporary,this._reservedBody(source,reservation,options),this.maxObjectBytes); this._assertChecks(info,options); return await this._locked(async()=>{ await this._checkQuota(bucket,owner,0,0,options); return this._publishFile(bucket,key,temporary,info,{contentType,owner,reservation}); }); }
      finally { await clean(temporary); await this._locked(()=>this.db.prepare('DELETE FROM upload_reservations WHERE id=?').run(reservation)); }
    });
  }
  objectGeneration(bucket, key) { this._object(bucket,key); return this.db.prepare('SELECT generation FROM objects WHERE bucket=? AND key=?').get(bucket,key).generation; }
  _assertGeneration(bucket,key,row,expected) {
    if (expected === undefined) return;
    const current=this.db.prepare('SELECT blob_id,generation FROM objects WHERE bucket=? AND key=?').get(bucket,key);
    if (current?.generation !== expected || current.blob_id !== row.blob_id) fail('NoSuchKey', 'The specified object does not exist.', 404);
  }
  async headObject(bucket, key, { expectedGeneration, expectedBlobId, versionId } = {}) {
    const row = this._object(bucket, key, { versionId });
    this._assertGeneration(bucket,key,row,expectedGeneration ?? expectedBlobId);
    return metadata(row);
  }
  async _verifiedReplica(node, row) {
    if (node.url === 'local') { const path = join(this.blobDir, row.blob_id); const info = await digestFile(path); if (info.size !== row.size || info.sha256 !== row.sha256) throw new Error('Replica checksum mismatch'); return { path, temporary: false }; }
    const response = await this._fetch(node, `/blobs/${row.blob_id}`);
    if (!response.ok) { await response.body?.cancel(); throw new Error('Replica unavailable'); }
    const path = join(this.tempDir, randomUUID());
    try { const info = await writeStreamFile(path, Readable.fromWeb(response.body), Math.min(this.maxObjectBytes, row.size)); if (info.size !== row.size || info.sha256 !== row.sha256) throw new Error('Replica checksum mismatch'); return { path, temporary: true }; } catch (error) { await clean(path); throw error; }
  }
  async getObject(bucket, key, { expectedGeneration, expectedBlobId, versionId } = {}) {
    const row = this._object(bucket, key, { versionId });
    this._assertGeneration(bucket,key,row,expectedGeneration ?? expectedBlobId);
    const cacheKey = `${bucket}\0${key}`, cached = this.cache.get(cacheKey);
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
  async deleteObject(bucket,key,{versionId}={}) {
    this._bucket(bucket); validKey(key);
    return this._locked(()=>{
      const latest=this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? ORDER BY seq DESC LIMIT 1').get(bucket,key);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        let result;
        if(versionId!==undefined) {
          const row=this.db.prepare('SELECT * FROM object_versions WHERE bucket=? AND key=? AND version_id=?').get(bucket,key,versionId);
          if(row) { if(!row.delete_marker)this._retire(row.blob_id,this._nodesFor(row)); this.db.prepare('DELETE FROM object_versions WHERE version_id=?').run(versionId); }
          result={versionId,isDeleteMarker:Boolean(row?.delete_marker)};
        } else if(latest?.delete_marker) result=metadata(latest);
        else { const row={version_id:randomUUID(),bucket,key,blob_id:'',size:0,etag:'',sha256:'',modified_at:new Date().toISOString(),content_type:'',replicas:'[]',delete_marker:1,owner:''};this._insertVersion(row);result=metadata(row); }
        this._refreshCurrent(bucket,key); this.db.exec('COMMIT');return result;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    });
  }
  async restoreObject(bucket,key,versionId,options={}) { const current=await this.getObject(bucket,key,{versionId}); try{return await this.putObject(bucket,key,current.stream,{...options,contentType:current.metadata.contentType});}finally{current.stream.destroy?.();} }
  async listObjectVersions(bucket,{prefix='',delimiter='',maxKeys=1000,keyMarker='',versionIdMarker}={}) {
    this._bucket(bucket); if(typeof prefix!=='string'||typeof delimiter!=='string'||!Number.isInteger(maxKeys)||maxKeys<0||maxKeys>1000||typeof keyMarker!=='string'||versionIdMarker!==undefined&&!keyMarker) fail('InvalidArgument','Invalid version-list arguments.');
    let markerSeq; if(versionIdMarker!==undefined) { const marker=this.db.prepare('SELECT seq FROM object_versions WHERE bucket=? AND key=? AND version_id=?').get(bucket,keyMarker,versionIdMarker); if(!marker)fail('InvalidArgument','The version marker does not exist.');markerSeq=marker.seq; }
    const rows=this.db.prepare('SELECT v.*,(v.seq=(SELECT MAX(w.seq) FROM object_versions w WHERE w.bucket=v.bucket AND w.key=v.key)) AS latest FROM object_versions v WHERE bucket=? AND substr(key,1,length(?))=? ORDER BY key,seq DESC').all(bucket,prefix,prefix);
    const entries=[],seen=new Set();let truncated=false;
    for(const row of rows){if(row.key<keyMarker||row.key===keyMarker&&(markerSeq===undefined||row.seq>=markerSeq))continue;const pos=delimiter?row.key.indexOf(delimiter,prefix.length):-1; const group=pos<0?null:row.key.slice(0,pos+delimiter.length);if(group&&(group<=keyMarker||seen.has(group)))continue;if(entries.length>=maxKeys){truncated=maxKeys>0;break;}if(group){seen.add(group);entries.push({prefix:group});}else entries.push({...metadata(row),isLatest:Boolean(row.latest)});}
    const last=entries.at(-1); return{versions:entries.filter(x=>!('prefix'in x)),commonPrefixes:entries.filter(x=>'prefix'in x).map(x=>x.prefix),isTruncated:truncated,nextKeyMarker:truncated?(last.prefix??last.key):undefined,nextVersionIdMarker:truncated&&!last.prefix?last.versionId:undefined};
  }
  async listTrash(bucket,{prefix='',maxKeys=1000}={}) {
    this._bucket(bucket);return this.db.prepare('SELECT v.* FROM object_versions v WHERE bucket=? AND substr(key,1,length(?))=? AND delete_marker=1 AND seq=(SELECT MAX(w.seq) FROM object_versions w WHERE w.bucket=v.bucket AND w.key=v.key) ORDER BY key LIMIT ?').all(bucket,prefix,prefix,Math.min(1000,maxKeys)).map(row=>({...metadata(row),restoreVersionId:this.db.prepare('SELECT version_id FROM object_versions WHERE bucket=? AND key=? AND delete_marker=0 ORDER BY seq DESC LIMIT 1').get(bucket,row.key)?.version_id}));
  }
  _upload(bucket,key,uploadId,options={}) {
    this._bucket(bucket);validKey(key);const row=this.db.prepare('SELECT * FROM multipart_uploads WHERE upload_id=? AND bucket=? AND key=?').get(uploadId,bucket,key);
    if(!row)fail('NoSuchUpload','The multipart upload does not exist.',404);
    if(options.owner!==undefined&&row.owner!==options.owner&&!options.allowOwnerOverride)fail('AccessDenied','This multipart upload belongs to another user.',403);
    return row;
  }
  async createMultipartUpload(bucket,key,{contentType='application/octet-stream',owner='',...options}={}) {
    this._bucket(bucket);validKey(key);this._validateContentType(contentType);
    return this._locked(async()=>{this._assertWritableTopology();await this._checkQuota(bucket,owner,0,1,options);const uploadId=randomUUID(),initiated=new Date().toISOString();this.db.prepare('INSERT INTO multipart_uploads VALUES(?,?,?,?,?,?)').run(uploadId,bucket,key,contentType,initiated,owner);return{bucket,key,uploadId,initiated,owner,contentType};});
  }
  async uploadPart(bucket,key,uploadId,partNumber,source,options={}) {
    if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000)fail('InvalidArgument','Part number must be between 1 and 10000.');
    const upload=this._upload(bucket,key,uploadId,options);
    return this._queued(async()=>{const reservation=await this._reservation(bucket,upload.owner,0,options),temporary=join(this.tempDir,randomUUID());
      try{const info=await writeStreamFile(temporary,this._reservedBody(source,reservation,options),this.maxObjectBytes);this._assertChecks(info,options);
        return await this._locked(async()=>{this._upload(bucket,key,uploadId,options);await this._checkQuota(bucket,upload.owner,0,0,options);this._assertWritableTopology();const retained=this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM multipart_parts WHERE upload_id=? AND part_number<>?').get(uploadId,partNumber).bytes;if(retained+info.size>this.maxObjectBytes)fail('EntityTooLarge','Multipart parts exceed the configured object limit.',413);const targets=this._placements(bucket,key),id=randomUUID();this._retire(id,targets);
          const results=await Promise.allSettled(targets.map(node=>this._replicate(node,id,temporary,info)));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
          const previous=this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id=? AND part_number=?').get(uploadId,partNumber),modifiedAt=new Date().toISOString();
          this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO multipart_parts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET blob_id=excluded.blob_id,size=excluded.size,etag=excluded.etag,sha256=excluded.sha256,modified_at=excluded.modified_at,replicas=excluded.replicas').run(uploadId,partNumber,id,info.size,info.etag,info.sha256,modifiedAt,JSON.stringify(targets.map(n=>n.id)));if(previous)this._retire(previous.blob_id,this._nodesFor(previous));this.db.prepare('DELETE FROM garbage WHERE blob_id=?').run(id);this.db.prepare('DELETE FROM upload_reservations WHERE id=?').run(reservation);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
          return{partNumber,...info,modifiedAt};});
      }finally{await clean(temporary);await this._locked(()=>this.db.prepare('DELETE FROM upload_reservations WHERE id=?').run(reservation));}
    });
  }
  async listParts(bucket,key,uploadId,{partNumberMarker=0,maxParts=1000,...options}={}) {
    const upload=this._upload(bucket,key,uploadId,options);if(!Number.isInteger(partNumberMarker)||partNumberMarker<0||partNumberMarker>10000||!Number.isInteger(maxParts)||maxParts<0||maxParts>1000)fail('InvalidArgument','Invalid multipart pagination.');
    const rows=this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id=? AND part_number>? ORDER BY part_number LIMIT ?').all(uploadId,partNumberMarker,maxParts+1);const isTruncated=maxParts>0&&rows.length>maxParts;const parts=rows.slice(0,maxParts).map(row=>({partNumber:row.part_number,size:row.size,etag:row.etag,sha256:row.sha256,modifiedAt:row.modified_at}));return{uploadId,key,bucket,owner:upload.owner,parts,isTruncated,nextPartNumberMarker:isTruncated?parts.at(-1).partNumber:undefined};
  }
  async listMultipartUploads(bucket,{prefix='',delimiter='',keyMarker='',uploadIdMarker,maxUploads=1000,owner}={}) {
    this._bucket(bucket);if(typeof prefix!=='string'||typeof delimiter!=='string'||typeof keyMarker!=='string'||!Number.isInteger(maxUploads)||maxUploads<0||maxUploads>1000||uploadIdMarker!==undefined&&!keyMarker)fail('InvalidArgument','Invalid multipart-list arguments.');
    const rows=this.db.prepare('SELECT * FROM multipart_uploads WHERE bucket=? AND substr(key,1,length(?))=? ORDER BY key,upload_id').all(bucket,prefix,prefix),entries=[],seen=new Set();let isTruncated=false;
    for(const row of rows){if(owner!==undefined&&row.owner!==owner)continue;if(row.key<keyMarker||row.key===keyMarker&&(uploadIdMarker===undefined||row.upload_id<=uploadIdMarker))continue;const pos=delimiter?row.key.indexOf(delimiter,prefix.length):-1,group=pos<0?null:row.key.slice(0,pos+delimiter.length);if(group&&(group<=keyMarker||seen.has(group)))continue;if(entries.length>=maxUploads){isTruncated=maxUploads>0;break;}if(group){seen.add(group);entries.push({prefix:group});}else entries.push({key:row.key,uploadId:row.upload_id,initiated:row.initiated,contentType:row.content_type,owner:row.owner,...this.db.prepare('SELECT COUNT(*) AS partCount,COALESCE(SUM(size),0) AS uploadedBytes FROM multipart_parts WHERE upload_id=?').get(row.upload_id)});}
    const last=entries.at(-1);return{uploads:entries.filter(x=>!('prefix'in x)),commonPrefixes:entries.filter(x=>'prefix'in x).map(x=>x.prefix),isTruncated,nextKeyMarker:isTruncated?(last.prefix??last.key):undefined,nextUploadIdMarker:isTruncated&&!last.prefix?last.uploadId:undefined};
  }
  async completeMultipartUpload(bucket,key,uploadId,parts,options={}) {
    if(!Array.isArray(parts)||!parts.length||parts.length>10000)fail('InvalidPart','Provide between 1 and 10000 parts.');let previous=0;
    for(const part of parts){if(!Number.isInteger(part.partNumber)||part.partNumber<1||part.partNumber>10000||typeof part.etag!=='string')fail('InvalidPart','Invalid part.');if(part.partNumber<=previous)fail('InvalidPartOrder','Parts must be in ascending order without duplicates.');previous=part.partNumber;}
    return this._queued(()=>this._locked(async()=>{const upload=this._upload(bucket,key,uploadId,options),rows=[];let size=0;
      for(let i=0;i<parts.length;i++){const part=parts[i],row=this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id=? AND part_number=?').get(uploadId,part.partNumber);if(!row||row.etag!==part.etag.replace(/^"|"$/g,''))fail('InvalidPart','A part is missing or its ETag does not match.');if(i<parts.length-1&&row.size<5*1024**2)fail('EntityTooSmall','Every part except the last must be at least 5 MiB.');size+=row.size;if(size>this.maxObjectBytes)fail('EntityTooLarge','The assembled object exceeds the configured limit.',413);rows.push(row);}
      await this._checkQuota(bucket,upload.owner,0,0,options);const temporary=join(this.tempDir,randomUUID()),storage=this;
      async function* content(){for(const row of rows){let source;for(const node of storage._nodesFor(row)){try{source=await storage._verifiedReplica(node,row);break;}catch{}}if(!source)fail('ServiceUnavailable','No healthy multipart part replica is available.',503);try{yield*createReadStream(source.path);}finally{if(source.temporary)await clean(source.path);}}}
      try{const info=await writeStreamFile(temporary,content(),this.maxObjectBytes);info.etag=createHash('md5').update(Buffer.concat(rows.map(row=>Buffer.from(row.etag,'hex')))).digest('hex')+'-'+rows.length;return await this._publishFile(bucket,key,temporary,info,{contentType:upload.content_type,owner:upload.owner,uploadId});}finally{await clean(temporary);}
    }));
  }
  async abortMultipartUpload(bucket,key,uploadId,options={}) {
    return this._locked(()=>{this._upload(bucket,key,uploadId,options);this.db.exec('BEGIN IMMEDIATE');try{for(const row of this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id=?').all(uploadId))this._retire(row.blob_id,this._nodesFor(row));this.db.prepare('DELETE FROM multipart_uploads WHERE upload_id=?').run(uploadId);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}});
  }
  exportState() {
    const tables={};for(const name of ['settings','buckets','objects','object_versions','multipart_uploads','multipart_parts','bucket_quotas','garbage','upload_reservations'])tables[name]=this.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();return{version:1,tables};
  }
  async importState(snapshot) {
    const names=['settings','buckets','objects','object_versions','multipart_uploads','multipart_parts','bucket_quotas','garbage','upload_reservations'];
    if(snapshot?.version!==1||!snapshot.tables||names.some(name=>!Array.isArray(snapshot.tables[name])))throw new Error('Invalid storage snapshot');
    return this._locked(()=>{this.db.exec('BEGIN IMMEDIATE');try{for(const name of [...names].reverse())this.db.exec(`DELETE FROM ${name}`);for(const name of names){const columns=this.db.prepare(`PRAGMA table_info(${name})`).all().map(column=>column.name);const insert=this.db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);for(const row of snapshot.tables[name])insert.run(...columns.map(column=>row[column]??null));}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.cache.clear();this.cacheSize=0;this.probes.clear();this.config=JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='topology'").get().value);const runtime=this.db.prepare("SELECT value FROM settings WHERE key='runtime'").get();Object.assign(this,this.runtimeDefaults,runtime?JSON.parse(runtime.value):{});});
  }
  async topology() { return { mode: this.config.mode, nodes: this.config.nodes.map(redact) }; }
  async configure({ mode, nodes, migrate = false }) {
    if (!['raid0', 'raid1', 'raid10'].includes(mode) || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 64) fail('InvalidArgument', 'Select raid0, raid1 or raid10 and 1–64 storage nodes.');
    const normalized = nodes.map(node => {
      if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id)) fail('InvalidArgument', 'Node ID must contain 1–64 letters, digits, underscores or hyphens.');
      const label = typeof node.label === 'string' ? node.label.slice(0, 100) : node.id;
      if (node.id === 'local' || node.url === 'local') { if (node.id !== 'local' || node.url !== 'local') fail('InvalidArgument', 'The local node must have both ID and URL local.'); return { id: 'local', url: 'local', label }; }
      let url; try { url = new URL(node.url); } catch { fail('InvalidArgument', 'Invalid storage node URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) && !/^\/volumes\/[a-f0-9-]{36}$/.test(url.pathname)) fail('InvalidArgument', 'Node URL must be an HTTP(S) origin without credentials, path or query.');
      const old = this.config.nodes.find(previous => previous.id === node.id && previous.url === url.origin + (url.pathname === '/' ? '' : url.pathname));
      const token = node.token || old?.token;
      if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) fail('InvalidArgument', 'Node token must contain 32–512 characters.');
      return { id: node.id, label, url: url.origin + (url.pathname === '/' ? '' : url.pathname), token, ...(typeof node.failureDomain === 'string' ? {failureDomain:node.failureDomain.slice(0,100)} : {}) };
    });
    if (new Set(normalized.map(node => node.id)).size !== normalized.length || new Set(normalized.map(node => node.url)).size !== normalized.length) fail('InvalidArgument', 'Node IDs and URLs must be unique.');
    if (mode === 'raid1' && nodes.length < 2) fail('InvalidArgument', 'RAID1 requires at least two nodes.');
    if (mode === 'raid10' && (nodes.length < 4 || nodes.length % 2)) fail('InvalidArgument', 'RAID10 requires an even number of nodes, at least four.');
    return this._locked(async () => {
      this._assertWritableTopology({mode,nodes:normalized});
      const objects = this._allBlobs();
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
            const replicas=JSON.stringify(targets.map(node => node.id));
            this.db.prepare('UPDATE objects SET replicas=? WHERE blob_id=?').run(replicas,row.blob_id);
            this.db.prepare('UPDATE object_versions SET replicas=? WHERE blob_id=?').run(replicas,row.blob_id);
            this.db.prepare('UPDATE multipart_parts SET replicas=? WHERE blob_id=?').run(replicas,row.blob_id);
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
      else { const response = await fetch(`${node.url}/health`, { headers: { authorization: `Bearer ${node.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!response.ok) throw new Error(); const info = await response.json(); value = { online: true, capacityBytes: info.capacityBytes, freeBytes: info.freeBytes, ...(typeof info.filesystemId === 'string' ? {filesystemId:info.filesystemId} : {}) }; }
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
    if(this.garbageCollectionEnabled===false)return{removed:0,failed:0,disabled:true};
    let removed = 0, failed = 0;
    for (const row of this.db.prepare('SELECT * FROM garbage WHERE retired_at<?').all(Date.now() - 3600000)) {
      if (this.readers.has(row.blob_id)) continue;
      let okay = true;
      const live = this.db.prepare('SELECT replicas FROM object_versions WHERE blob_id=? UNION ALL SELECT replicas FROM multipart_parts WHERE blob_id=? LIMIT 1').get(row.blob_id,row.blob_id);
      const liveUrls = new Set(live ? this.config.nodes.filter(node => JSON.parse(live.replicas).includes(node.id)).map(node => node.url) : []);
      for (const node of JSON.parse(row.nodes).filter(node => !liveUrls.has(node.url))) try { if (node.url === 'local') await clean(join(this.blobDir, row.blob_id)); else { const response = await this._fetch(node, `/blobs/${row.blob_id}`, { method: 'DELETE' }); await response.body?.cancel(); if (!response.ok && response.status !== 404) throw new Error(); } } catch { okay = false; }
      if (okay) { this.db.prepare('DELETE FROM garbage WHERE blob_id=?').run(row.blob_id); removed++; } else failed++;
    }
    return { removed, failed };
  }
  async scrub() {
    return this._locked(async () => {
      const result = { checked: 0, repaired: 0, unrecoverable: 0, repairFailed: 0 };
      for (const row of this._allBlobs()) {
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

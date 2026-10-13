import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, unlink, lstat, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { validBucket, syncDirectory } from './storage.mjs';
import { BucketPolicies, normalizeReadPrefixes } from './bucket-policy.mjs';

const JOURNAL = 'initialBootstrap';
const MAX_CONFIG_BYTES = 256 * 1024;
const ENV_FIELDS = ['INIT_ADMIN_USERNAME', 'INIT_ADMIN_PASSWORD', 'INIT_ADMIN_PASSWORD_FILE',
  'INIT_BUCKET', 'INIT_BUCKET_ACCESS', 'INIT_BUCKET_READ_PREFIXES', 'INIT_BUCKET_QUOTA_BYTES', 'INIT_BUCKET_QUOTA_OBJECTS',
  'INIT_S3_ACCESS_KEY', 'INIT_S3_SECRET_KEY', 'INIT_S3_SECRET_KEY_FILE'];
const present = value => value !== undefined && value !== '';
const fail = message => { throw new Error(`Initialization: ${message}`); };

function record(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    fail(`${field} has invalid or unknown fields.`);
  return value;
}
function list(value, field, limit, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > limit || required && value.length === 0) fail(`${field} must be an array with ${required ? '1' : '0'}–${limit} entries.`);
  return value;
}
function number(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a nonnegative safe integer or null.`);
  return value;
}
function parseJSON(value, field) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CONFIG_BYTES) fail(`${field} exceeds the size limit.`);
  try { return JSON.parse(value); } catch { fail(`${field} is not valid JSON.`); }
}
async function textFile(path, limit, field, { noFollow = false } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0')) fail(`${field} must name a readable file.`);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) fail(`${field} must be a regular file within its size limit.`);
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) {
      const chunk = await file.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > limit) fail(`${field} exceeds the size limit.`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { fail(`${field} must contain UTF-8 text.`); }
  } catch (error) {
    if (error.message?.startsWith('Initialization: ')) throw error;
    // Do not include filesystem paths or input values in startup diagnostics.
    fail(`${field} could not be read.`);
  } finally { await file?.close(); }
}
async function secret(input, valueField, fileField, base, label) {
  if (input[valueField] !== undefined && input[fileField] !== undefined) fail(`${label} and its file option cannot both be set.`);
  if (input[fileField] !== undefined) {
    if (typeof input[fileField] !== 'string' || !input[fileField] || input[fileField].includes('\0')) fail(`${label} file path is invalid.`);
    const value = await textFile(resolve(base, input[fileField]), 1026, `${label} file`);
    return { value: value.replace(/\r?\n$/, ''), generated: false };
  }
  if (input[valueField] !== undefined) return { value: input[valueField], generated: false };
  return { value: randomBytes(32).toString('base64url'), generated: true };
}

function environmentPlan(env) {
  const any = ENV_FIELDS.some(field => present(env[field]));
  const enabled = present(env.INIT_ENABLED) ? env.INIT_ENABLED : undefined;
  if (enabled !== undefined && !['true', 'false'].includes(enabled)) fail('INIT_ENABLED must be true or false.');
  if (enabled === 'false' && (any || present(env.INIT_CONFIG_FILE))) fail('INIT_ENABLED=false conflicts with initialization inputs.');
  if (present(env.INIT_CONFIG_FILE)) {
    if (any) fail('INIT_CONFIG_FILE cannot be combined with initialization environment fields.');
    return { file: env.INIT_CONFIG_FILE };
  }
  if (!any && enabled !== 'true') return null;
  const input = Object.fromEntries(ENV_FIELDS.filter(field => present(env[field])).map(field => [field, env[field]]));
  const username = input.INIT_ADMIN_USERNAME ?? 'admin';
  const user = { username, role: 'admin',
    ...(input.INIT_ADMIN_PASSWORD === undefined ? {} : { password: input.INIT_ADMIN_PASSWORD }),
    ...(input.INIT_ADMIN_PASSWORD_FILE === undefined ? {} : { passwordFile: input.INIT_ADMIN_PASSWORD_FILE }) };
  const buckets = [];
  if (!input.INIT_BUCKET && ['INIT_BUCKET_ACCESS', 'INIT_BUCKET_READ_PREFIXES', 'INIT_BUCKET_QUOTA_BYTES', 'INIT_BUCKET_QUOTA_OBJECTS'].some(field => field in input))
    fail('Bucket options require INIT_BUCKET.');
  if (input.INIT_BUCKET) {
    const envQuota = field => {
      if (input[field] === undefined) return null;
      if (typeof input[field] !== 'string' || !/^(0|[1-9]\d*)$/.test(input[field])) fail(`${field} must be a nonnegative integer.`);
      return number(Number(input[field]), field);
    };
    buckets.push({ name: input.INIT_BUCKET, quotaBytes: envQuota('INIT_BUCKET_QUOTA_BYTES'), quotaObjects: envQuota('INIT_BUCKET_QUOTA_OBJECTS'),
      access: { mode: input.INIT_BUCKET_ACCESS ?? 'private', readPrefixes: input.INIT_BUCKET_READ_PREFIXES === undefined ? [] : parseJSON(input.INIT_BUCKET_READ_PREFIXES, 'INIT_BUCKET_READ_PREFIXES') } });
  }
  const keys = [];
  if (input.INIT_BUCKET || ['INIT_S3_ACCESS_KEY', 'INIT_S3_SECRET_KEY', 'INIT_S3_SECRET_KEY_FILE'].some(field => field in input)) {
    keys.push({ label: 'Initial application key', owner: username, buckets: input.INIT_BUCKET ? [input.INIT_BUCKET] : [],
      ...(input.INIT_S3_ACCESS_KEY === undefined ? {} : { accessKey: input.INIT_S3_ACCESS_KEY }),
      ...(input.INIT_S3_SECRET_KEY === undefined ? {} : { secretKey: input.INIT_S3_SECRET_KEY }),
      ...(input.INIT_S3_SECRET_KEY_FILE === undefined ? {} : { secretKeyFile: input.INIT_S3_SECRET_KEY_FILE }) });
  }
  return { config: { version: 1, users: [user], buckets, keys } };
}

async function normalizePlan(config, base) {
  record(config, ['version', 'users', 'keys', 'buckets'], 'configuration');
  if (config.version !== 1) fail('configuration version must be 1.');
  const users = [], keys = [], buckets = [];
  const credentials = { version: 1, createdAt: new Date().toISOString(), users: [], keys: [] };
  for (const input of list(config.users, 'users', 1000, { required: true })) {
    record(input, ['username', 'password', 'passwordFile', 'role', 'quotaBytes', 'quotaObjects', 'language'], 'user');
    if (!['admin', 'operator', 'viewer'].includes(input.role)) fail('user role must be admin, operator or viewer.');
    const password = await secret(input, 'password', 'passwordFile', base, 'password');
    users.push({ username: input.username, password: password.value, role: input.role,
      quotaBytes: number(input.quotaBytes, 'user quotaBytes'), quotaObjects: number(input.quotaObjects, 'user quotaObjects'), language: input.language ?? 'en' });
    credentials.users.push({ username: input.username, password: password.value, role: input.role, generated: password.generated });
  }
  for (const input of list(config.buckets, 'buckets', 1000)) {
    record(input, ['name', 'quotaBytes', 'quotaObjects', 'access'], 'bucket');
    validBucket(input.name);
    const access = input.access ?? { mode: 'private', readPrefixes: [] };
    record(access, ['mode', 'readPrefixes'], 'bucket access');
    if (!['private', 'public-read'].includes(access.mode)) fail('bucket access mode must be private or public-read.');
    buckets.push({ name: input.name, quotaBytes: number(input.quotaBytes, 'bucket quotaBytes'), quotaObjects: number(input.quotaObjects, 'bucket quotaObjects'),
      access: { mode: access.mode, readPrefixes: normalizeReadPrefixes(access.readPrefixes) } });
  }
  if (new Set(buckets.map(bucket => bucket.name)).size !== buckets.length) fail('bucket names must be unique.');
  for (const input of list(config.keys, 'keys', 1000)) {
    record(input, ['label', 'owner', 'role', 'buckets', 'prefixes', 'permissions', 'accessKey', 'secretKey', 'secretKeyFile'], 'key');
    const secretKey = await secret(input, 'secretKey', 'secretKeyFile', base, 'secretKey');
    const generatedAccess = input.accessKey === undefined, accessKey = generatedAccess ? `G27${randomBytes(10).toString('hex').toUpperCase()}` : input.accessKey;
    for (const bucket of list(input.buckets, 'key buckets', 100)) validBucket(bucket);
    keys.push({ label: input.label, owner: input.owner, role: input.role, buckets: input.buckets, prefixes: input.prefixes, permissions: input.permissions, accessKey, secretKey: secretKey.value });
    credentials.keys.push({ label: input.label, owner: input.owner, accessKey, secretKey: secretKey.value, generated: { accessKey: generatedAccess, secretKey: secretKey.generated } });
  }
  return { users, keys, buckets, createdAt: credentials.createdAt, credentials };
}

async function credentialsOutput(path, contents) {
  const serialized = JSON.stringify(contents, null, 2) + '\n';
  const expected = Buffer.from(serialized), directory = dirname(path);
  const matches = async (file, partial = false) => {
    const info = await file.stat();
    if (!info.isFile() || (partial ? info.size === 0 || info.size > expected.length : info.size !== expected.length)) return false;
    const actual = Buffer.alloc(expected.length + 1); let size = 0;
    while (size < actual.length) {
      const { bytesRead } = await file.read(actual, size, actual.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return partial
      ? size > 0 && size <= expected.length && actual.subarray(0, size).equals(expected.subarray(0, size))
      : actual.subarray(0, size).equals(expected);
  };
  const checkExisting = async () => {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      if (error.code === 'ELOOP') fail('credentials output must not be a symbolic link.');
      throw error;
    }
    try {
      if (!await matches(file)) fail('credentials output already exists with different contents; it was not overwritten.');
      await file.chmod(0o600);
      // A previous process may have stopped immediately after publishing the
      // hard link. Resume must persist both inode and directory before dropping
      // the encrypted recovery credentials from the pending journal.
      await file.sync();
    } finally { await file.close(); }
    await syncDirectory(directory);
    return true;
  };
  if (!await checkExisting()) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST' || !await checkExisting()) throw error; }
      await syncDirectory(directory);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  // Remove only temporary copies (including interrupted prefix writes) from
  // this exact pending plan. Different contents and symlinks are preserved.
  const prefix = `${basename(path)}.`;
  const temporarySuffix = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !temporarySuffix.test(entry.name.slice(prefix.length))) continue;
    const candidate = resolve(directory, entry.name); let file;
    try {
      file = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      if (!await matches(file, true)) continue;
      const opened = await file.stat(), current = await lstat(candidate);
      if (current.isFile() && opened.dev === current.dev && opened.ino === current.ino) await unlink(candidate);
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
    } finally { await file?.close(); }
  }
  await syncDirectory(directory);
}

async function resume({ auth, storage, journal }) {
  if (!journal || journal.version !== 1 || journal.status !== 'pending' || typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt)) || !Array.isArray(journal.buckets) || typeof journal.credentials !== 'string')
    fail('stored initialization journal is invalid.');
  let credentials;
  try { credentials = JSON.parse(auth.decrypt(journal.credentials)); }
  catch { fail('stored initialization credentials could not be verified.'); }
  if (credentials.version !== 1 || credentials.createdAt !== journal.createdAt || !Array.isArray(credentials.users) || !Array.isArray(credentials.keys)) fail('stored initialization credentials are invalid.');
  // A fixed creation timestamp identifies exactly the buckets claimed by this
  // journal. An unrelated/recreated bucket is never silently reconfigured.
  await storage._locked(() => {
    storage.db.exec('BEGIN IMMEDIATE');
    try {
      for (const bucket of journal.buckets) {
        validBucket(bucket.name);
        const existing = storage.db.prepare('SELECT created_at FROM buckets WHERE name=?').get(bucket.name);
        if (existing && existing.created_at !== journal.createdAt) fail('a bucket belongs to a different initialization; it was not changed.');
        if (!existing) storage.db.prepare('INSERT INTO buckets (name,created_at) VALUES (?,?)').run(bucket.name, journal.createdAt);
      }
      storage.db.exec('COMMIT');
    } catch (error) { storage.db.exec('ROLLBACK'); throw error; }
  });
  const policies = new BucketPolicies({ auth, storage });
  for (const bucket of journal.buckets) {
    await storage.setBucketQuota(bucket.name, { maxBytes: bucket.quotaBytes, maxObjects: bucket.quotaObjects });
    await policies.set(bucket.name, bucket.access);
  }
  const credentialsFile = resolve(auth.dataDir, 'init-credentials.json');
  await credentialsOutput(credentialsFile, credentials);
  auth.db.exec('BEGIN IMMEDIATE');
  try {
    // Once the output file is durable, no reversible copy of initial passwords
    // is needed in the replicated authentication snapshot.
    auth.setPreference(JOURNAL, { version: 1, status: 'done', createdAt: journal.createdAt, completedAt: new Date().toISOString() });
    auth.audit('system.initialization_completed', `${journal.buckets.length} buckets`);
    auth.db.exec('COMMIT');
  } catch (error) { auth.db.exec('ROLLBACK'); throw error; }
  return credentialsFile;
}

// Called while the HTTP listener is closed. In HA this belongs exclusively in
// the fenced first-authoritative-snapshot callback, never on an ordinary join.
export async function initializeSystem({ auth, storage, env = process.env }) {
  const journal = auth.preference(JOURNAL, null);
  if (journal?.version === 1 && journal.status === 'done') return { status: 'skipped' };
  if (journal) return { status: 'resumed', credentialsFile: await resume({ auth, storage, journal }) };
  if (auth.db.prepare('SELECT 1 FROM users LIMIT 1').get() || auth.db.prepare('SELECT 1 FROM access_keys LIMIT 1').get() || storage.db.prepare('SELECT 1 FROM buckets LIMIT 1').get()) return { status: 'skipped' };
  const defaultTopology = { mode: 'raid0', nodes: [{ id: 'local', url: 'local', label: 'Coordinator storage' }] };
  if (storage.db.prepare("SELECT 1 FROM settings WHERE key <> 'topology' LIMIT 1").get() || JSON.stringify(storage.config) !== JSON.stringify(defaultTopology)) return { status: 'skipped' };
  const selected = environmentPlan(env);
  if (!selected) { await auth.initializeDefaults(); return { status: 'defaults' }; }
  // Additional evidence of a previous installation must not be interpreted as
  // an empty deployment simply because its user table was manually removed.
  if (auth.db.prepare('SELECT 1 FROM audit LIMIT 1').get() || auth.db.prepare('SELECT 1 FROM preferences LIMIT 1').get() || storage.db.prepare('SELECT 1 FROM object_versions LIMIT 1').get() || storage.db.prepare('SELECT 1 FROM multipart_uploads LIMIT 1').get())
    fail('existing installation metadata prevents first-run initialization.');
  let config = selected.config, base = process.cwd();
  if (selected.file) {
    if (typeof selected.file !== 'string' || selected.file.includes('\0')) fail('INIT_CONFIG_FILE must name a readable file.');
    const path = resolve(selected.file); base = dirname(path);
    config = parseJSON(await textFile(path, MAX_CONFIG_BYTES, 'INIT_CONFIG_FILE'), 'INIT_CONFIG_FILE');
  }
  const prepared = await normalizePlan(config, base);
  const pending = await auth.initializeBootstrap(prepared);
  return { status: 'initialized', credentialsFile: await resume({ auth, storage, journal: pending }) };
}

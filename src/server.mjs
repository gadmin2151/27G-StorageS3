import http from 'node:http';
import { readFile, writeFile, mkdir, open, unlink, realpath, link } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isIP, createServer as createNetServer } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Storage } from './storage.mjs';
import { handleS3 } from './s3.mjs';
import { Auth, ApiError } from './auth.mjs';
import { Shares } from './shares.mjs';
import { featureAPI } from './admin-features.mjs';
import { Monitor } from './monitor.mjs';
import { normalizePublicOrigin, normalizeCorsOrigins, applyS3Cors } from './service-settings.mjs';
import { HaCoordinator } from './ha.mjs';
import { CommitResponse } from './ha-response.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const VERSION = '0.2.0';
const mutations = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const staticFiles = new Map([
  ['/console', ['index.html', 'text/html; charset=utf-8']],
  ['/console/', ['index.html', 'text/html; charset=utf-8']],
  ['/console/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/console/features.js', ['features.js', 'text/javascript; charset=utf-8']],
  ['/console/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/console/storage-mark.svg', ['storage-mark.svg', 'image/svg+xml']],
]);
const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};
async function bodyJSON(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Ожидается application/json.');
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 65536) throw new ApiError(413, 'Слишком большой запрос.');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'Некорректный JSON.'); }
}
function int(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}
async function acquireLock(dataDir) {
  const path = join(dataDir, 'coordinator.lock');
  async function identity(pid) {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return { pid, boot, start };
  }
  const owner = { ...await identity(process.pid), nonce: randomUUID() };
  // One process per data volume. Never share this volume between containers/hosts.
  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = join(dataDir, `.lock-${randomUUID()}`);
    try {
      const file = await open(temp, 'wx', 0o600);
      await file.writeFile(JSON.stringify(owner)); await file.sync(); await file.close();
      // Publish a complete owner record atomically; crashes cannot leave a partial lock.
      await link(temp, path);
      return async () => {
        try { if (JSON.parse(await readFile(path, 'utf8')).nonce === owner.nonce) await unlink(path); } catch {}
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* fail closed */ }
      if (!previous || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !previous.boot || !previous.start) throw new Error('Invalid coordinator.lock; inspect before removing it');
      try {
        const current = await identity(previous.pid);
        if (previous.boot !== current.boot || previous.start !== current.start) { await unlink(path); continue; }
      }
      catch (error) {
        if (error.code === 'ENOENT') { await unlink(path); continue; }
        throw error;
      }
      throw new Error('This data directory is already owned by a running coordinator');
    } finally { await unlink(temp).catch(() => {}); }
  }
  throw new Error('Unable to acquire coordinator.lock');
}

async function acquireLease(dataDir) {
  // Linux abstract sockets are released by the kernel even after SIGKILL. Holding
  // this lease also serializes stale-file reclamation between concurrent starters.
  const lease = createNetServer(socket => socket.destroy());
  const address = `\0storeges3-${createHash('sha256').update(dataDir).digest('hex')}`;
  await new Promise((done, reject) => {
    lease.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error('This data directory is already owned by a running coordinator') : error));
    lease.listen(address, done);
  });
  return () => new Promise(done => lease.close(done));
}

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonicalDir = await realpath(dataDir);
  const releaseLease = await acquireLease(canonicalDir);
  let releaseFile;
  try { releaseFile = await acquireLock(canonicalDir); }
  catch (error) { await releaseLease(); throw error; }
  const releaseLock = async () => { await releaseFile(); await releaseLease(); };
  let publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) { await releaseLock(); throw new Error('PUBLIC_ORIGIN must be an http(s) origin, without a trailing slash'); }
  let secureCookies = publicOrigin.startsWith('https://');
  let auth, storage, shares, ha;
  const haOptions = options.ha || (process.env.HA_ETCD_ENDPOINTS ? { endpoints: process.env.HA_ETCD_ENDPOINTS.split(','), nodeId: process.env.HA_NODE_ID, role: process.env.HA_ROLE || 'slave', clusterId: process.env.HA_CLUSTER_ID || 'storeges3' } : null);
  try {
    const maxObjectBytes = int(options.maxObjectBytes ?? process.env.MAX_OBJECT_BYTES, 5 * 1024 ** 3, 1, 5 * 1024 ** 3, 'MAX_OBJECT_BYTES');
    storage = new Storage({ dataDir, maxObjectBytes,
      cacheBytes: int(options.cacheBytes ?? process.env.CACHE_BYTES, 64 * 1024 ** 2, 0, 1024 ** 3, 'CACHE_BYTES'),
      concurrency: int(options.concurrency ?? process.env.UPLOAD_CONCURRENCY, 4, 1, 32, 'UPLOAD_CONCURRENCY'),
      queueLimit: int(options.queueLimit ?? process.env.QUEUE_LIMIT, 32, 1, 1024, 'QUEUE_LIMIT'),
    });
    await storage.init();
    if (haOptions && process.env.HA_ETCD_CA_FILE) {
      haOptions.tls = { ca: await readFile(process.env.HA_ETCD_CA_FILE), ...(process.env.HA_ETCD_CERT_FILE ? { cert: await readFile(process.env.HA_ETCD_CERT_FILE) } : {}), ...(process.env.HA_ETCD_KEY_FILE ? { key: await readFile(process.env.HA_ETCD_KEY_FILE) } : {}) };
    }
    if (haOptions && process.env.HA_SETUP_TOKEN_FILE && options.setupToken === undefined) options.setupToken = (await readFile(process.env.HA_SETUP_TOKEN_FILE, 'utf8')).trim();
    if (haOptions && process.env.HA_MASTER_KEY_FILE) {
      const sharedKey = await readFile(process.env.HA_MASTER_KEY_FILE);
      if (sharedKey.length !== 32) throw new Error('HA_MASTER_KEY_FILE must contain exactly 32 bytes');
      try { const current = await readFile(join(dataDir, 'master.key')); if (!current.equals(sharedKey)) throw new Error('Existing master.key differs from HA key; migrate secrets before enabling HA'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(join(dataDir, 'master.key'), sharedKey, { flag: 'wx', mode: 0o600, flush: true }); }
    }
    auth = new Auth({ dataDir, secureCookies, setupToken: options.setupToken ?? process.env.SETUP_TOKEN });
    await auth.initializeDefaults();
    shares = new Shares({ dataDir });
    const monitor = new Monitor(auth);
    let scrubIntervalSeconds = auth.preference('scrubIntervalSeconds', 900);
    let lastScrub = auth.preference('lastScrubAt', null);
    storage.quotaPolicy = username => username ? auth.userPolicy(username) : {};
    function refreshPreferences() {
      publicOrigin = normalizePublicOrigin(process.env.PUBLIC_ORIGIN_OVERRIDE ?? auth.preference('publicOrigin', options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? ''));
      scrubIntervalSeconds = auth.preference('scrubIntervalSeconds', 900); lastScrub = auth.preference('lastScrubAt', null);
      secureCookies = publicOrigin.startsWith('https://'); auth.secureCookies = secureCookies;
    }
    refreshPreferences();
    if (haOptions) {
      storage.requireRemoteMirrors = true; storage.garbageCollectionEnabled = false;
      ha = new HaCoordinator({ ...haOptions, dataDir, encryptionKey: auth.masterKey,
        exportState: () => ({ storage: storage.exportState(), auth: auth.exportState(), shares: shares.exportState() }),
        importState: async state => { await storage.importState(state.storage); auth.importState(state.auth); shares.importState(state.shares); refreshPreferences(); },
        validateState: state => {
          const topology = JSON.parse(state.storage.tables.settings.find(row => row.key === 'topology').value);
          const hasData = state.storage.tables.object_versions.length || state.storage.tables.multipart_uploads.length;
          if (hasData && (topology.mode === 'raid0' || topology.nodes.some(node => node.url === 'local'))) throw new ApiError(503, 'До включения HA перенесите данные на зеркальные HTTP-узлы.');
        },
      });
      await ha.start();
    }
    const guarded = (write, work) => ha ? ha.run({ write }, work) : work();
    const started = Date.now();
    const trustedProxyIPs = (options.trustedProxyIPs ?? process.env.TRUSTED_PROXY_IPS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (trustedProxyIPs.some(ip => !isIP(ip))) throw new Error('TRUSTED_PROXY_IPS must be a comma-separated list of exact IP addresses');
    function clientIP(req) {
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      const forwarded = req.headers['x-27g-client-ip'];
      return trustedProxyIPs.includes(peer) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
    }
    function localDefaultLogin(req) {
      const loopback = address => {
        const normalized = address?.replace(/^::ffff:/, '');
        return normalized === '::1' || (isIP(normalized || '') === 4 && normalized.startsWith('127.'));
      };
      // The listener itself must be private: a loopback connection to a wildcard
      // listener (including Docker/proxy traffic) does not grant this exception.
      const address = server.address();
      return !publicOrigin && trustedProxyIPs.length === 0 && typeof address === 'object' && address !== null &&
        loopback(address.address) && loopback(req.socket.remoteAddress);
    }
    let maintenance = null;
    let background = null;
    const maintenanceTimer = setInterval(() => {
      if ((ha && !ha.isLeader) || !scrubIntervalSeconds || maintenance || Date.now() < (lastScrub ?? started) + scrubIntervalSeconds * 1000) return;
      maintenance = { action: 'automatic-scrub', startedAt: new Date().toISOString() };
      background = guarded(true, async () => { const result = await storage.scrub(); auth.setPreference('lastScrubResult', result); auth.setPreference('lastScrubAt', Date.now()); auth.audit('cluster.automatic_scrub', JSON.stringify(result)); })
        .catch(error => { console.error(JSON.stringify({ event: 'automatic_scrub.failed', code: error.code || 'InternalError' })); })
        .finally(() => { maintenance = null; background = null; lastScrub = Date.now(); });
    }, 30_000);
    maintenanceTimer.unref();
    async function admin(req, res, url) {
      refreshPreferences();
      const path = url.pathname, method = req.method, mutation = mutations.has(method);
      if (mutation) {
        const origin = req.headers.origin;
        const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
        if (origin && origin !== expectedOrigin) throw new ApiError(403, 'Запрос с другого сайта запрещён.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'Запрос с другого сайта запрещён.');
      }
      if (path === '/api/session' && method === 'GET') {
        const session = auth.session(req);
        return json(res, 200, { authenticated: !!session, defaultCredentials: auth.defaultCredentials,
          setupTokenRequired: auth.defaultCredentials && !localDefaultLogin(req), ...(session ? { csrf: session.csrf, user: session.user, role: session.role } : {}) });
      }
      if (path === '/api/login' && method === 'POST') {
        const session = await auth.login(await bodyJSON(req), clientIP(req), { allowDefaultWithoutToken: localDefaultLogin(req) });
        res.setHeader('Set-Cookie', auth.cookie(session.token));
        return json(res, 200, { user: session.user, csrf: session.csrf, role: session.role, defaultCredentials: auth.defaultCredentials });
      }
      const session = auth.requireSession(req, mutation);
      const personal = ['/api/logout', '/api/password', '/api/mfa/enroll', '/api/mfa/confirm', '/api/mfa/disable'];
      if (mutation && session.role === 'viewer' && !personal.includes(path)) throw new ApiError(403, 'Роль наблюдателя разрешает только чтение.');
      if (mutation && session.role !== 'admin' && ['/api/settings', '/api/topology', '/api/scrub'].includes(path)) throw new ApiError(403, 'Это действие доступно только администратору.');
      if (await featureAPI(req, res, url, { auth, storage, session, json: (...args) => { json(...args); return true; }, bodyJSON, clientIP, monitor, getHa: () => ha, publicOrigin })) return;
      if (path === '/api/logout' && method === 'POST') {
        auth.logout(req); res.setHeader('Set-Cookie', auth.cookie('', true)); return json(res, 200, { ok: true });
      }
      if (path === '/api/password' && method === 'PUT') {
        const updated = await auth.changePassword(session.user, await bodyJSON(req), clientIP(req));
        res.setHeader('Set-Cookie', auth.cookie(updated.token));
        return json(res, 200, { user: updated.user, csrf: updated.csrf, role: updated.role, defaultCredentials: auth.defaultCredentials });
      }
      if (path === '/api/status' && method === 'GET') {
        return json(res, 200, { ...await storage.status(), uptime: Math.floor((Date.now() - started) / 1000), version: VERSION,
          endpoint: publicOrigin || `http://${req.headers.host}`, security: { secureCookies, defaultCredentials: auth.defaultCredentials }, maintenance, ha: ha?.status() || { enabled: false }, singleCoordinator: !ha,
          automaticRepair: { intervalSeconds: scrubIntervalSeconds, lastRun: lastScrub ? new Date(lastScrub).toISOString() : null, nextRun: scrubIntervalSeconds ? new Date((lastScrub ?? started) + scrubIntervalSeconds * 1000).toISOString() : null },
          limitations: [ha ? 'HA master/slave: нужен quorum etcd; физическая очистка старых blobs отключена.' : 'Одиночный координатор: для failover включите HA master/slave с арбитром.', 'S3: multipart и последние 5 версий; AWS IAM, streaming signatures и trailers не поддерживаются.', 'Экспериментальная версия: нагрузочные испытания и независимый аудит ещё не проведены.'] });
      }
      if (path === '/api/buckets') {
        if (method === 'GET') return json(res, 200, { buckets: await storage.buckets() });
        if (method === 'POST') {
          const { name } = await bodyJSON(req);
          if (['api', 'console', 'healthz', 'share'].includes(name)) throw new ApiError(400, 'Это имя зарезервировано системой.');
          await storage.createBucket(name); auth.audit('bucket.created', name); return json(res, 201, { name });
        }
      }
      if (path.startsWith('/api/buckets/') && method === 'DELETE') {
        const name = decodeURIComponent(path.slice('/api/buckets/'.length));
        await storage.deleteBucket(name); auth.audit('bucket.deleted', name); return json(res, 200, { ok: true });
      }
      if (path === '/api/objects' && method === 'GET') {
        return json(res, 200, await storage.listObjects(url.searchParams.get('bucket'), {
          prefix: url.searchParams.get('prefix') || '', maxKeys: 200,
          continuationToken: url.searchParams.get('continuationToken') || undefined,
        }));
      }
      if (path === '/api/object') {
        const bucket = url.searchParams.get('bucket'), key = url.searchParams.get('key');
        if (!bucket || !key) throw new ApiError(400, 'Укажите бакет и ключ объекта.');
        if (method === 'PUT') {
          if (Number(req.headers['content-length']) > maxObjectBytes) throw new ApiError(413, 'Объект превышает лимит размера.');
          const metadata = await storage.putObject(bucket, key, req, { contentType: req.headers['content-type'] || 'application/octet-stream', owner: session.user });
          auth.audit('object.uploaded', `${bucket}/${key}`); return json(res, 200, metadata);
        }
        if (method === 'GET') {
          const { metadata, stream } = await storage.getObject(bucket, key, { versionId: url.searchParams.get('versionId') || undefined });
          const filename = key.split('/').pop().replace(/[\r\n]/g, '_');
          // Always download user content: never execute uploaded HTML/SVG on the console origin.
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': metadata.size,
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`,
            'Cache-Control': 'no-store' });
          await pipeline(stream, res); return;
        }
        if (method === 'DELETE') {
          await storage.deleteObject(bucket, key); auth.audit('object.deleted', `${bucket}/${key}`); return json(res, 200, { ok: true });
        }
      }
      if (path === '/api/shares' && ['GET', 'POST'].includes(method)) {
        const input = method === 'POST' ? await bodyJSON(req) : { bucket: url.searchParams.get('bucket'), key: url.searchParams.get('key') };
        if (typeof input.bucket !== 'string' || !input.bucket || typeof input.key !== 'string' || !input.key)
          throw new ApiError(400, 'Укажите бакет и ключ объекта.');
        const blobId = await storage.objectGeneration(input.bucket, input.key);
        if (method === 'GET') return json(res, 200, { shares: shares.list(input.bucket, input.key, blobId) });
        const { token, ...created } = shares.create({ ...input, blobId });
        auth.audit('share.created', `${created.id}; ${input.bucket}/${input.key}`);
        return json(res, 201, { ...created, url: `${publicOrigin || `http://${req.headers.host}`}/share/${token}` });
      }
      if (path.startsWith('/api/shares/') && method === 'DELETE') {
        const id = path.slice('/api/shares/'.length);
        shares.revoke(id); auth.audit('share.revoked', id);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/topology') {
        if (method === 'GET') return json(res, 200, await storage.topology());
        if (method === 'PUT') {
          if (maintenance) throw new ApiError(409, 'Дождитесь завершения текущей операции.');
          const configuration = await bodyJSON(req);
          if (maintenance) throw new ApiError(409, 'Дождитесь завершения текущей операции.');
          maintenance = { action: 'topology', startedAt: new Date().toISOString() };
          try {
            const result = await storage.configure(configuration);
            auth.audit('cluster.configured', `${configuration.mode}; ${configuration.nodes?.length} nodes`);
            return json(res, 200, result || await storage.topology());
          } finally { maintenance = null; }
        }
      }
      if (path === '/api/scrub' && method === 'POST') {
        if (maintenance) throw new ApiError(409, 'Дождитесь завершения текущей операции.');
        maintenance = { action: 'scrub', startedAt: new Date().toISOString() };
        try {
          const result = await storage.scrub(); auth.setPreference('lastScrubResult', result); auth.setPreference('lastScrubAt', Date.now()); auth.audit('cluster.scrub', JSON.stringify(result));
          return json(res, 200, result);
        } finally { maintenance = null; lastScrub = Date.now(); }
      }
      if (path === '/api/keys') {
        if (method === 'GET') return json(res, 200, { keys: auth.listKeys(session.role === 'admin' ? undefined : session.user) });
        if (method === 'POST') { const input = await bodyJSON(req); return json(res, 201, auth.createKey(input, { owner: session.role === 'admin' ? input.owner || session.user : session.user })); }
      }
      if (path.startsWith('/api/keys/') && method === 'DELETE') {
        auth.revokeKey(decodeURIComponent(path.slice('/api/keys/'.length)), session.role === 'admin' ? undefined : session.user); return json(res, 200, { ok: true });
      }
      if (path === '/api/settings') {
        if (method === 'GET') {
          const status = await storage.status();
          return json(res, 200, { cacheBytes: status.cache.limit, concurrency: status.queue.concurrency, queueLimit: status.queue.limit, maxObjectBytes, scrubIntervalSeconds, publicOrigin, corsOrigins: auth.preference('corsOrigins', []) });
        }
        if (method === 'PUT') {
          const values = await bodyJSON(req);
          const nextOrigin = values.publicOrigin === undefined ? publicOrigin : normalizePublicOrigin(values.publicOrigin);
          const nextCors = values.corsOrigins === undefined ? auth.preference('corsOrigins', []) : normalizeCorsOrigins(values.corsOrigins);
          const interval = values.scrubIntervalSeconds ?? scrubIntervalSeconds;
          if (!Number.isInteger(interval) || (interval !== 0 && (interval < 60 || interval > 86400))) throw new ApiError(400, 'Интервал проверки: 0 (выключено) или 60–86400 секунд.');
          await storage.updateSettings({ cacheBytes: values.cacheBytes, concurrency: values.concurrency });
          scrubIntervalSeconds = interval; auth.setPreference('scrubIntervalSeconds', interval);
          auth.setPreference('publicOrigin', nextOrigin); auth.setPreference('corsOrigins', nextCors); refreshPreferences();
          auth.audit('settings.updated', JSON.stringify({ publicOrigin: nextOrigin, corsOrigins: nextCors, interval })); return json(res, 200, { ok: true });
        }
      }
      if (path === '/api/audit' && method === 'GET') { if (session.role !== 'admin') throw new ApiError(403, 'Журнал доступен администратору.'); return json(res, 200, { events: auth.events() }); }
      throw new ApiError(404, 'Метод API не найден.');
    }
    async function publicShare(req, res, rawPath) {
      // This route never reads admin cookies or S3 credentials. The unguessable
      // URL grants access only to one immutable object generation until expiry.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      const match = /^\/share\/([A-Za-z0-9_-]{43})$/.exec(rawPath);
      const unavailable = () => new ApiError(404, 'Ссылка недействительна или срок её действия истёк.');
      if (!match) throw unavailable();
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        throw new ApiError(405, 'Ссылка доступна только для просмотра и скачивания.');
      }
      const share = shares.get(match[1]);
      if (!share) throw unavailable();
      let result;
      try {
        const options = { expectedGeneration: share.blob_id };
        result = req.method === 'HEAD'
          ? { metadata: await storage.headObject(share.bucket, share.object_key, options) }
          : await storage.getObject(share.bucket, share.object_key, options);
        // A remote replica read may finish after a revocation, replacement or
        // expiry. Recheck before sending headers; ongoing downloads may finish.
        if (storage.objectGeneration(share.bucket, share.object_key) !== share.blob_id || !shares.get(match[1]))
          throw unavailable();
      } catch (error) {
        result?.stream?.destroy();
        if (error.status === 404) throw unavailable();
        throw error;
      }
      const { metadata, stream } = result;
      const storedType = metadata.contentType.split(';', 1)[0].trim().toLowerCase();
      const inline = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(storedType);
      const filename = share.object_key.split('/').pop().replace(/[\r\n]/g, '_');
      res.writeHead(200, { 'Content-Type': inline ? storedType : 'application/octet-stream', 'Content-Length': metadata.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}` });
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(stream, res);
    }
    const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15 * 60_000, headersTimeout: 15_000, keepAliveTimeout: 5000 }, async (req, res) => {
      const requestStarted = performance.now(); res.once('finish', () => monitor.record(res.statusCode, performance.now() - requestStarted));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const originalResponse = res;
      const dispatch = async () => {
      try {
        if (!req.url?.startsWith('/')) throw new ApiError(400, 'Invalid request target');
        // URL.pathname normalizes dot segments, but dots are literal S3 object-key bytes.
        const rawPath = req.url.split('?', 1)[0];
        if (rawPath === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok', ha: !!ha });
        if (rawPath === '/ha/ready' && req.method === 'GET' && !req.headers.authorization && !new URL(req.url, 'http://localhost').searchParams.has('X-Amz-Algorithm')) return json(res, ha && !ha.isLeader ? 503 : 200, { ready: !ha || ha.isLeader });
        // Preserve authenticated S3 access to buckets named "share" created by
        // older versions. New bucket creation reserves this name in Storage.
        if (rawPath.startsWith('/share/') && !req.headers.authorization && !new URL(req.url, 'http://localhost').searchParams.has('X-Amz-Algorithm'))
          return await publicShare(req, res, rawPath);
        if (rawPath.startsWith('/api/')) return await admin(req, res, new URL(req.url, 'http://localhost'));
        if (staticFiles.has(rawPath) && ['GET', 'HEAD'].includes(req.method)) {
          const [file, type] = staticFiles.get(rawPath), content = await readFile(join(webRoot, file));
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-store' });
          return res.end(req.method === 'HEAD' ? undefined : content);
        }
        if (rawPath === '/' && req.method === 'GET' && (req.headers.accept || '').includes('text/html') && !req.headers.authorization && !new URL(req.url, 'http://localhost').searchParams.has('X-Amz-Algorithm')) {
          res.writeHead(302, { Location: '/console/' }); return res.end();
        }
        // Apply download isolation to S3 payloads too; S3 requests never use browser admin cookies.
        res.setHeader('Content-Disposition', 'attachment');
        if (applyS3Cors(req, res, auth.preference('corsOrigins', []))) return;
        await handleS3(req, res, { storage, lookupKey: key => auth.lookupKey(key), region: process.env.S3_REGION || 'us-east-1', maxObjectBytes, publicOrigin });
      } catch (err) {
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        const status = err.status || err.statusCode || 500;
        if (status >= 500) console.error(JSON.stringify({ event: 'request.failed', code: err.code || 'InternalError', message: err.message }));
        json(res, status, { error: status >= 500 ? 'Операция не выполнена. Проверьте состояние узлов и журнал сервера.' : err.message, code: err.code });
      }
      };
      try {
        const rawPath = req.url?.split('?', 1)[0];
        if (ha && rawPath === '/api/ha/role' && req.method === 'PUT') {
          const role = await guarded(false, async () => {
            refreshPreferences();
            if (req.headers.origin && req.headers.origin !== (publicOrigin || `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'Запрос с другого сайта запрещён.');
            const session = auth.requireSession(req, true); if (session.role !== 'admin') throw new ApiError(403, 'Нужен администратор.');
            return (await bodyJSON(req)).role;
          });
          await ha.setRole(role); return json(res, 200, ha.status());
        }
        const bypass = req.method === 'GET' && (rawPath === '/healthz' || rawPath === '/ha/ready' && !req.headers.authorization && !new URL(req.url, 'http://localhost').searchParams.has('X-Amz-Algorithm')) || ['GET', 'HEAD'].includes(req.method) && staticFiles.has(rawPath) || rawPath === '/' && req.method === 'GET' && (req.headers.accept || '').includes('text/html') && !req.headers.authorization && !new URL(req.url, 'http://localhost').searchParams.has('X-Amz-Algorithm');
        if (!ha || bypass) await dispatch();
        else if (mutations.has(req.method)) {
          const held = new CommitResponse(originalResponse); res = held;
          await guarded(true, dispatch); held.flush();
        } else await guarded(false, dispatch);
      } catch (error) {
        if (!originalResponse.headersSent) json(originalResponse, error.status || 503, { error: error.status && error.status < 500 ? error.message : 'Координатор недоступен или нет кворума. Повторите запрос через общий адрес сервиса.' });
        else originalResponse.destroy();
      }
    });
    server.maxConnections = 256;
    server.on('clientError', (_, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    async function close() {
      clearInterval(maintenanceTimer);
      await new Promise((done, reject) => {
        if (!server.listening) return done();
        server.close(err => err ? reject(err) : done()); server.closeIdleConnections();
      });
      if (background) await background;
      await ha?.close(); await storage.close(); auth.close(); shares.close(); await releaseLock();
    }
    return { server, storage, auth, shares, ha, monitor, close };
  } catch (err) {
    try { await ha?.close(); } catch {}
    try { await storage?.close(); } catch {}
    try { auth?.close(); } catch {}
    try { shares?.close(); } catch {}
    await releaseLock(); throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const app = await createApp();
  const port = int(process.env.PORT, 9000, 1, 65535, 'PORT'), host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => {
    console.log(`27g-StoregeS3 ${VERSION}: http://${host}:${port}/console/`);
    if (app.auth.defaultCredentials) console.log(`Initial setup token: ${app.auth.setupToken}`);
  });
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    const timeout = setTimeout(() => process.exit(1), 30_000); timeout.unref();
    await app.close(); clearTimeout(timeout); process.exit(0);
  });
}

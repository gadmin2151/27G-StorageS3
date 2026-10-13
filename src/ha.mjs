import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EtcdClient, HaUnavailable } from './ha-etcd.mjs';

export { HaUnavailable } from './ha-etcd.mjs';
const MAGIC = Buffer.from('27GHA1');
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_RAW_BYTES = 64 * 1024 ** 2;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}

// SQLite is a local projection. A single authenticated snapshot in an etcd
// transaction is authoritative for ALL catalog/auth/share/multipart metadata.
// Every HTTP response acknowledging a mutation MUST wait for run() to return.
export class HaCoordinator {
  constructor({ endpoints, nodeId, role = 'slave', clusterId = 'storeges3', encryptionKey,
    exportState, importState, validateState = () => {}, initializeState = () => {}, bootstrap,
    leaseTTL = 15, pollMs = 1000, snapshotBytes = 8 * 1024 ** 2, client, tls, timeoutMs, dataDir }) {
    if (dataDir) {
      this.rolePath = join(dataDir, 'ha-node.json');
      try { role = JSON.parse(readFileSync(this.rolePath, 'utf8')).role; }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid local ha-node.json'); }
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nodeId || '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(clusterId)) throw new Error('Invalid HA node or cluster ID');
    if (!['master', 'slave'].includes(role) || !Number.isInteger(leaseTTL) || leaseTTL < 3 || leaseTTL > 120) throw new Error('Invalid HA role or lease TTL');
    bootstrap ??= role === 'master';
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error('HA requires the same 32-byte master.key on both coordinators');
    this.joined = false;
    if (dataDir) {
      this.joinedPath = join(dataDir, 'ha-cluster.json');
      try {
        const joined = JSON.parse(readFileSync(this.joinedPath, 'utf8'));
        if (joined.clusterId !== clusterId || joined.keyDigest !== digest(encryptionKey)) throw new Error('HA cluster identity changed');
        this.joined = true;
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('Local HA cluster identity differs; use planned recovery/migration'); }
    }
    if (typeof exportState !== 'function' || typeof importState !== 'function') throw new Error('HA state adapters are required');
    if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes < 1024 || snapshotBytes > 16 * 1024 ** 2) throw new Error('Invalid HA snapshot limit');
    this.client = client || new EtcdClient({ endpoints, tls, timeoutMs });
    Object.assign(this, { nodeId, role, clusterId, encryptionKey, exportState, importState, validateState, initializeState, bootstrap, leaseTTL, pollMs, snapshotBytes });
    this.prefix = `/27g/${clusterId}`; this.leaderKey = `${this.prefix}/leader`; this.stateKey = `${this.prefix}/state`;
    this.owner = JSON.stringify({ nodeId, session: randomUUID() });
    this.state = 'starting'; this.lease = null; this.revision = '0'; this.committed = null;
    this.leaderId = null; this.lock = Promise.resolve(); this.pausedUntil = 0; this.closed = false;
    this.pollBusy = false; this.renewBusy = false; this.lastError = null;
  }
  get isLeader() { return !this.closed && this.state === 'master'; }
  status() { return { enabled: true, isLeader: this.isLeader, nodeId: this.nodeId, role: this.role, configuredRole: this.role, activeRole: this.state,
    leaderId: this.leaderId, revision: this.revision, ready: this.isLeader,
    snapshotLimitBytes: this.snapshotBytes, metadataLimitBytes: MAX_RAW_BYTES, error: this.lastError }; }
  async _locked(work) {
    const previous = this.lock; let release;
    this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  _encode(state) {
    const raw = Buffer.from(JSON.stringify({ version: 1, state }));
    if (raw.length > MAX_RAW_BYTES) throw new HaUnavailable('Каталог HA превышает лимит 64 MiB метаданных.');
    const compressed = gzipSync(raw), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(this.clusterId));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const value = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
    if (value.length > this.snapshotBytes) throw new HaUnavailable('Сжатый каталог HA превышает настроенный лимит.');
    return { value, hash: digest(raw), state: JSON.parse(raw).state };
  }
  _decode(value) {
    try {
      if (value.length > this.snapshotBytes || value.length < 34 || !value.subarray(0, 6).equals(MAGIC)) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, value.subarray(6, 18));
      decipher.setAAD(Buffer.from(this.clusterId)); decipher.setAuthTag(value.subarray(18, 34));
      const compressed = Buffer.concat([decipher.update(value.subarray(34)), decipher.final()]);
      const raw = gunzipSync(compressed, { maxOutputLength: MAX_RAW_BYTES });
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.state || typeof parsed.state !== 'object') throw new Error();
      return { state: parsed.state, hash: digest(raw) };
    } catch { throw new HaUnavailable('Не удалось проверить состояние HA. Проверьте общий master.key и версию сервера.'); }
  }
  async _read() {
    const [leader, snapshot] = await this.client.read([this.leaderKey, this.stateKey]);
    let owner = null;
    try { owner = leader ? JSON.parse(leader.value.toString()) : null; } catch { throw new HaUnavailable('Некорректная запись master в etcd.'); }
    this.leaderId = owner?.nodeId || null;
    return { leader, snapshot };
  }
  async _load(snapshot) {
    if (!snapshot) throw new HaUnavailable('Кластер ещё не инициализирован master.');
    const committed = this._decode(snapshot.value);
    await this.validateState(committed.state);
    await this.importState(structuredClone(committed.state));
    await this._markJoined();
    this.committed = committed; this.revision = snapshot.revision;
  }
  async _markJoined() {
    if (this.joined) return;
    if (this.joinedPath) await writeJSON(this.joinedPath, { version: 1, clusterId: this.clusterId, keyDigest: digest(this.encryptionKey) });
    this.joined = true;
  }
  async _restore() {
    // Restore local speculative mutations even when quorum is unavailable. The
    // node stays fenced until it can read the NEWEST authoritative state again.
    if (this.committed) await this.importState(structuredClone(this.committed.state));
  }
  async _demote(error) {
    this.state = 'unavailable'; this.lastError = error?.message || 'Нет кворума.';
    const lease = this.lease; this.lease = null;
    if (lease) this.client.revoke(lease).catch(() => {});
  }
  async _tick() {
    if (this.closed || this.pollBusy || this.initializationError) return;
    this.pollBusy = true;
    try {
      await this._locked(async () => {
        if (this.closed) return;
        const { leader, snapshot } = await this._read();
        if (leader?.value.toString() === this.owner && this.lease) {
          if (snapshot?.revision !== this.revision) await this._load(snapshot);
          this.state = 'master'; this.lastError = null; return;
        }
        this.state = 'slave'; this.lease = null;
        if (!snapshot && this.joined) throw new HaUnavailable('В etcd отсутствует ранее подтверждённый каталог. Восстановите etcd из резервной копии; автоматическая повторная инициализация запрещена.');
        if (snapshot && snapshot.revision !== this.revision) await this._load(snapshot);
        if (leader || Date.now() < this.pausedUntil || (!snapshot && !this.bootstrap)) return;
        if (this.role === 'slave') await sleep(Math.min(this.pollMs, 500));
        const lease = await this.client.grant(this.leaseTTL);
        const acquired = await this.client.transaction([{ key: this.leaderKey, target: 'VERSION', value: 0 }], [{ key: this.leaderKey, value: this.owner, lease }]);
        if (!acquired.succeeded) { await this.client.revoke(lease).catch(() => {}); return; }
        this.lease = lease;
        // Re-read after election: the preceding owner may have committed between
        // our initial observation and acquisition. Never promote stale SQLite.
        const current = await this._read();
        if (current.leader?.value.toString() !== this.owner) throw new HaUnavailable();
        if (current.snapshot) await this._load(current.snapshot);
        else {
          // Initial users/buckets belong to the authoritative cluster state,
          // never to a fresh slave's local projection. Commit remains fenced.
          try { await this.initializeState(); }
          catch (error) { this.initializationError = error; throw error; }
          const initial = await this.exportState(); await this.validateState(initial);
          const encoded = this._encode(initial);
          const result = await this.client.transaction(this._compares('0'), [{ key: this.stateKey, value: encoded.value }]);
          if (!result.succeeded) throw new HaUnavailable();
          await this._markJoined();
          this.committed = { state: encoded.state, hash: encoded.hash }; this.revision = result.revision;
        }
        this.state = 'master'; this.leaderId = this.nodeId; this.lastError = null;
      });
    } catch (error) { await this._demote(error); }
    finally { this.pollBusy = false; }
  }
  _compares(revision = this.revision) { return [
    { key: this.leaderKey, target: 'VALUE', value: this.owner },
    { key: this.stateKey, target: revision === '0' ? 'VERSION' : 'MOD', value: revision },
  ]; }
  async _renew() {
    if (!this.lease || this.closed || this.renewBusy) return;
    this.renewBusy = true; const lease = this.lease;
    try { await this.client.renew(lease); }
    catch (error) { if (this.lease === lease) await this._demote(error); }
    finally { this.renewBusy = false; }
  }
  async start() {
    await this._tick();
    if (this.initializationError) throw this.initializationError;
    this.timer = setInterval(() => this._tick(), this.pollMs); this.timer.unref();
    this.renewTimer = setInterval(() => this._renew(), Math.max(250, Math.floor(this.leaseTTL * 1000 / 3))); this.renewTimer.unref();
    return this;
  }
  async run({ write = false } = {}, work) {
    return this._locked(async () => {
      if (!this.isLeader) throw new HaUnavailable();
      let result, failure;
      try {
        const { leader, snapshot } = await this._read();
        if (leader?.value.toString() !== this.owner || snapshot?.revision !== this.revision) throw new HaUnavailable();
        // The storage/auth methods retain their own transaction boundaries.
        // A rejected login still has an audit record worth committing, and must
        // not force a failover merely because a user supplied a bad password.
        try { result = await work(); } catch (error) { failure = error; }
        if (write) {
          const next = await this.exportState(); await this.validateState(next);
          const encoded = this._encode(next);
          // Even an unchanged mutation (e.g. logout) needs a fresh quorum fence.
          const changed = encoded.hash !== this.committed.hash;
          const commit = await this.client.transaction(this._compares(), changed ? [{ key: this.stateKey, value: encoded.value }] : []);
          if (!commit.succeeded || !this.lease) throw new HaUnavailable();
          if (changed) { this.committed = { state: encoded.state, hash: encoded.hash }; this.revision = commit.revision; }
        }
      } catch (error) {
        if (write) {
          await this._demote(error);
          try { await this._restore(); } catch { this.lastError = 'Не удалось восстановить локальные метаданные; перезапустите узел.'; }
        } else if (error instanceof HaUnavailable) await this._demote(error);
        throw error;
      }
      if (failure) throw failure;
      return result;
    });
  }
  async stepDown({ pauseMs = this.leaseTTL * 2000 } = {}) {
    this.pausedUntil = Date.now() + pauseMs;
    const lease = this.lease; this.lease = null; this.state = 'slave';
    if (lease) await this.client.revoke(lease);
  }
  async setRole(role) {
    if (!['master', 'slave'].includes(role)) { const error = new Error('Роль должна быть master или slave.'); error.status = 400; throw error; }
    return this._locked(async () => {
      if (this.rolePath) {
        await writeJSON(this.rolePath, { version: 1, role });
      }
      const previous = this.role; this.role = role;
      if (previous === 'master' && role === 'slave' && this.isLeader) await this.stepDown();
      if (role === 'master') this.pausedUntil = 0;
      return this.status();
    });
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearInterval(this.renewTimer);
    await this._locked(async () => {
      const lease = this.lease; this.lease = null; this.state = 'stopped';
      if (lease) await this.client.revoke(lease).catch(() => {});
    });
  }
}

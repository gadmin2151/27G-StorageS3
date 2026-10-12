import { ApiError } from './auth.mjs';

const preference = 'bucketAccessPolicies';
const reserved = new Set(['api', 'console', 'healthz', 'share']);
export function normalizeReadPrefixes(values = []) {
  if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.includes('\0')))
    throw new ApiError(400, 'Укажите до 32 префиксов ключа длиной не более 1024 байт, без NUL.');
  return values.includes('') ? [] : [...new Set(values)];
}

// Application policy, deliberately narrower than AWS IAM bucket-policy JSON.
// Auth preferences are already part of the atomic HA metadata snapshot.
export class BucketPolicies {
  constructor({ auth, storage }) { this.auth = auth; this.storage = storage; }
  _map() {
    const stored = this.auth.preference(preference, {});
    return Object.assign(Object.create(null), stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {});
  }
  _bucket(bucket) {
    if (typeof bucket !== 'string' || !bucket) throw new ApiError(400, 'Укажите бакет.');
    // Read the catalog identity without enumerating every bucket/object on downloads.
    return this.storage._bucket(bucket);
  }
  async get(bucket) {
    const row = this._bucket(bucket), saved = this._map()[bucket];
    const policy = saved?.createdAt === row.created_at ? saved : null;
    return { bucket, mode: policy?.mode === 'public-read' ? 'public-read' : 'private',
      readPrefixes: policy ? normalizeReadPrefixes(policy.readPrefixes) : [], anonymousList: false };
  }
  async set(bucket, { mode, readPrefixes = [] } = {}) {
    const row = this._bucket(bucket);
    if (!['private', 'public-read'].includes(mode)) throw new ApiError(400, 'Выберите закрытый или открытый бакет.');
    if (mode === 'public-read' && reserved.has(bucket)) throw new ApiError(400, 'Системное имя бакета не поддерживает анонимный доступ.');
    const prefixes = normalizeReadPrefixes(readPrefixes), policies = this._map();
    policies[bucket] = { mode, readPrefixes: prefixes, createdAt: row.created_at };
    this.auth.setPreference(preference, policies);
    return { bucket, mode, readPrefixes: prefixes, anonymousList: false };
  }
  remove(bucket) {
    const policies = this._map();
    if (!Object.hasOwn(policies, bucket)) return;
    delete policies[bucket]; this.auth.setPreference(preference, policies);
  }
  async allowsAnonymousRead(bucket, key) {
    if (typeof key !== 'string' || !key || reserved.has(bucket)) return false;
    const saved = this._map()[bucket];
    if (saved?.mode !== 'public-read') return false;
    try {
      const row = this._bucket(bucket);
      if (saved.createdAt !== row.created_at) return false;
      const prefixes = normalizeReadPrefixes(saved.readPrefixes);
      return !prefixes.length || prefixes.some(prefix => key.startsWith(prefix));
    } catch { return false; }
  }
}

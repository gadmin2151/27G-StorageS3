import http from 'node:http';
import https from 'node:https';

const encoded = value => Buffer.from(value).toString('base64');
export class HaUnavailable extends Error {
  constructor(message = 'Кворум или активный master недоступен. Повторите запрос позже.') {
    super(message); this.name = 'HaUnavailable'; this.code = 'ServiceUnavailable'; this.status = 503;
  }
}

// The v3 JSON gateway is part of etcd itself. No npm/gRPC runtime is required.
export class EtcdClient {
  constructor({ endpoints, timeoutMs = 3000, tls = {}, maxResponseBytes = 24 * 1024 ** 2 }) {
    if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('HA requires etcd endpoints');
    this.endpoints = endpoints.map(value => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new Error('Invalid etcd endpoint: use an HTTP(S) origin');
      return url;
    });
    this.timeoutMs = timeoutMs; this.tls = tls; this.maxResponseBytes = maxResponseBytes; this.offset = 0;
  }
  async request(path, data, { firstLine = false } = {}) {
    const body = Buffer.from(JSON.stringify(data));
    for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
      const endpoint = this.endpoints[(this.offset + attempt) % this.endpoints.length];
      try {
        const result = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
          const req = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
            method: 'POST', path, ...this.tls,
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
          }, res => {
            const parts = []; let size = 0;
            res.on('data', part => {
              size += part.length;
              if (size > this.maxResponseBytes) { finish(new HaUnavailable('Ответ etcd превышает лимит.')); req.destroy(); return; }
              parts.push(part);
              if (firstLine && part.includes(10)) parse(true);
            });
            const parse = partial => {
              try {
                const text = Buffer.concat(parts).toString();
                const value = JSON.parse(partial ? text.split('\n', 1)[0] : text);
                if (res.statusCode !== 200 || value.error || value.result?.error) throw new Error();
                finish(null, value.result || value);
                if (partial) req.destroy();
              } catch { finish(new HaUnavailable()); if (partial) req.destroy(); }
            };
            res.on('end', () => parse(false));
            res.on('error', () => finish(new HaUnavailable()));
          });
          const timer = setTimeout(() => { finish(new HaUnavailable()); req.destroy(); }, this.timeoutMs);
          req.on('error', () => finish(new HaUnavailable()));
          req.end(body);
        });
        this.offset = (this.offset + attempt) % this.endpoints.length;
        return result;
      } catch { /* Every operation remains fenced/idempotent on another member. */ }
    }
    throw new HaUnavailable();
  }
  async read(keys) {
    const response = await this.request('/v3/kv/txn', { success: keys.map(key => ({ request_range: { key: encoded(key), serializable: false } })) });
    return response.responses.map(item => {
      const kv = item.response_range?.kvs?.[0];
      return kv ? { value: Buffer.from(kv.value || '', 'base64'), revision: kv.mod_revision, lease: kv.lease } : null;
    });
  }
  async transaction(compare, puts = []) {
    const result = await this.request('/v3/kv/txn', {
      compare: compare.map(item => ({ key: encoded(item.key), target: item.target, result: 'EQUAL',
        ...(item.target === 'VALUE' ? { value: encoded(item.value) } : item.target === 'VERSION' ? { version: String(item.value) } : { mod_revision: String(item.value) }) })),
      success: puts.map(item => ({ request_put: { key: encoded(item.key), value: encoded(item.value), ...(item.lease ? { lease: item.lease } : {}) } })),
    });
    return { succeeded: result.succeeded === true, revision: result.header?.revision };
  }
  async grant(ttl) { return (await this.request('/v3/lease/grant', { TTL: ttl })).ID; }
  async renew(id) {
    const result = await this.request('/v3/lease/keepalive', { ID: id }, { firstLine: true });
    if (Number(result.TTL) <= 0) throw new HaUnavailable('Lease master истёк.');
  }
  async revoke(id) { await this.request('/v3/lease/revoke', { ID: id }); }
}

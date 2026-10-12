import { EventEmitter } from 'node:events';

// A write response is released only after the authoritative HA commit succeeds.
// Upload request bodies still stream to disk; only the small acknowledgement is buffered.
export class CommitResponse extends EventEmitter {
  constructor(response, limit = 1024 * 1024) { super(); this.response = response; this.limit = limit; this.statusCode = 200; this.headers = new Map(); this.chunks = []; this.bytes = 0; this.headersSent = false; this.destroyed = false; this.writableEnded = false; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name) { return this.headers.has(name.toLowerCase()) ? this.headers.get(name.toLowerCase()) : this.response.getHeader(name); }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }
  writeHead(status, headers) { this.statusCode = status; if (headers) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); this.headersSent = true; return this; }
  write(chunk, encoding) { if (chunk === undefined) return true; const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); this.bytes += data.length; if (this.bytes > this.limit) throw new Error('HA acknowledgement exceeds buffer limit'); this.chunks.push(data); return true; }
  end(chunk, encoding) { if (chunk !== undefined) this.write(chunk, encoding); this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; }
  flush() { if (this.destroyed) return this.response.destroy(); for (const [name, value] of this.headers) this.response.setHeader(name, value); this.response.statusCode = this.statusCode; this.response.end(Buffer.concat(this.chunks)); this.emit('finish'); }
}

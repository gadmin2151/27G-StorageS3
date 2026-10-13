#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

const MAX_SECRET_BYTES = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const EMPTY_HASH = hash('');
const HELP = `27G-StorageS3 client

Usage:
  node src/cli.mjs create-bucket NAME [--if-not-exists]
  node src/cli.mjs --help

--if-not-exists  Succeed if an authorized bucket already exists.
--if-no-exists   Alias for --if-not-exists.
-h, --help      Show this help without connecting to the server.

Environment:
  S3_ENDPOINT             HTTP(S) origin (default: http://127.0.0.1:9000)
  AWS_ACCESS_KEY_ID        S3 access key, or AWS_ACCESS_KEY_ID_FILE
  AWS_SECRET_ACCESS_KEY    S3 secret key, or AWS_SECRET_ACCESS_KEY_FILE
  AWS_REGION              Region (fallback: AWS_DEFAULT_REGION, us-east-1)

Requires a running server and an S3 key with createBucket permission.
Session tokens are unsupported. HTTPS certificates are verified.
Exit codes: 0 success; 1 server/network failure; 2 invalid configuration.
`;

class ClientError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
function usage(message) { throw new ClientError(message, 2); }

function parseArguments(args) {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { help: true };
  if (args[0] !== 'create-bucket') usage('Expected create-bucket NAME. Use --help for usage.');
  let name, ifNotExists = false, help = false;
  for (const arg of args.slice(1)) {
    if (['--if-not-exists', '--if-no-exists'].includes(arg)) {
      if (ifNotExists) usage('Specify the existence flag only once. Use --help for usage.');
      ifNotExists = true;
    } else if (['-h', '--help'].includes(arg)) help = true;
    else if (/^[-\u2010-\u2015\u2212]/u.test(arg)) usage('Unknown option. Use two ASCII hyphens: --if-not-exists. See --help.');
    else if (name !== undefined) usage('Specify exactly one bucket name. Use --help for usage.');
    else name = arg;
  }
  if (help) return { help: true };
  // The server remains authoritative for reserved names; keep this client free of catalog imports.
  if (typeof name !== 'string' || name.length < 3 || name.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)
      || name.includes('..') || name.includes('.-') || name.includes('-.') || /^\d+\.\d+\.\d+\.\d+$/.test(name))
    usage('Bucket names must contain 3–63 DNS-compatible lowercase characters.');
  return { name, ifNotExists };
}

async function secretFromEnvironment(env, name) {
  const value = env[name], file = env[`${name}_FILE`];
  if (value && file) usage(`Set either ${name} or ${name}_FILE, not both.`);
  if (!file) {
    if (!value) usage(`Set ${name} or ${name}_FILE.`);
    return value;
  }
  let handle;
  try {
    // O_NONBLOCK prevents a mistakenly mounted FIFO from hanging before fstat.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SECRET_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_SECRET_BYTES) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, '');
  } catch { usage(`Cannot read ${name}_FILE: expected a readable regular UTF-8 file of at most ${MAX_SECRET_BYTES} bytes.`); }
  finally { await handle?.close(); }
}

async function configuration(env) {
  if (env.AWS_SESSION_TOKEN || env.AWS_SECURITY_TOKEN) usage('AWS session tokens are not supported. Use a permanent S3 access key.');
  let endpoint;
  try {
    const raw = env.S3_ENDPOINT || 'http://127.0.0.1:9000';
    endpoint = new URL(raw);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/'
        || endpoint.search || endpoint.hash || !/^https?:\/\/[^/?#]+\/?$/i.test(raw) || /[\s\\]/u.test(raw)) throw new Error();
  } catch { usage('S3_ENDPOINT must be an HTTP(S) origin without credentials, path, query or fragment.'); }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(region)) usage('AWS_REGION must contain lowercase letters, digits or hyphens.');
  const accessKey = await secretFromEnvironment(env, 'AWS_ACCESS_KEY_ID');
  const secretKey = await secretFromEnvironment(env, 'AWS_SECRET_ACCESS_KEY');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(accessKey)) usage('AWS_ACCESS_KEY_ID has an invalid format.');
  if (!/^[\x21-\x7e]{32,512}$/.test(secretKey)) usage('AWS_SECRET_ACCESS_KEY must contain 32–512 printable ASCII characters without spaces.');
  return { endpoint, region, accessKey, secretKey };
}

function signedHeaders({ endpoint, region, accessKey, secretKey }, name) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const scope = `${timestamp.slice(0, 8)}/${region}/s3/aws4_request`;
  const headers = { host: endpoint.host, 'x-amz-content-sha256': EMPTY_HASH, 'x-amz-date': timestamp };
  const names = Object.keys(headers).sort();
  const canonical = ['PUT', `/${name}`, '', names.map(key => `${key}:${headers[key]}\n`).join(''), names.join(';'), EMPTY_HASH].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, timestamp.slice(0, 8)), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  headers['content-length'] = '0';
  return headers;
}

function sendCreate(config, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false, req, response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    // This absolute deadline also covers DNS, TLS, headers and a slowly trickled body.
    const timer = setTimeout(() => finish(new ClientError('S3 request timed out. Check server availability.')), timeoutMs);
    try {
      const request = config.endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
      req = request(new URL(`/${name}`, config.endpoint), {
        method: 'PUT', headers: signedHeaders(config, name), agent: false,
        rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
      }, res => {
        response = res;
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) return finish(new ClientError('S3 response exceeds the 64 KiB limit.'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          try { finish(null, { status: res.statusCode, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
          catch { finish(new ClientError('S3 response is not valid UTF-8.')); }
        });
        res.on('error', () => finish(new ClientError('S3 response was interrupted.')));
        res.on('aborted', () => finish(new ClientError('S3 response was interrupted.')));
      });
      req.on('error', () => finish(new ClientError('S3 connection failed. Check the endpoint, network and TLS certificate.')));
      req.end();
    } catch { finish(new ClientError('S3 connection failed. Check the endpoint, network and TLS certificate.')); }
  });
}

function errorCode(body) {
  // Parse only the simple S3 error envelope. Reject malformed XML, nested fields,
  // declarations/entities and duplicate Code tags rather than suppressing an error.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(body)) return null;
  const envelope = /^\s*(?:<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>\s*)?<Error(?:\s+xmlns=(?:"[^"<>]*"|'[^'<>]*'))?>([\s\S]*)<\/Error>\s*$/.exec(body);
  if (!envelope) return null;
  const fields = /^\s*(?:<([A-Za-z][A-Za-z0-9]*)>([^<>]*)<\/\1>\s*)*$/;
  if (!fields.test(envelope[1])) return null;
  const codes = [...envelope[1].matchAll(/<Code>([^<>]*)<\/Code>/g)];
  return codes.length === 1 ? codes[0][1] : null;
}

/** Pure HTTP client; importing this module never opens the application's data volume. */
export async function runCli(args = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  try {
    const command = parseArguments(args);
    if (command.help) { stdout.write(HELP); return 0; }
    const config = await configuration(env);
    const { status, body } = await sendCreate(config, command.name, timeoutMs);
    if (status === 200 && !body.trim()) { stdout.write(`Created bucket "${command.name}".\n`); return 0; }
    const code = errorCode(body);
    if (status === 409 && code === 'BucketAlreadyOwnedByYou' && command.ifNotExists) {
      stdout.write(`Already exists: bucket "${command.name}" (unchanged).\n`); return 0;
    }
    const known = new Set(['AccessDenied', 'SignatureDoesNotMatch', 'BucketAlreadyOwnedByYou', 'BucketAlreadyExists', 'InvalidBucketName', 'AuthorizationHeaderMalformed', 'RequestTimeTooSkewed']);
    throw new ClientError(`S3 create-bucket failed (HTTP ${status}${known.has(code) ? `, ${code}` : ''}).${status >= 300 && status < 400 ? ' Redirects are not followed; configure the final S3_ENDPOINT.' : ''}`);
  } catch (error) {
    // Never print raw server messages, endpoint values, credentials or Node network errors.
    stderr.write(`Error: ${error instanceof ClientError ? error.message : 'Unable to run the S3 client.'}\n`);
    return error instanceof ClientError ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli();

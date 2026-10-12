import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const CLOCK_SKEW_MS = 15 * 60 * 1000;
const PRESIGN_PARAMS = new Set(['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Content-Sha256']);
const LIST_PARAMS = ['list-type', 'prefix', 'delimiter', 'max-keys', 'continuation-token', 'start-after', 'marker', 'encoding-type', 'fetch-owner'];
const SUPPORTED_AMZ_HEADERS = new Set(['x-amz-date', 'x-amz-content-sha256', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-sha256', 'x-amz-checksum-sha1', 'x-amz-checksum-crc32', 'x-amz-checksum-crc32c', 'x-amz-checksum-md5', 'x-amz-checksum-mode', 'x-amz-user-agent']);
const HOISTED_HEADERS = new Set([...SUPPORTED_AMZ_HEADERS].filter(name => name !== 'x-amz-date' && name !== 'x-amz-user-agent'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const xml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (name, value) => `<${name}>${xml(value)}</${name}>`;

class S3Error extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
const fail = (code, status, message) => { throw new S3Error(code, status, message); };
const unsupported = message => fail('NotImplemented', 501, message);

// Never use WHATWG URL for the path: it removes literal/encoded dot segments.
function parseTarget(target) {
  if (!target?.startsWith('/') || target.includes('#')) fail('InvalidURI', 400, 'Use an absolute path with percent-encoded object keys.');
  const split = target.indexOf('?');
  const path = split < 0 ? target : target.slice(0, split);
  const queryString = split < 0 ? '' : target.slice(split + 1);
  const query = new Map();
  try {
    decodeURIComponent(path); // Reject invalid UTF-8 and malformed percent escapes.
    for (const pair of queryString.split('&').filter(Boolean)) {
      const eq = pair.indexOf('=');
      const name = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      const value = decodeURIComponent((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '));
      if (query.has(name)) fail('InvalidRequest', 400, 'Duplicate query parameters are not supported.');
      query.set(name, value);
    }
  } catch (error) {
    if (error instanceof S3Error) throw error;
    fail('InvalidURI', 400, 'The request contains invalid URI encoding.');
  }
  return { path, query };
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function suppliedAuthentication(req, target) {
  // Partial, invalid or expired signatures must never fall back to public access.
  return ['authorization', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token'].some(name => Object.hasOwn(req.headers, name)) ||
    [...target.query.keys()].some(name => /^(?:x-amz-|awsaccesskeyid$|signature$|expires$)/i.test(name));
}

function canonicalQuery(query, presigned) {
  return [...query].filter(([key]) => !presigned || key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
    .map(([key, value]) => `${key}=${value}`).join('&');
}

function parseDate(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value ?? '')) fail('AuthorizationHeaderMalformed', 400, 'The request timestamp must use YYYYMMDDTHHMMSSZ.');
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:]/g, '').replace('.000', '') !== value) fail('AuthorizationHeaderMalformed', 400, 'The request timestamp is invalid.');
  return date.getTime();
}

/** Verify SigV4 without reading the payload. The handler validates the body before any commit. */
export async function authenticateS3(req, { lookupKey, region = 'us-east-1', now = Date.now() }) {
  const target = parseTarget(req.url);
  const presigned = target.query.has('X-Amz-Algorithm');
  const authorization = header(req, 'authorization');
  if (presigned && authorization) fail('InvalidRequest', 400, 'Use only one authentication mechanism.');
  let credential, signedHeaders, signature, timestamp, payloadHash;
  if (presigned) {
    if (target.query.get('X-Amz-Algorithm') !== ALGORITHM) unsupported('Only AWS Signature Version 4 using HMAC-SHA256 is supported.');
    credential = target.query.get('X-Amz-Credential');
    signedHeaders = target.query.get('X-Amz-SignedHeaders');
    signature = target.query.get('X-Amz-Signature');
    timestamp = target.query.get('X-Amz-Date');
    const expires = target.query.get('X-Amz-Expires');
    if (!/^\d+$/.test(expires ?? '') || Number(expires) < 1 || Number(expires) > 604800) fail('AuthorizationQueryParametersError', 400, 'X-Amz-Expires must be between 1 and 604800 seconds.');
    const issuedAt = parseDate(timestamp);
    if (issuedAt > now + CLOCK_SKEW_MS) fail('RequestTimeTooSkewed', 403, 'The request timestamp is too far in the future.');
    if (now > issuedAt + Number(expires) * 1000) fail('AccessDenied', 403, 'The presigned request has expired.');
    payloadHash = target.query.get('X-Amz-Content-Sha256') ?? target.query.get('x-amz-content-sha256') ?? header(req, 'x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD';
  } else {
    if (!authorization) fail('AccessDenied', 403, 'AWS Signature Version 4 authentication is required.');
    if (!authorization.startsWith(`${ALGORITHM} `)) unsupported('Only AWS Signature Version 4 using HMAC-SHA256 is supported.');
    const fields = new Map();
    for (const field of authorization.slice(ALGORITHM.length + 1).split(',')) {
      const match = /^\s*(Credential|SignedHeaders|Signature)=([^\s,]+)\s*$/.exec(field);
      if (!match || fields.has(match[1])) fail('AuthorizationHeaderMalformed', 400, 'The Authorization header is malformed.');
      fields.set(match[1], match[2]);
    }
    credential = fields.get('Credential'); signedHeaders = fields.get('SignedHeaders'); signature = fields.get('Signature');
    timestamp = header(req, 'x-amz-date');
    if (Math.abs(parseDate(timestamp) - now) > CLOCK_SKEW_MS) fail('RequestTimeTooSkewed', 403, 'The request timestamp differs from the server by more than 15 minutes.');
    payloadHash = header(req, 'x-amz-content-sha256');
  }
  if (payloadHash?.startsWith('STREAMING-') || header(req, 'x-amz-trailer') || /(?:^|,)\s*aws-chunked\s*(?:,|$)/i.test(header(req, 'content-encoding') ?? '')) unsupported('AWS chunk signatures and checksum trailers are not supported. Use a single PUT with a known payload checksum.');
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && !/^[a-f0-9]{64}$/.test(payloadHash ?? '')) fail('InvalidRequest', 400, 'x-amz-content-sha256 must be a lowercase SHA256 digest or UNSIGNED-PAYLOAD.');
  if (!/^[a-f0-9]{64}$/.test(signature ?? '')) fail('AuthorizationHeaderMalformed', 400, 'The signature must be a SHA256 hexadecimal digest.');
  const scope = credential?.split('/');
  if (!scope || scope.length !== 5 || !scope[0] || scope[1] !== timestamp.slice(0, 8) || scope[2] !== region || scope[3] !== 's3' || scope[4] !== 'aws4_request') fail('AuthorizationHeaderMalformed', 400, `The credential scope must use the request date, region ${region}, and service s3.`);
  const names = signedHeaders?.split(';');
  if (!names?.length || names.some(name => !/^[a-z0-9-]+$/.test(name)) || new Set(names).size !== names.length || [...names].sort().join(';') !== signedHeaders || !names.includes('host')) fail('AuthorizationHeaderMalformed', 400, 'SignedHeaders must be sorted, unique, lowercase, and include host.');
  for (const name of Object.keys(req.headers)) {
    if ((name.startsWith('x-amz-') && name !== 'x-amz-content-sha256' && name !== 'x-amz-user-agent') || name === 'content-md5') {
      if (!names.includes(name)) fail('AccessDenied', 403, `The ${name} header must be signed.`);
    }
  }
  const canonicalHeaders = names.map(name => {
    const value = header(req, name);
    if (typeof value !== 'string') fail('AuthorizationHeaderMalformed', 400, 'A signed header is missing.');
    return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
  }).join('');
  // S3 clients already URI-encode their request target; preserve slash/dot segments verbatim.
  const canonical = [req.method, target.path, canonicalQuery(target.query, presigned), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = [ALGORITHM, timestamp, scope.slice(1).join('/'), sha256(canonical)].join('\n');
  const account = await lookupKey(scope[0]);
  // Derive and compare even for an unknown ID to avoid a trivial signature-timing oracle.
  const secret = account?.secretKey ?? 'invalid-access-key-placeholder';
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, scope[1]), scope[2]), 's3'), 'aws4_request');
  const valid = timingSafeEqual(hmac(signingKey, stringToSign), Buffer.from(signature, 'hex'));
  if (!valid || !account) fail('SignatureDoesNotMatch', 403, 'The request signature does not match.');
  if (!['readwrite', 'readonly'].includes(account.role)) fail('AccessDenied', 403, 'This access key has no S3 permissions.');
  return { ...target, account, accessKey: scope[0], payloadHash, presigned };
}

function requireSupportedRequest(req, auth, bucket, key) {
  const allowed = new Set(['x-id', ...(auth.presigned ? [...PRESIGN_PARAMS, ...HOISTED_HEADERS] : [])]);
  if (bucket && !key && req.method === 'GET') for (const name of [...LIST_PARAMS,'location','versioning','versions','key-marker','version-id-marker','uploads','upload-id-marker','max-uploads']) allowed.add(name);
  if(bucket&&key)for(const name of ['uploadId','partNumber','uploads','part-number-marker','max-parts','versionId'])allowed.add(name);
  for (const name of auth.query.keys()) if (!allowed.has(name)) unsupported(`The ${name} query operation is not implemented.`);
  for (const name of Object.keys(req.headers)) if (name.startsWith('x-amz-') && !SUPPORTED_AMZ_HEADERS.has(name)) unsupported(`The ${name} feature is not implemented.`);
  if (header(req, 'x-amz-checksum-mode') && (!['GET', 'HEAD'].includes(req.method) || header(req, 'x-amz-checksum-mode') !== 'ENABLED')) unsupported('Only ENABLED checksum mode on GET and HEAD is supported.');
  if (header(req, 'if-modified-since') || header(req, 'if-unmodified-since') || header(req, 'if-range')) unsupported('Date and If-Range preconditions are not implemented.');
  if (['PUT', 'POST', 'DELETE'].includes(req.method) && (header(req, 'if-match') || header(req, 'if-none-match'))) unsupported('Conditional writes require atomic storage preconditions and are not yet implemented.');
  if (req.method === 'PUT' || req.method === 'POST') for (const name of ['cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires']) if (header(req, name)) unsupported(`Persisting the ${name} object attribute is not implemented.`);
  if (!['GET', 'HEAD', 'PUT', 'DELETE','POST'].includes(req.method)) unsupported(`The ${req.method} operation is not implemented.`);
  const q=auth.query;
  if(key){
    if(q.has('versionId')&&(!['GET','HEAD','DELETE'].includes(req.method)||q.has('uploads')||q.has('uploadId')||q.has('partNumber')))fail('InvalidRequest',400,'versionId is supported only for object GET/HEAD/DELETE.');
    if(q.has('uploads')&&(req.method!=='POST'||q.has('uploadId')||q.has('partNumber')||q.get('uploads')!==''))fail('InvalidRequest',400,'Use POST ?uploads to initiate a multipart upload.');
    if(q.has('uploadId')){
      if(!q.get('uploadId')||!['GET','PUT','POST','DELETE'].includes(req.method))fail('InvalidRequest',400,'Invalid multipart operation.');
      if(req.method==='PUT'&&!q.has('partNumber')||req.method!=='PUT'&&q.has('partNumber'))fail('InvalidRequest',400,'partNumber is required only for UploadPart.');
      if(req.method!=='GET'&&(q.has('part-number-marker')||q.has('max-parts')))fail('InvalidRequest',400,'Part pagination is supported only by ListParts.');
    }else if(q.has('partNumber')||q.has('part-number-marker')||q.has('max-parts'))fail('InvalidRequest',400,'An uploadId is required.');
    if(req.method==='POST'&&!q.has('uploads')&&!q.has('uploadId'))unsupported('Only multipart initiation/completion POST operations are supported.');
  }else if(q.has('versions')||q.has('uploads')){
    const permitted=q.has('versions')?['versions','prefix','delimiter','key-marker','version-id-marker','max-keys','encoding-type']:['uploads','prefix','delimiter','key-marker','upload-id-marker','max-uploads','encoding-type'];
    for(const name of q.keys())if(!permitted.includes(name)&&name!=='x-id'&&!(auth.presigned&&(PRESIGN_PARAMS.has(name)||HOISTED_HEADERS.has(name))))fail('InvalidRequest',400,'Conflicting list operations.');
  }
  if(!key&&!q.has('versions')&&!q.has('uploads')&&['key-marker','version-id-marker','upload-id-marker','max-uploads'].some(name=>q.has(name)))fail('InvalidRequest',400,'Pagination does not match the list operation.');
  if(q.has('versioning')&&([...q.keys()].some(name=>name!=='versioning'&&name!=='x-id'&&!(auth.presigned&&(PRESIGN_PARAMS.has(name)||HOISTED_HEADERS.has(name))))))fail('InvalidRequest',400,'Versioning cannot be combined with other operations.');
}

function requestPermission(req,bucket,key,query){
  if(!bucket)return 'list';if(!key){if(req.method==='PUT')return 'createBucket';if(req.method==='DELETE')return 'deleteBucket';return 'list';}
  if(query.has('uploadId'))return req.method==='GET'?'list':'write';
  return ['GET','HEAD'].includes(req.method)?'read':req.method==='DELETE'?'delete':'write';
}
function authorizeAccount(req,auth,bucket,key){
  const account=auth.account,permission=requestPermission(req,bucket,key,auth.query);
  if(account.expiresAt&&Date.parse(account.expiresAt)<=Date.now())fail('AccessDenied',403,'This access key has expired.');
  if(bucket&&account.buckets?.length&&!account.buckets.includes(bucket))fail('AccessDenied',403,'This access key cannot access the bucket.');
  if(Array.isArray(account.permissions)){if(!account.permissions.includes(permission))fail('AccessDenied',403,'This access key does not allow the requested operation.');}
  else if(!['GET','HEAD'].includes(req.method)&&account.role!=='readwrite')fail('AccessDenied',403,'This access key is read-only.');
  if(account.prefixes?.length&&bucket){
    if(['createBucket','deleteBucket'].includes(permission))fail('AccessDenied',403,'Prefix-scoped keys cannot create or delete buckets.');
    const candidate=key||auth.query.get('prefix')||'';
    if(!account.prefixes.some(prefix=>candidate.startsWith(prefix)))fail('AccessDenied',403,'Provide an allowed object key or list prefix.');
  }
}

function decodeBase64Digest(value, bytes, name) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) fail('InvalidDigest', 400, `${name} must be a valid base64 checksum.`);
  return decoded;
}

function crcTable(polynomial) {
  return Array.from({ length: 256 }, (_, i) => {
    let n = i;
    for (let j = 0; j < 8; j++) n = (n >>> 1) ^ ((n & 1) ? polynomial : 0);
    return n >>> 0;
  });
}
const CRC32 = crcTable(0xedb88320);
const CRC32C = crcTable(0x82f63b78);

function bodyChecks(req, payloadHash) {
  const checks = [];
  if (payloadHash !== 'UNSIGNED-PAYLOAD') checks.push({ hash: createHash('sha256'), expected: Buffer.from(payloadHash, 'hex'), code: 'XAmzContentSHA256Mismatch' });
  const contentMd5 = header(req, 'content-md5');
  if (contentMd5) checks.push({ hash: createHash('md5'), expected: decodeBase64Digest(contentMd5, 16, 'Content-MD5'), code: 'BadDigest' });
  for (const [name, bytes] of [['sha256', 32], ['sha1', 20], ['md5', 16], ['crc32', 4], ['crc32c', 4]]) {
    const value = header(req, `x-amz-checksum-${name}`);
    if (value) checks.push({ ...(name.startsWith('crc') ? { crc: 0xffffffff, table: name === 'crc32' ? CRC32 : CRC32C } : { hash: createHash(name) }), expected: decodeBase64Digest(value, bytes, `x-amz-checksum-${name}`), code: 'BadDigest' });
  }
  const algorithm = header(req, 'x-amz-sdk-checksum-algorithm');
  if (algorithm) {
    if (!['SHA256', 'SHA1', 'MD5', 'CRC32', 'CRC32C'].includes(algorithm)) unsupported(`The ${algorithm} checksum algorithm is not implemented.`);
    if (!header(req, `x-amz-checksum-${algorithm.toLowerCase()}`)) fail('InvalidRequest', 400, 'The requested checksum header is missing.');
  }
  return checks;
}

async function* checkedBody(req, checks, maxBytes) {
  let size = 0;
  const declared = header(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('InvalidRequest', 400, 'Content-Length is invalid.');
  if (declared && Number(declared) > maxBytes) fail('EntityTooLarge', 413, 'The upload exceeds the configured object size limit.');
  const source = req.iterator ? req.iterator({ destroyOnReturn: false }) : req;
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) fail('EntityTooLarge', 413, 'The upload exceeds the configured object size limit.');
    for (const check of checks) {
      if (check.hash) check.hash.update(chunk);
      else for (const byte of chunk) check.crc = (check.crc >>> 8) ^ check.table[(check.crc ^ byte) & 255];
    }
    yield chunk;
  }
  if (declared && size !== Number(declared)) fail('IncompleteBody', 400, 'The request body length does not match Content-Length.');
  for (const check of checks) {
    const actual = check.hash ? check.hash.digest() : Buffer.alloc(4);
    if (!check.hash) actual.writeUInt32BE((check.crc ^ 0xffffffff) >>> 0);
    if (!timingSafeEqual(actual, check.expected)) fail(check.code, 400, 'The request body checksum does not match.');
  }
}

async function smallBody(req, checks, maxBytes = 65536) {
  const chunks = [];
  for await (const chunk of checkedBody(req, checks, maxBytes)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function xmlResponse(res, status, body) {
  const value = `<?xml version="1.0" encoding="UTF-8"?>${body}`;
  res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8', 'content-length': Buffer.byteLength(value) });
  res.end(value);
}

function objectHeaders(res, metadata) {
  res.setHeader('etag', `"${metadata.etag}"`);
  res.setHeader('last-modified', new Date(metadata.modifiedAt).toUTCString());
  res.setHeader('content-type', metadata.contentType || 'application/octet-stream');
  res.setHeader('accept-ranges', 'bytes');
  if(metadata.versionId)res.setHeader('x-amz-version-id',metadata.versionId);
}

function readPreconditions(req, metadata) {
  const matches = value => value.split(',').map(x => x.trim()).some(x => x === '*' || x === `"${metadata.etag}"`);
  if (header(req, 'if-match') && !matches(header(req, 'if-match'))) fail('PreconditionFailed', 412, 'An object precondition failed.');
  return header(req, 'if-none-match') && matches(header(req, 'if-none-match').replace(/W\//g, ''));
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) fail('InvalidRange', 416, 'Only one byte range is supported.');
  if ([match[1], match[2]].some(x => x && !Number.isSafeInteger(Number(x)))) fail('InvalidRange', 416, 'The byte range is invalid.');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
  if (start >= size || end < start || !size) fail('InvalidRange', 416, 'The requested range is outside the object.');
  return { start, end };
}

async function* rangedStream(stream, range) {
  let offset = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const next = offset + chunk.length;
    if (!range) yield chunk;
    else if (next > range.start && offset <= range.end) yield chunk.subarray(Math.max(0, range.start - offset), Math.min(chunk.length, range.end + 1 - offset));
    offset = next;
    if (range && offset > range.end) break;
  }
}

async function listBucket(res, storage, bucket, query) {
  const v2 = query.get('list-type') === '2';
  if (query.has('list-type') && !v2) fail('InvalidArgument', 400, 'Only list-type=2 is supported.');
  if (query.has('fetch-owner') && !['true', 'false'].includes(query.get('fetch-owner'))) fail('InvalidArgument', 400, 'fetch-owner must be true or false.');
  if (v2 && query.has('marker') || !v2 && (query.has('continuation-token') || query.has('start-after'))) fail('InvalidArgument', 400, 'The pagination parameter does not match the list API version.');
  const encoding = query.get('encoding-type');
  if (encoding && encoding !== 'url') fail('InvalidArgument', 400, 'Only encoding-type=url is supported.');
  const maximum = query.get('max-keys') ?? '1000';
  if (!/^\d+$/.test(maximum) || !Number.isSafeInteger(Number(maximum))) fail('InvalidArgument', 400, 'max-keys must be a nonnegative integer.');
  const maxKeys = Math.min(1000, Number(maximum));
  const prefix = query.get('prefix') ?? '';
  const delimiter = query.get('delimiter');
  const continuationToken = query.get('continuation-token');
  const startAfter = v2 ? query.get('start-after') : query.get('marker');
  const page = await storage.listObjects(bucket, { prefix, delimiter, maxKeys, continuationToken, startAfter });
  const objects = page.objects ?? [];
  const commonPrefixes = page.commonPrefixes ?? [];
  const keyText = value => {
    if (encoding) return encode(value);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value)) fail('InvalidArgument', 400, 'Use encoding-type=url to list keys containing XML control characters.');
    return value;
  };
  const owner = `<Owner>${tag('ID', 'local')}${tag('DisplayName', 'local')}</Owner>`;
  let body = tag('Name', bucket) + tag('Prefix', keyText(prefix)) + tag('MaxKeys', maxKeys) + tag('IsTruncated', Boolean(page.isTruncated));
  if (delimiter !== undefined) body += tag('Delimiter', keyText(delimiter));
  if (encoding) body += tag('EncodingType', encoding);
  if (v2) {
    body += tag('KeyCount', objects.length + commonPrefixes.length);
    if (continuationToken !== undefined) body += tag('ContinuationToken', continuationToken);
    if (startAfter !== undefined) body += tag('StartAfter', keyText(startAfter));
    if (page.isTruncated) body += tag('NextContinuationToken', page.nextContinuationToken);
  } else {
    body += tag('Marker', keyText(startAfter ?? ''));
    if (page.isTruncated) body += tag('NextMarker', keyText([...objects.map(x => x.key), ...commonPrefixes].sort(compare).at(-1) ?? ''));
  }
  for (const object of objects) body += `<Contents>${tag('Key', keyText(object.key))}${tag('LastModified', object.modifiedAt)}${tag('ETag', `"${object.etag}"`)}${tag('Size', object.size)}${!v2 || query.get('fetch-owner') === 'true' ? owner : ''}${tag('StorageClass', 'STANDARD')}</Contents>`;
  for (const value of commonPrefixes) body += `<CommonPrefixes>${tag('Prefix', keyText(value))}</CommonPrefixes>`;
  xmlResponse(res, 200, `<ListBucketResult xmlns="${XMLNS}">${body}</ListBucketResult>`);
}

function numberParam(query,name,fallback,maximum){const raw=query.get(name);if(raw===undefined){if(fallback===undefined)fail('InvalidArgument',400,`${name} is required.`);return fallback;}if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>maximum)fail('InvalidArgument',400,`${name} is outside the supported range.`);return Number(raw);}
function parseComplete(body){
  const text=body.toString('utf8').trim(),root=/^(?:<\?xml[^?]*\?>\s*)?<CompleteMultipartUpload(?:\s+xmlns=["']http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/["'])?>([\s\S]*)<\/CompleteMultipartUpload>$/.exec(text);
  if(!root)fail('MalformedXML',400,'Invalid CompleteMultipartUpload document.');const parts=[];let remainder=root[1];
  remainder=remainder.replace(/<Part>([\s\S]*?)<\/Part>/g,(_,inner)=>{let number,etag;const rest=inner.replace(/<(PartNumber|ETag)>([^<>]*)<\/\1>/g,(_,name,value)=>{if(name==='PartNumber'){if(number!==undefined)fail('MalformedXML',400,'Duplicate part number.');number=value.trim();}else{if(etag!==undefined)fail('MalformedXML',400,'Duplicate ETag.');etag=value.trim().replace(/&quot;/g,'"');}return '';});if(rest.trim()||!/^\d+$/.test(number??'')||!/^"?[a-f0-9]{32}"?$/.test(etag??''))fail('MalformedXML',400,'Parts require PartNumber and an MD5 ETag.');parts.push({partNumber:Number(number),etag});return '';});
  if(remainder.trim()||!parts.length)fail('MalformedXML',400,'The document must contain only Part elements.');return parts;
}
function listKeyEncoder(query){const encoding=query.get('encoding-type');if(encoding&&encoding!=='url')fail('InvalidArgument',400,'Only encoding-type=url is supported.');return value=>{if(encoding)return encode(value);if(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value))fail('InvalidArgument',400,'Use encoding-type=url to list these keys.');return value;};}
async function listVersions(res,storage,bucket,query){
  const text=listKeyEncoder(query),prefix=query.get('prefix')||'',delimiter=query.get('delimiter')||'',keyMarker=query.get('key-marker')||'',versionIdMarker=query.get('version-id-marker'),maxKeys=numberParam(query,'max-keys',1000,1000),page=await storage.listObjectVersions(bucket,{prefix,delimiter,keyMarker,versionIdMarker,maxKeys});
  let body=tag('Name',bucket)+tag('Prefix',text(prefix))+tag('KeyMarker',text(keyMarker))+tag('VersionIdMarker',versionIdMarker||'')+tag('MaxKeys',maxKeys)+tag('IsTruncated',page.isTruncated);if(delimiter)body+=tag('Delimiter',text(delimiter));if(query.has('encoding-type'))body+=tag('EncodingType','url');if(page.isTruncated)body+=tag('NextKeyMarker',text(page.nextKeyMarker))+tag('NextVersionIdMarker',page.nextVersionIdMarker||'');
  for(const version of page.versions){const kind=version.isDeleteMarker?'DeleteMarker':'Version';body+=`<${kind}>${tag('Key',text(version.key))}${tag('VersionId',version.versionId)}${tag('IsLatest',version.isLatest)}${tag('LastModified',version.modifiedAt)}<Owner>${tag('ID',version.owner||'local')}${tag('DisplayName',version.owner||'local')}</Owner>${version.isDeleteMarker?'':tag('ETag',`"${version.etag}"`)+tag('Size',version.size)+tag('StorageClass','STANDARD')}</${kind}>`;}
  for(const prefix of page.commonPrefixes)body+=`<CommonPrefixes>${tag('Prefix',text(prefix))}</CommonPrefixes>`;xmlResponse(res,200,`<ListVersionsResult xmlns="${XMLNS}">${body}</ListVersionsResult>`);
}
async function listUploads(res,storage,bucket,query,options){
  const text=listKeyEncoder(query),prefix=query.get('prefix')||'',delimiter=query.get('delimiter')||'',keyMarker=query.get('key-marker')||'',uploadIdMarker=query.get('upload-id-marker'),maxUploads=numberParam(query,'max-uploads',1000,1000),page=await storage.listMultipartUploads(bucket,{...options,prefix,delimiter,keyMarker,uploadIdMarker,maxUploads});
  let body=tag('Bucket',bucket)+tag('KeyMarker',text(keyMarker))+tag('UploadIdMarker',uploadIdMarker||'')+tag('Prefix',text(prefix))+tag('MaxUploads',maxUploads)+tag('IsTruncated',page.isTruncated);if(delimiter)body+=tag('Delimiter',text(delimiter));if(query.has('encoding-type'))body+=tag('EncodingType','url');if(page.isTruncated)body+=tag('NextKeyMarker',text(page.nextKeyMarker))+tag('NextUploadIdMarker',page.nextUploadIdMarker||'');
  for(const upload of page.uploads){const identity=tag('ID',upload.owner||'local')+tag('DisplayName',upload.owner||'local');body+=`<Upload>${tag('Key',text(upload.key))}${tag('UploadId',upload.uploadId)}<Initiator>${identity}</Initiator><Owner>${identity}</Owner>${tag('StorageClass','STANDARD')}${tag('Initiated',upload.initiated)}</Upload>`;}
  for(const prefix of page.commonPrefixes)body+=`<CommonPrefixes>${tag('Prefix',text(prefix))}</CommonPrefixes>`;xmlResponse(res,200,`<ListMultipartUploadsResult xmlns="${XMLNS}">${body}</ListMultipartUploadsResult>`);
}

/** Path-style S3 subset. Anonymous reads require explicit application bucket policy. */
export async function handleS3(req, res, { storage, lookupKey, region = 'us-east-1', maxObjectBytes = 5 * 1024 ** 3, lookupUserPolicy, publicOrigin = '', allowAnonymousRead, onBucketDeleted }) {
  const requestId = randomBytes(12).toString('hex');
  res.setHeader('x-amz-request-id', requestId);
  res.setHeader('x-amz-bucket-region', region);
  res.setHeader('x-content-type-options', 'nosniff');
  try {
    const target = parseTarget(req.url), split = target.path.indexOf('/', 1);
    const targetBucket = decodeURIComponent(split < 0 ? target.path.slice(1) : target.path.slice(1, split));
    const targetKey = split < 0 ? '' : decodeURIComponent(target.path.slice(split + 1));
    let auth;
    if (!suppliedAuthentication(req, target) && ['GET', 'HEAD'].includes(req.method) && targetBucket && targetKey && allowAnonymousRead) {
      if ([...target.query.keys()].some(name => name !== 'x-id') || !await allowAnonymousRead(targetBucket, targetKey))
        fail('AccessDenied', 403, 'Anonymous access to this object is not allowed.');
      auth = { ...target, anonymous: true, presigned: false, payloadHash: 'UNSIGNED-PAYLOAD',
        account: { role: 'readonly', permissions: ['read'], buckets: [targetBucket] } };
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    } else auth = await authenticateS3(req, { lookupKey, region });
    // SDK presigners move checksum headers into the signed query string.
    if (auth.presigned) for (const [name, value] of auth.query) {
      if (!HOISTED_HEADERS.has(name)) continue;
      if (header(req, name) !== undefined && header(req, name) !== value) fail('InvalidRequest', 400, 'A presigned query parameter conflicts with a request header.');
      req.headers[name] = value;
    }
    const slash = auth.path.indexOf('/', 1);
    const bucket = decodeURIComponent(slash < 0 ? auth.path.slice(1) : auth.path.slice(1, slash));
    const key = slash < 0 ? '' : decodeURIComponent(auth.path.slice(slash + 1));
    if (bucket && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket) || ['console', 'api', 'healthz'].includes(bucket))) fail('InvalidBucketName', 400, 'The bucket name is invalid or reserved.');
    if (key && (Buffer.byteLength(key) > 1024 || key.includes('\0'))) fail('InvalidArgument', 400, 'Object keys must be at most 1024 UTF-8 bytes and cannot contain NUL.');
    authorizeAccount(req,auth,bucket,key);
    if(lookupUserPolicy&&auth.account.owner){const policy=await lookupUserPolicy(auth.account.owner);if(!policy||policy.enabled===false)fail('AccessDenied',403,'The account is disabled.');}
    requireSupportedRequest(req, auth, bucket, key);
    const checks = bodyChecks(req, auth.payloadHash),options={owner:auth.account.owner||''};
    if (req.method === 'PUT' && bucket && key) {
      const putOptions={...options,contentType:header(req,'content-type')||'application/octet-stream',expectedSha256:auth.payloadHash==='UNSIGNED-PAYLOAD'?undefined:auth.payloadHash,expectedMd5:header(req,'content-md5')};
      const metadata = auth.query.has('uploadId')?await storage.uploadPart(bucket,key,auth.query.get('uploadId'),numberParam(auth.query,'partNumber',undefined,10000),checkedBody(req,checks,maxObjectBytes),putOptions):await storage.putObject(bucket,key,checkedBody(req,checks,maxObjectBytes),putOptions);
      res.setHeader('etag', `"${metadata.etag}"`);if(metadata.versionId)res.setHeader('x-amz-version-id',metadata.versionId);
      for (const name of ['sha256', 'sha1', 'md5', 'crc32', 'crc32c']) if (header(req, `x-amz-checksum-${name}`)) res.setHeader(`x-amz-checksum-${name}`, header(req, `x-amz-checksum-${name}`));
      res.writeHead(200, { 'content-length': '0' }); res.end(); return;
    }
    const body = await smallBody(req, checks,req.method==='POST'&&auth.query.has('uploadId')?2*1024**2:65536);
    if (body.length && !(req.method === 'PUT' && bucket && !key) && !(req.method==='POST'&&key&&auth.query.has('uploadId'))) fail('InvalidRequest', 400, 'This operation does not accept a request body.');
    if(key&&auth.query.has('uploads')){
      const upload=await storage.createMultipartUpload(bucket,key,{...options,contentType:header(req,'content-type')||'application/octet-stream'});
      xmlResponse(res,200,`<InitiateMultipartUploadResult xmlns="${XMLNS}">${tag('Bucket',bucket)}${tag('Key',key)}${tag('UploadId',upload.uploadId)}</InitiateMultipartUploadResult>`);return;
    }
    if(key&&auth.query.has('uploadId')){
      const uploadId=auth.query.get('uploadId');
      if(req.method==='DELETE'){await storage.abortMultipartUpload(bucket,key,uploadId,options);res.writeHead(204);res.end();return;}
      if(req.method==='POST'){
        const result=await storage.completeMultipartUpload(bucket,key,uploadId,parseComplete(body),options);res.setHeader('x-amz-version-id',result.versionId);
        xmlResponse(res,200,`<CompleteMultipartUploadResult xmlns="${XMLNS}">${tag('Location',`${publicOrigin}/${encode(bucket)}/${key.split('/').map(encode).join('/')}`)}${tag('Bucket',bucket)}${tag('Key',key)}${tag('ETag',`"${result.etag}"`)}</CompleteMultipartUploadResult>`);return;
      }
      const marker=numberParam(auth.query,'part-number-marker',0,10000),maxParts=numberParam(auth.query,'max-parts',1000,1000),page=await storage.listParts(bucket,key,uploadId,{...options,partNumberMarker:marker,maxParts});
      const owner=`<Owner>${tag('ID',page.owner||'local')}${tag('DisplayName',page.owner||'local')}</Owner>`;
      xmlResponse(res,200,`<ListPartsResult xmlns="${XMLNS}">${tag('Bucket',bucket)}${tag('Key',key)}${tag('UploadId',uploadId)}${owner}<Initiator>${tag('ID',page.owner||'local')}${tag('DisplayName',page.owner||'local')}</Initiator>${tag('StorageClass','STANDARD')}${tag('PartNumberMarker',marker)}${tag('NextPartNumberMarker',page.nextPartNumberMarker||0)}${tag('MaxParts',maxParts)}${tag('IsTruncated',page.isTruncated)}${page.parts.map(part=>`<Part>${tag('PartNumber',part.partNumber)}${tag('LastModified',part.modifiedAt)}${tag('ETag',`"${part.etag}"`)}${tag('Size',part.size)}</Part>`).join('')}</ListPartsResult>`);return;
    }
    if (!bucket) {
      if (req.method !== 'GET') unsupported('Only ListBuckets is implemented at the service root.');
      const buckets = (await storage.buckets()).filter(b => !auth.account.buckets?.length || auth.account.buckets.includes(b.name));
      xmlResponse(res, 200, `<ListAllMyBucketsResult xmlns="${XMLNS}"><Owner>${tag('ID', 'local')}${tag('DisplayName', 'local')}</Owner><Buckets>${buckets.map(b => `<Bucket>${tag('Name', b.name)}${tag('CreationDate', b.createdAt)}</Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`); return;
    }
    if (!key) {
      if (req.method === 'POST') unsupported('This bucket POST operation is not supported.');
      if(auth.query.has('versioning')){await storage.listObjects(bucket,{maxKeys:0});xmlResponse(res,200,`<VersioningConfiguration xmlns="${XMLNS}">${tag('Status','Enabled')}</VersioningConfiguration>`);return;}
      if(auth.query.has('versions')){await listVersions(res,storage,bucket,auth.query);return;}
      if(auth.query.has('uploads')){await listUploads(res,storage,bucket,auth.query,options);return;}
      if (req.method === 'PUT') {
        if (body.length) {
          const configuration = body.toString('utf8').trim();
          // Accept only the basic location document. No XML entity expansion/parser is used.
          const match = /^(?:<\?xml[^?]*\?>\s*)?<CreateBucketConfiguration(?:\s+xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?>\s*<LocationConstraint>([a-z0-9-]+)<\/LocationConstraint>\s*<\/CreateBucketConfiguration>$/.exec(configuration);
          if (!match) fail('MalformedXML', 400, 'Only CreateBucketConfiguration with a LocationConstraint is supported.');
          if (match[1] !== region) fail('InvalidLocationConstraint', 400, `The configured region is ${region}.`);
        }
        await storage.createBucket(bucket); res.writeHead(200, { location: `/${encode(bucket)}`, 'content-length': '0' }); res.end(); return;
      }
      if (req.method === 'DELETE') { await storage.deleteBucket(bucket); await onBucketDeleted?.(bucket); res.writeHead(204); res.end(); return; }
      if (req.method === 'HEAD') {
        await storage.listObjects(bucket, { maxKeys: 0 }); res.writeHead(200, { 'content-length': '0' }); res.end(); return;
      }
      if (auth.query.has('location')) {
        if ([...auth.query.keys()].some(name => LIST_PARAMS.includes(name))) fail('InvalidRequest', 400, 'Location and list parameters cannot be combined.');
        await storage.listObjects(bucket, { maxKeys: 0 });
        xmlResponse(res, 200, `<LocationConstraint xmlns="${XMLNS}">${xml(region === 'us-east-1' ? '' : region)}</LocationConstraint>`); return;
      }
      await listBucket(res, storage, bucket, auth.query); return;
    }
    if (req.method === 'DELETE') { const deleted=await storage.deleteObject(bucket, key,{versionId:auth.query.get('versionId')}); if(deleted?.versionId)res.setHeader('x-amz-version-id',deleted.versionId);if(deleted?.isDeleteMarker)res.setHeader('x-amz-delete-marker','true');res.writeHead(204); res.end(); return; }
    const result = req.method === 'GET' ? await storage.getObject(bucket, key,{versionId:auth.query.get('versionId')}) : { metadata: await storage.headObject(bucket, key,{versionId:auth.query.get('versionId')}) };
    const { metadata, stream } = result;
    let range;
    try {
      if (auth.anonymous && !await allowAnonymousRead(bucket, key)) fail('AccessDenied', 403, 'Anonymous access to this object is not allowed.');
      objectHeaders(res, metadata);
      if (header(req, 'x-amz-checksum-mode') === 'ENABLED' && metadata.sha256) res.setHeader('x-amz-checksum-sha256', Buffer.from(metadata.sha256, 'hex').toString('base64'));
      if (readPreconditions(req, metadata)) { stream?.destroy?.(); res.writeHead(304); res.end(); return; }
      range = parseRange(header(req, 'range'), metadata.size);
    } catch (error) { stream?.destroy?.(); throw error; }
    res.setHeader('content-length', range ? range.end - range.start + 1 : metadata.size);
    if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${metadata.size}`);
    res.statusCode = range ? 206 : 200;
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(Readable.from(rangedStream(stream, range)), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    // Never expose filesystem paths, credentials, or unexpected internal exception messages.
    const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && typeof error.code === 'string';
    const status = known ? error.status : 500;
    const code = known ? error.code : 'InternalError';
    const message = known ? error.message : 'An internal storage error occurred.';
    for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) res.removeHeader(name);
    if(error.deleteMarker){res.setHeader('x-amz-delete-marker','true');res.setHeader('x-amz-version-id',error.versionId);}
    const errorBody = `<Error>${tag('Code', code)}${tag('Message', message)}${tag('RequestId', requestId)}</Error>`;
    if (req.method === 'HEAD') { res.writeHead(status, { 'content-length': '0' }); res.end(); }
    else xmlResponse(res, status, errorBody);
    // Close rejected body uploads without consuming unbounded attacker-controlled data.
    if (!req.complete) { res.shouldKeepAlive = false; res.once('finish', () => req.destroy()); }
  }
}

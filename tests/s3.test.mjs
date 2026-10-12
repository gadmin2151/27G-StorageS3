import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.mjs';
import { authenticateS3, handleS3 } from '../src/s3.mjs';

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const HASH = value => createHash('sha256').update(value).digest('hex');
const HMAC = (key, text) => createHmac('sha256', key).update(text).digest();
const EMPTY = HASH('');
const URI = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const NOW = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const lookupKey = async key => key === KEY ? { secretKey: SECRET, role: 'readwrite' } : null;

// Independent request signer for HTTP integration tests; AWS's fixed vector below
// protects against a signer and verifier accidentally sharing the same mistake.
function sign({ method = 'GET', path = '/', body = '', host = 'localhost', headers = {}, timestamp = NOW(), presigned = false, expires = 600, accessKey = KEY, secret = SECRET }) {
  headers = { host, ...headers };
  const [pathname, rawQuery = ''] = path.split('?');
  const params = [...new URLSearchParams(rawQuery)];
  const scope = `${timestamp.slice(0, 8)}/us-east-1/s3/aws4_request`;
  if (!presigned) {
    headers['x-amz-date'] = timestamp;
    headers['x-amz-content-sha256'] ??= HASH(body);
  }
  const names = Object.keys(headers).map(x => x.toLowerCase()).sort();
  if (presigned) params.push(['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${accessKey}/${scope}`], ['X-Amz-Date', timestamp], ['X-Amz-Expires', String(expires)], ['X-Amz-SignedHeaders', names.join(';')]);
  const query = params.map(([k, v]) => [URI(k), URI(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, pathname, query, names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''), names.join(';'), headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD'].join('\n');
  const signingKey = HMAC(HMAC(HMAC(HMAC(`AWS4${secret}`, timestamp.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
  const signature = HMAC(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${HASH(canonical)}`).toString('hex');
  if (presigned) path = `${pathname}?${query}&X-Amz-Signature=${signature}`;
  else headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { method, path, headers };
}

function storageError(code, status) { return Object.assign(new Error(code), { code, status }); }

class MemoryStorage {
  constructor() { this.data = new Map(); }
  async buckets() { return [...this.data.keys()].map(name => ({ name, createdAt: '2026-01-01T00:00:00.000Z' })); }
  async createBucket(name) {
    if (this.data.has(name)) throw storageError('BucketAlreadyOwnedByYou', 409);
    this.data.set(name, new Map());
  }
  bucket(name) {
    if (!this.data.has(name)) throw storageError('NoSuchBucket', 404);
    return this.data.get(name);
  }
  async deleteBucket(name) {
    if (this.bucket(name).size) throw storageError('BucketNotEmpty', 409);
    this.data.delete(name);
  }
  async putObject(bucket, key, source, options) {
    const target = this.bucket(bucket), chunks = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    if (options.expectedSha256 && HASH(data) !== options.expectedSha256) throw storageError('XAmzContentSHA256Mismatch', 400);
    if (options.expectedMd5 && createHash('md5').update(data).digest('base64') !== options.expectedMd5) throw storageError('BadDigest', 400);
    const metadata = { key, etag: createHash('md5').update(data).digest('hex'), sha256: HASH(data), contentType: options.contentType, size: data.length, modifiedAt: '2026-01-01T00:00:00.000Z' };
    target.set(key, { data, metadata });
    return metadata;
  }
  async headObject(bucket, key) {
    const value = this.bucket(bucket).get(key);
    if (!value) throw storageError('NoSuchKey', 404);
    return value.metadata;
  }
  async getObject(bucket, key) { return { metadata: await this.headObject(bucket, key), stream: Readable.from([this.bucket(bucket).get(key).data]) }; }
  async deleteObject(bucket, key) { this.bucket(bucket).delete(key); }
  async listObjects(bucket, { prefix = '', delimiter, maxKeys = 1000, continuationToken, startAfter } = {}) {
    const entries = new Map();
    for (const [key, object] of this.bucket(bucket)) {
      if (!key.startsWith(prefix)) continue;
      const index = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      if (index >= 0) entries.set(key.slice(0, index + delimiter.length), { prefix: true });
      else entries.set(key, object.metadata);
    }
    const after = continuationToken ? Buffer.from(continuationToken, 'base64url').toString('utf8') : startAfter;
    const ordered = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).filter(([key]) => !after || Buffer.compare(Buffer.from(key), Buffer.from(after)) > 0);
    const page = ordered.slice(0, maxKeys);
    const isTruncated = maxKeys > 0 && ordered.length > page.length;
    return { objects: page.filter(([, x]) => !x.prefix).map(([, x]) => x), commonPrefixes: page.filter(([, x]) => x.prefix).map(([k]) => k), isTruncated, nextContinuationToken: isTruncated ? Buffer.from(page.at(-1)[0]).toString('base64url') : undefined };
  }
}

async function fixture(t, { role = 'readwrite', buckets, maxObjectBytes, persistent=false, permissions, prefixes, owner }  = {}) {
  let storage;
  if(persistent){const dir=await mkdtemp(join(tmpdir(),'27g-s3-'));storage=await new Storage({dataDir:dir}).init();t.after(async()=>{storage.close();await rm(dir,{recursive:true,force:true});});}else storage=new MemoryStorage();
  const server = createServer((req, res) => handleS3(req, res, { storage, maxObjectBytes, lookupKey: async key => key === KEY ? { secretKey: SECRET, role, buckets, permissions, prefixes, owner } : null }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  async function call(method, path, body = '', options = {}) {
    body = Buffer.from(body);
    const signed = sign({ method, path, body, host: `127.0.0.1:${port}`, ...options });
    if (options.mutate) options.mutate(signed);
    return await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, ...signed, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return { call, storage };
}

test('validates the official AWS S3 published SigV4 GET example', async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const req = {
    method: 'GET', url: '/test.txt', headers: {
      host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-date': '20130524T000000Z', 'x-amz-content-sha256': EMPTY,
      authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    },
  };
  assert.equal((await authenticateS3(req, { lookupKey, now: Date.parse('2013-05-24T00:00:00Z') })).accessKey, KEY);
  req.headers.range = 'bytes=1-9';
  await assert.rejects(authenticateS3(req, { lookupKey, now: Date.parse('2013-05-24T00:00:00Z') }), { code: 'SignatureDoesNotMatch' });
});

test('bucket and object lifecycle returns S3 XML, etags, and idempotent delete', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('PUT', '/example')).status, 200);
  assert.match((await call('GET', '/')).body, /<Name>example<\/Name>/);
  assert.equal((await call('HEAD', '/example')).status, 200);
  const put = await call('PUT', '/example/hello.txt', 'hello world', { headers: { 'content-type': 'text/plain' } });
  assert.equal(put.status, 200);
  const get = await call('GET', '/example/hello.txt');
  assert.equal(get.body, 'hello world');
  assert.equal(get.headers.etag, put.headers.etag);
  assert.equal(get.headers['content-type'], 'text/plain');
  const head = await call('HEAD', '/example/hello.txt');
  assert.equal(head.status, 200); assert.equal(head.headers['content-length'], '11'); assert.equal(head.body, '');
  assert.equal((await call('DELETE', '/example')).status, 409);
  assert.equal((await call('DELETE', '/example/hello.txt')).status, 204);
  assert.equal((await call('DELETE', '/example/hello.txt')).status, 204);
  assert.equal((await call('DELETE', '/example')).status, 204);
  assert.equal((await call('HEAD', '/example')).status, 404);
});

test('tampered payloads and bad checksums never commit or overwrite', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  await call('PUT', '/example/object', 'original');
  const tampered = await call('PUT', '/example/object', 'tampered', { headers: { 'x-amz-content-sha256': HASH('different') } });
  assert.equal(tampered.status, 400); assert.match(tampered.body, /XAmzContentSHA256Mismatch/);
  const badMd5 = await call('PUT', '/example/object', 'tampered', { headers: { 'content-md5': Buffer.alloc(16).toString('base64') } });
  assert.equal(badMd5.status, 400); assert.match(badMd5.body, /BadDigest/);
  assert.equal((await call('GET', '/example/object')).body, 'original');
  assert.equal((await call('PUT', '/example/object', 'good', { headers: { 'content-md5': createHash('md5').update('good').digest('base64') } })).status, 200);
});

test('SDK CRC32, CRC32C and SHA256 checksum headers are verified', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  for (const [algorithm, value] of [['CRC32', 'y/Q5Jg=='], ['CRC32C', '4waSgw=='], ['SHA256', createHash('sha256').update('123456789').digest('base64')]]) {
    const headers = { 'x-amz-sdk-checksum-algorithm': algorithm, [`x-amz-checksum-${algorithm.toLowerCase()}`]: value };
    const result = await call('PUT', '/example/object', '123456789', { headers });
    assert.equal(result.status, 200, result.body);
    assert.equal(result.headers[`x-amz-checksum-${algorithm.toLowerCase()}`], value);
    assert.equal((await call('PUT', '/example/object', 'different', { headers })).status, 400);
  }
});

test('unauthenticated, unknown key, forged signatures and stale dates are rejected', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('GET', '/', '', { mutate: req => delete req.headers.authorization })).status, 403);
  assert.equal((await call('GET', '/', '', { accessKey: 'UNKNOWN' })).status, 403);
  assert.equal((await call('GET', '/', '', { secret: 'incorrect' })).status, 403);
  const stale = await call('GET', '/', '', { timestamp: '20130524T000000Z' });
  assert.equal(stale.status, 403); assert.match(stale.body, /RequestTimeTooSkewed/);
  assert.equal((await call('GET', '/', '', { timestamp: '20260230T000000Z' })).status, 400);
  assert.equal((await call('GET', '/', '', { mutate: req => req.headers['x-amz-checksum-mode'] = 'ENABLED' })).status, 403);
});

test('readonly and bucket-scoped credentials enforce permissions for reads and writes', async t => {
  const { call, storage } = await fixture(t, { role: 'readonly', buckets: ['allowed'] });
  await storage.createBucket('allowed'); await storage.createBucket('private');
  assert.equal((await call('HEAD', '/allowed')).status, 200);
  assert.equal((await call('HEAD', '/private')).status, 403);
  assert.equal((await call('PUT', '/allowed/object', 'no')).status, 403);
  assert.equal((await call('DELETE', '/allowed')).status, 403);
  const list = await call('GET', '/');
  assert.match(list.body, /allowed/); assert.doesNotMatch(list.body, /private/);
});

test('an empty bucket scope means all buckets, matching the console access-key contract', async t => {
  const { call } = await fixture(t, { buckets: [] });
  assert.equal((await call('PUT', '/example')).status, 200);
  assert.equal((await call('PUT', '/example/object', 'data')).status, 200);
  assert.equal((await call('GET', '/example/object')).body, 'data');
  assert.match((await call('GET', '/')).body, /<Name>example<\/Name>/);
});

test('presigned GET and PUT accept unsigned payload and enforce expiry and signature', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  assert.equal((await call('PUT', '/example/object', 'presigned data', { presigned: true })).status, 200);
  assert.equal((await call('GET', '/example/object', '', { presigned: true })).body, 'presigned data');
  assert.equal((await call('GET', '/example/object', '', { presigned: true, expires: 604801 })).status, 400);
  assert.equal((await call('GET', '/example/object', '', { presigned: true, timestamp: '20130524T000000Z' })).status, 403);
  assert.equal((await call('GET', '/example/object', '', { presigned: true, mutate: req => req.path += '&extra=tampered' })).status, 403);
  assert.equal((await call('GET', '/example/object', '', { presigned: true, mutate: req => req.path += '&X-Amz-Expires=600' })).status, 400);
  const checksumPath = '/example/checksum?x-amz-sdk-checksum-algorithm=CRC32&x-amz-checksum-crc32=y%2FQ5Jg%3D%3D';
  assert.equal((await call('PUT', checksumPath, '123456789', { presigned: true })).status, 200);
  assert.equal((await call('PUT', checksumPath, 'wrong', { presigned: true })).status, 400);
});

test('literal dot segments, encoded slashes, percent signs, Unicode and XML are preserved', async t => {
  const { call, storage } = await fixture(t);
  await call('PUT', '/example');
  const rawPaths = ['/example/a/../b//test', '/example/encoded%2Fslash', '/example/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%26%3C', '/example/literal%252Fslash'];
  for (const path of rawPaths) {
    assert.equal((await call('PUT', path, path)).status, 200);
    assert.equal((await call('GET', path)).body, path);
  }
  assert.ok(storage.bucket('example').has('a/../b//test'));
  assert.ok(storage.bucket('example').has('encoded/slash'));
  assert.ok(storage.bucket('example').has('literal%2Fslash'));
  const listing = await call('GET', '/example?list-type=2');
  assert.match(listing.body, /привет &amp;&lt;/);
  const encoded = await call('GET', '/example?list-type=2&encoding-type=url');
  assert.match(encoded.body, /%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%26%3C/);
});

test('list V2 paginates, counts common prefixes and supports start-after; V1 returns markers', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  for (const key of ['a', 'b', 'c', 'folder/x', 'folder/y']) await call('PUT', `/example/${key}`, key);
  const first = await call('GET', '/example?list-type=2&max-keys=2');
  assert.match(first.body, /<KeyCount>2<\/KeyCount>/); assert.match(first.body, /<IsTruncated>true<\/IsTruncated>/);
  const token = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(first.body)[1];
  const second = await call('GET', `/example?list-type=2&max-keys=2&continuation-token=${URI(token)}`);
  assert.match(second.body, /<Key>c<\/Key>/); assert.doesNotMatch(second.body, /<Key>a<\/Key>/);
  const delimited = await call('GET', '/example?list-type=2&delimiter=%2F&start-after=b');
  assert.match(delimited.body, /<KeyCount>2<\/KeyCount>/); assert.match(delimited.body, /<CommonPrefixes><Prefix>folder\/<\/Prefix>/);
  const v1 = await call('GET', '/example?max-keys=2&marker=a');
  assert.match(v1.body, /<Key>b<\/Key>/); assert.match(v1.body, /<NextMarker>c<\/NextMarker>/);
  const empty = await call('GET', '/example?list-type=2&max-keys=0');
  assert.match(empty.body, /<KeyCount>0<\/KeyCount>/);
  assert.equal((await call('GET', '/example?list-type=2&max-keys=-1')).status, 400);
});

test('single ranges, suffix ranges, matching etags and conditional read failures', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  const put = await call('PUT', '/example/object', '0123456789');
  const range = await call('GET', '/example/object', '', { headers: { range: 'bytes=2-4' } });
  assert.equal(range.status, 206); assert.equal(range.body, '234'); assert.equal(range.headers['content-range'], 'bytes 2-4/10');
  assert.equal((await call('GET', '/example/object', '', { headers: { range: 'bytes=-3' } })).body, '789');
  assert.equal((await call('GET', '/example/object', '', { headers: { range: 'bytes=10-' } })).status, 416);
  assert.equal((await call('GET', '/example/object', '', { headers: { range: 'bytes=0-1,3-4' } })).status, 416);
  assert.equal((await call('GET', '/example/object', '', { headers: { 'if-none-match': put.headers.etag } })).status, 304);
  assert.equal((await call('GET', '/example/object', '', { headers: { 'if-match': '"wrong"' } })).status, 412);
  assert.equal((await call('GET', '/example/object', '', { headers: { 'if-match': put.headers.etag } })).status, 200);
});

test('unsupported operations never silently act as normal object or bucket operations', async t => {
  const { call } = await fixture(t);
  await call('PUT', '/example');
  for (const [method, path, headers = {}] of [
    ['GET', '/example?acl'], ['PUT', '/example/object', { 'x-amz-copy-source': '/example/source' }],
    ['PUT', '/example/object', { 'x-amz-acl': 'public-read' }], ['PUT', '/example/object', { 'x-amz-server-side-encryption': 'AES256' }],
    ['PUT', '/example/object', { 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' }],
    ['PUT', '/example/object', { 'if-none-match': '*' }], ['PUT', '/example/object', { 'x-amz-meta-custom': 'value' }],
  ]) {
    const result = await call(method, path, '', { headers });
    assert.equal(result.status, 501, `${method} ${path}: ${result.body}`);
    assert.match(result.body, /NotImplemented/);
  }
  assert.equal((await call('HEAD', '/example/object')).status, 404);
});

test('configured upload limits fail before committing', async t => {
  const { call } = await fixture(t, { maxObjectBytes: 4 });
  await call('PUT', '/example');
  assert.equal((await call('PUT', '/example/object', '12345')).status, 413);
  assert.equal((await call('HEAD', '/example/object')).status, 404);
});

test('location configuration is validated and dangerous XML is rejected', async t => {
  const { call } = await fixture(t);
  const config = '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>us-east-1</LocationConstraint></CreateBucketConfiguration>';
  assert.equal((await call('PUT', '/example', config)).status, 200);
  assert.equal((await call('GET', '/example?location')).status, 200);
  assert.equal((await call('PUT', '/another', config.replace('us-east-1', 'eu-west-1'))).status, 400);
  assert.equal((await call('PUT', '/another', '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>')).status, 400);
});

test('real S3 multipart cycle exposes retained versions and signed historical reads',async t=>{
  const {call,storage}=await fixture(t,{persistent:true,owner:'alice'});await call('PUT','/example');
  const initiated=await call('POST','/example/photo?uploads');assert.equal(initiated.status,200,initiated.body);const id=/<UploadId>([^<]+)<\/UploadId>/.exec(initiated.body)[1];
  assert.match((await call('GET','/example?uploads')).body,new RegExp(id));
  const p1=await call('PUT',`/example/photo?partNumber=1&uploadId=${id}`,Buffer.alloc(5*1024**2,97));assert.equal(p1.status,200,p1.body);
  const p2=await call('PUT',`/example/photo?partNumber=2&uploadId=${id}`,'end');assert.equal(p2.status,200,p2.body);
  const parts=await call('GET',`/example/photo?uploadId=${id}&max-parts=1`);assert.match(parts.body,/<IsTruncated>true<\/IsTruncated>/);assert.match(parts.body,/<NextPartNumberMarker>1<\/NextPartNumberMarker>/);
  const xml=`<CompleteMultipartUpload><Part><ETag>${p1.headers.etag}</ETag><PartNumber>1</PartNumber></Part><Part><PartNumber>2</PartNumber><ETag>${p2.headers.etag}</ETag></Part></CompleteMultipartUpload>`;
  const completed=await call('POST',`/example/photo?uploadId=${id}`,xml);assert.equal(completed.status,200,completed.body);assert.match(completed.body,/-2&quot;<\/ETag>/);const initialVersion=completed.headers['x-amz-version-id'];assert.ok(initialVersion);
  const overwritten=await call('PUT','/example/photo','new');assert.equal(overwritten.status,200);assert.notEqual(overwritten.headers['x-amz-version-id'],initialVersion);
  const historical=await call('GET',`/example/photo?versionId=${initialVersion}`,'',{headers:{range:'bytes=5242880-'}});assert.equal(historical.status,206);assert.equal(historical.body,'end');
  const deleted=await call('DELETE','/example/photo');assert.equal(deleted.headers['x-amz-delete-marker'],'true');const missing=await call('GET','/example/photo');assert.equal(missing.status,404);assert.equal(missing.headers['x-amz-delete-marker'],'true');
  assert.equal((await call('GET',`/example/photo?versionId=${deleted.headers['x-amz-version-id']}`)).status,405);
  const versions=await call('GET','/example?versions&max-keys=1');assert.equal(versions.status,200,versions.body);assert.match(versions.body,/<DeleteMarker>/);assert.match(versions.body,/<IsTruncated>true<\/IsTruncated>/);
  await call('DELETE',`/example/photo?versionId=${deleted.headers['x-amz-version-id']}`);assert.equal((await call('GET','/example/photo')).body,'new');
  assert.equal(storage.ownerUsage('alice').objects,2);
});

test('multipart errors, strict XML and prefix/action scopes cannot fall through to object operations',async t=>{
  const {call,storage}=await fixture(t,{persistent:true,owner:'alice',permissions:['read','list','write'],prefixes:['allowed/']});await storage.createBucket('example');
  assert.equal((await call('PUT','/example/forbidden','x')).status,403);assert.equal((await call('GET','/example?versions')).status,403);assert.equal((await call('GET','/example?uploads&prefix=allowed%2F')).status,200);
  const init=await call('POST','/example/allowed/file?uploads'),id=/<UploadId>([^<]+)<\/UploadId>/.exec(init.body)[1];
  assert.equal((await call('PUT',`/example/allowed/file?uploadId=${id}&partNumber=0`,'x')).status,400);
  assert.equal((await call('PUT',`/example/allowed/file?uploadId=${id}&partNumber=1`,'x',{headers:{'x-amz-content-sha256':'0'.repeat(64)}})).status,400);
  const part=await call('PUT',`/example/allowed/file?uploadId=${id}&partNumber=1`,'x');assert.equal(part.status,200);
  for(const xml of ['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><CompleteMultipartUpload>&e;</CompleteMultipartUpload>','<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>no</ETag></Part></CompleteMultipartUpload>'])assert.equal((await call('POST',`/example/allowed/file?uploadId=${id}`,xml)).status,400);
  assert.equal((await call('GET','/example/allowed/file')).status,404);assert.equal((await call('DELETE','/example/allowed/file')).status,403);assert.equal((await call('DELETE',`/example/allowed/file?uploadId=${id}`)).status,204);assert.equal((await call('GET',`/example/allowed/file?uploadId=${id}`)).status,404);
  assert.equal(storage.bucketUsage('example').bytes,0);
});

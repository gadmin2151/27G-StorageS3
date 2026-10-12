import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, stat, statfs, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { StorageError, validBlobId, writeStreamFile, syncDirectory } from './storage.mjs';

export async function createNodeServer({ dataDir = process.env.DATA_DIR || './data-node', token, maxObjectBytes = Number(process.env.MAX_OBJECT_BYTES || 5 * 1024 ** 3), concurrency = 8, filesystemNamespace = process.env.NODE_HOST_ID, assertAvailable, pinDirectories = false } = {}) {
  if (token === undefined) token = process.env.NODE_TOKEN_FILE ? (await readFile(process.env.NODE_TOKEN_FILE, 'utf8')).trim() : process.env.NODE_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new Error('NODE_TOKEN must contain 32–512 characters.');
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) throw new Error('MAX_OBJECT_BYTES must be a positive integer.');
  let blobDir = join(dataDir, 'blobs'), tempDir = join(dataDir, 'tmp'); await mkdir(blobDir, { recursive: true, mode: 0o700 }); await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const handles=[];
  if(pinDirectories){try{for(const path of [blobDir,tempDir])handles.push(await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW));[blobDir,tempDir]=handles.map(fd=>`/proc/self/fd/${fd.fd}`);}catch(error){await Promise.all(handles.map(fd=>fd.close()));throw error;}}
  for (const name of await readdir(tempDir)) { const path = join(tempDir, name); const info = await stat(path); if (Date.now() - info.mtimeMs > 3600000) await unlink(path); }
  let active = 0;
  const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(body); };
  const handleRequest = async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.setHeader('connection', 'close'); return json(res, 401, { code: 'Unauthorized' }); }
      if(assertAvailable)await assertAvailable();
      if (req.method === 'GET' && req.url === '/health') { const fs = await statfs(blobDir); return json(res, 200, { status: 'ok', capacityBytes: Number(fs.blocks) * Number(fs.bsize), freeBytes: Number(fs.bavail) * Number(fs.bsize), ...(filesystemNamespace ? { filesystemId: `${filesystemNamespace}:${(await stat(blobDir)).dev}` } : {}), active }); }
      const match = /^\/blobs\/([^/?]+)$/.exec(req.url || ''); if (!match || !validBlobId(match[1])) return json(res, 404, { code: 'NotFound' });
      const path = join(blobDir, match[1]);
      if (req.method === 'PUT') {
        if (active >= concurrency) { res.setHeader('connection', 'close'); return json(res, 503, { code: 'SlowDown' }); }
        const declared = req.headers['content-length']; if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxObjectBytes)) { res.setHeader('connection', 'close'); return json(res, 413, { code: 'EntityTooLarge' }); }
        active++; const temporary = join(tempDir, randomUUID());
        try {
          const info = await writeStreamFile(temporary, req, maxObjectBytes);
          if (req.headers['x-content-sha256'] && req.headers['x-content-sha256'] !== info.sha256) return json(res, 400, { code: 'BadDigest' });
          await rename(temporary, path); await syncDirectory(blobDir); if(assertAvailable)await assertAvailable(); return json(res, 201, info);
        } finally { active--; await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const info = await fd.stat(); if(!info.isFile()){await fd.close();return json(res,404,{code:'NoSuchBlob'});} res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size });
        if (req.method === 'HEAD') { await fd.close(); res.end(); } else await pipeline(fd.createReadStream(), res); return;
      }
      if (req.method === 'DELETE') { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); await syncDirectory(blobDir); res.writeHead(204); res.end(); return; }
      json(res, 405, { code: 'MethodNotAllowed' });
    } catch (error) { if (res.headersSent) { res.destroy(); return; } if(error.status===503)json(res,503,{code:'StorageUnavailable'}); else if (error.code === 'ENOENT') json(res, 404, { code: 'NoSuchBlob' }); else if (error instanceof StorageError) json(res, error.status, { code: error.code, message: error.message }); else json(res, 500, { code: 'InternalError' }); }
  };
  const server = createServer(handleRequest);
  // Embedded volume agents must await all I/O, including cleanup after a client
  // disconnect, before releasing or reusing directory descriptors.
  server.handleRequest = handleRequest;
  server.requestTimeout = 120000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 50;
  let closed=false;server.closeStorage=async()=>{if(closed)return;closed=true;await Promise.all(handles.map(fd=>fd.close()));};server.once('close',()=>{server.closeStorage().catch(()=>{});});
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createNodeServer(); const port = Number(process.env.NODE_PORT || 9100), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`27g-StoregeS3 node listening on ${host}:${port}`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

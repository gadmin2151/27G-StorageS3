import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname } from 'node:path';
import { ApiError } from './auth.mjs';

const IMAGE_LIMIT = 20 * 1024 ** 2;
const TEXT_LIMIT = 1024 ** 2;
const TEXT_PREFIX = 256 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const textExtensions = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.svg', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.toml', '.ini', '.conf', '.log', '.sh', '.py', '.sql']);
function rasterType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width && height && width * height <= 80_000_000 ? 'image/png' : null;
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    return width && height && width * height <= 80_000_000 ? 'image/gif' : null;
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}
async function prefix(stream, limit) {
  const parts = []; let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk).subarray(0, limit - size); parts.push(bytes); size += bytes.length;
      if (size >= limit) break;
    }
    return Buffer.concat(parts, size);
  } finally { stream.destroy(); }
}

// Invoked only after the normal session/role checks. User documents are never
// rendered as HTML, SVG, PDF or an iframe on the administrative origin.
export async function objectPreview(req, res, url, { storage, json }) {
  const bucket = url.searchParams.get('bucket'), key = url.searchParams.get('key');
  if (!bucket || !key) throw new ApiError(400, 'Укажите бакет и ключ объекта.');
  const metadata = await storage.headObject(bucket, key, { versionId: url.searchParams.get('versionId') || undefined });
  const name = key.split('/').pop() || key, type = metadata.contentType.split(';')[0].trim().toLowerCase();
  const info = { name, size: metadata.size, contentType: type, versionId: metadata.versionId, modifiedAt: metadata.modifiedAt };
  const raw = url.searchParams.get('raw') === '1';
  const unsupported = reason => {
    if (raw) throw new ApiError(415, reason);
    return json(res, 200, { ...info, kind: 'unsupported', reason });
  };
  const imageCandidate = imageTypes.has(type) || /\.(png|jpe?g|gif|webp|avif)$/i.test(name);
  const textCandidate = type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'image/svg+xml'].includes(type) || textExtensions.has(extname(name).toLowerCase());
  if (!imageCandidate && (!textCandidate || raw)) return unsupported('Для этого формата доступно скачивание без предпросмотра.');
  if (metadata.size > (imageCandidate ? IMAGE_LIMIT : TEXT_LIMIT)) return unsupported(imageCandidate ? 'Предпросмотр изображений доступен до 20 МиБ.' : 'Предпросмотр текста доступен для файлов до 1 МиБ.');
  const { stream } = await storage.getObject(bucket, key, { versionId: metadata.versionId });
  if (imageCandidate) {
    // Keep one iterator to inspect the header and then stream the same immutable
    // version. This bounds RAM even when many image previews are open.
    const iterator = stream[Symbol.asyncIterator](); let first;
    try {
      first = await iterator.next(); const bytes = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
      const detected = rasterType(bytes);
      if (!detected) { stream.destroy(); return unsupported('Содержимое не соответствует поддерживаемому формату изображения.'); }
      if (!raw) {
        stream.destroy();
        const query = new URLSearchParams({ bucket, key, versionId: metadata.versionId, raw: '1' });
        return json(res, 200, { ...info, contentType: detected, kind: 'image', url: `/api/preview?${query}` });
      }
      res.writeHead(200, { 'Content-Type': detected, 'Content-Length': metadata.size, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" });
      await pipeline(Readable.from((async function* () { yield bytes; while (true) { const next = await iterator.next(); if (next.done) break; yield next.value; } })()), res);
      return;
    } finally { stream.destroy(); }
  }
  const bytes = await prefix(stream, TEXT_PREFIX), truncated = metadata.size > bytes.length;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); }
  catch { return unsupported('Текст не в кодировке UTF-8. Скачайте файл для просмотра.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return unsupported('Файл содержит двоичные данные. Доступно скачивание.');
  return json(res, 200, { ...info, kind: 'text', text, truncated });
}

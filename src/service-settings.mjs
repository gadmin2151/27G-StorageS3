import { ApiError } from './auth.mjs';

export function normalizePublicOrigin(value, { optional = true } = {}) {
  if (typeof value !== 'string') throw new ApiError(400, 'Укажите адрес сервиса строкой.');
  value = value.trim();
  if (!value && optional) return '';
  if (!value.includes('://')) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, 'Некорректный домен или URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new ApiError(400, 'Адрес должен иметь вид https://s3.example.com без пути, пароля и параметров.');
  return url.origin;
}
export function normalizeCorsOrigins(values) {
  if (!Array.isArray(values) || values.length > 32) throw new ApiError(400, 'Укажите до 32 разрешённых адресов CORS.');
  return [...new Set(values.map(value => {
    if (value === '*' || value === 'null') throw new ApiError(400, 'Укажите конкретный адрес сайта вместо * или null.');
    return normalizePublicOrigin(value, { optional: false });
  }))];
}
export function applyS3Cors(req, res, origins) {
  const origin = req.headers.origin;
  const allowed = typeof origin === 'string' && origins.includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, x-amz-version-id, x-amz-delete-marker, x-amz-request-id, x-amz-checksum-sha256, Content-Length, Content-Range');
  }
  if (req.method !== 'OPTIONS') return false;
  const methods = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'];
  const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const safe = requested.length <= 40 && requested.every(name => /^(authorization|content-type|content-md5|range|if-match|if-none-match|amz-sdk-invocation-id|amz-sdk-request|x-amz-[a-z0-9-]+)$/.test(name));
  if (!allowed || !methods.includes(req.headers['access-control-request-method']) || !safe) throw new ApiError(403, 'Этот сайт, метод или заголовки не разрешены правилами CORS.');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  if (requested.length) res.setHeader('Access-Control-Allow-Headers', requested.join(', '));
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.writeHead(204); res.end(); return true;
}

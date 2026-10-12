import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
import { ApiError } from './auth.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const shell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const hex = /^[a-f0-9]{64}$/;
const lifetime = 15 * 60_000;
function origin(value, name = 'адрес') {
  let url; try { url = new URL(value); } catch { throw new ApiError(400, `Некорректный ${name}.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\x00-\x20\x7f]/.test(value)) throw new ApiError(400, `${name}: нужен HTTP(S) origin без пути и реквизитов.`);
  return url.origin;
}
export function enrollmentInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Нужны параметры подключения.');
  const label = String(input.label || 'Сервер хранения').trim();
  const port = Number(input.port ?? 9200), directory = input.directory ?? '/srv/27g-storeges3/disks', mode = input.mode ?? 'folders';
  if (!label || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) throw new ApiError(400, 'Название агента должно содержать 1–100 символов.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ApiError(400, 'Порт агента: 1024–65535.');
  if (typeof directory !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(directory) || directory.split('/').includes('..') || ['/', '/dev', '/proc', '/sys', '/etc', '/var', '/usr', '/bin', '/sbin', '/root', '/home'].includes(directory.replace(/\/+$/, ''))) throw new ApiError(400, 'Укажите отдельный абсолютный каталог для данных, без пробелов и специальных символов.');
  if (!['folders', 'mounts'].includes(mode)) throw new ApiError(400, 'Режим агента: folders или mounts.');
  return { label, port, directory, mode, agentUrl: input.agentUrl ? origin(input.agentUrl, 'адрес агента') : '' };
}
// A deterministic, flat ustar archive made exclusively from an allowlist. No filesystem metadata or secrets are included.
function archive(files) {
  const chunks = [];
  for (const [name, body] of files) {
    if (Buffer.byteLength(name) > 100) throw new Error('Bundle path too long');
    const header = Buffer.alloc(512); header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
}
async function deployedBundle(sourceRoot) {
  const names = ['package.json', 'Dockerfile.disk-agent', ...(await readdir(join(sourceRoot, 'src'))).filter(name => /^[a-zA-Z0-9_.-]+\.mjs$/.test(name)).sort().map(name => `src/${name}`)];
  const files = await Promise.all(names.map(async name => [name, await readFile(join(sourceRoot, name))]));
  const bundle = archive(files), script = await readFile(join(sourceRoot, 'scripts/install-agent.sh'));
  if (bundle.length > 900_000 || script.length > 64_000) throw new Error('Agent installation bundle exceeds response limits');
  return { bundle, script, sourceSha256: sha(bundle), scriptSha256: sha(script) };
}
export class AgentEnrollment {
  constructor({ auth, sourceRoot = root, now = () => Date.now(), probe } = {}) {
    this.auth = auth; this.sourceRoot = sourceRoot; this.now = now; this.pending = new Map();
    this.probe = probe || (async (url, token) => {
      const result = await fetch(url + '/disks', { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!result.ok) throw new Error('Agent unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of result.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Agent response too large'); chunks.push(chunk); }
      if (!Array.isArray(JSON.parse(Buffer.concat(chunks).toString()).disks)) throw new Error('Invalid agent response');
    });
  }
  async assets() { return this.assetPromise ||= deployedBundle(this.sourceRoot).catch(error => { this.assetPromise = null; throw error; }); }
  rows() { return this.auth.preference('agentEnrollments', []); }
  list() {
    return this.rows().map(({ tokenHash, sourceSha256, ...row }) => ({ ...row, status: row.status === 'pending' && row.expiresAt <= this.now() ? 'expired' : row.status }));
  }
  async create(input, { origin: serviceOrigin, owner } = {}) {
    const user = this.auth.userPolicy(owner); if (!user?.enabled || user.role !== 'admin') throw new ApiError(403, 'Нужен действующий администратор.');
    const config = enrollmentInput(input), endpoint = origin(serviceOrigin, 'адрес координатора');
    const assets = await this.assets(), now = this.now(), rows = this.rows().filter(row => row.createdAt > now - 24 * 3600_000).slice(-255);
    if (rows.filter(row => row.status === 'pending' && row.expiresAt > now).length >= 32) throw new ApiError(409, 'Слишком много ожидающих подключений. Отзовите лишние команды.');
    const token = randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = now + lifetime;
    rows.push({ ...config, id, owner, createdAt: now, expiresAt, status: 'pending', tokenHash: sha(token), sourceSha256: assets.sourceSha256 });
    this.auth.setPreference('agentEnrollments', rows); this.auth.audit('disk.enrollment_created', id);
    // printf is a shell builtin: bootstrap credentials never become curl arguments or URL parameters.
    // Download, verify, then execute. No command substitution executes unverified network content.
    const scriptURL = `${endpoint}/api/agent-install/script/${assets.scriptSha256}.sh`;
    const args = [endpoint, assets.sourceSha256, String(config.port), config.directory, config.mode, config.agentUrl];
    const command = `sudo -v && ( umask 077; f=$(mktemp) || exit 1; trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --proto '=http,https' --max-time 30 ${shell(scriptURL)} -o "$f" && printf '%s  %s\\n' ${shell(assets.scriptSha256)} "$f" | sha256sum -c - >/dev/null && printf '%s\\n' ${shell(token)} | sudo -n bash "$f" ${args.map(shell).join(' ')} )`;
    const warnings = ['Linux, Docker и curl должны быть установлены. Команда действует 15 минут и подключает один агент.', 'Координатор должен видеть порт агента: используйте частную сеть/VPN либо HTTPS-прокси.'];
    if (config.mode === 'mounts') warnings.push('Режим дисков/SMB/NFS даёт агенту root, SYS_ADMIN и доступ к /dev. Форматирование и монтирование при установке не выполняются.');
    if (endpoint.startsWith('http:')) warnings.push('Адрес координатора использует HTTP: выполняйте команду только в доверенной локальной сети/VPN. Для Интернета настройте HTTPS.');
    return { id, command, expiresAt, sourceSha256: assets.sourceSha256, warnings };
  }
  revoke(id) {
    const rows = this.rows(), row = rows.find(item => item.id === id);
    if (!row) throw new ApiError(404, 'Команда подключения не найдена.');
    if (row.status === 'connected') throw new ApiError(409, 'Агент уже подключён. Удалите его подключение в списке агентов.');
    row.status = 'revoked'; this.auth.setPreference('agentEnrollments', rows); this.auth.audit('disk.enrollment_revoked', id);
  }
  authorize(token) {
    if (typeof token !== 'string' || !hex.test(token)) throw new ApiError(401, 'Недействительная команда подключения.');
    const row = this.rows().find(item => item.tokenHash === sha(token));
    if (!row || row.status !== 'pending' || row.expiresAt <= this.now()) throw new ApiError(401, 'Команда использована, отозвана или истекла. Создайте новую в панели.');
    const user = this.auth.userPolicy(row.owner); if (!user?.enabled || user.role !== 'admin') throw new ApiError(401, 'Создавший команду администратор больше не имеет доступа.');
    return row;
  }
  async complete(token, input, peerAddress) {
    const row = this.authorize(token);
    if (this.pending.has(row.id)) throw new ApiError(409, 'Подключение уже проверяется.');
    this.pending.set(row.id, true);
    try {
      if (!input || !hex.test(input.agentToken || '') || input.sourceSha256 !== row.sourceSha256) throw new ApiError(400, 'Неверные параметры агента.');
      const peer = String(peerAddress || '').replace(/^::ffff:/, '');
      if (!row.agentUrl && !isIP(peer)) throw new ApiError(400, 'Не удалось определить адрес агента. Укажите адрес в панели.');
      const url = row.agentUrl || `http://${isIP(peer) === 6 ? `[${peer}]` : peer}:${row.port}`;
      try { await this.probe(url, input.agentToken); } catch { throw new ApiError(409, 'Координатор не видит агент. Проверьте VPN/firewall/порт или создайте команду с явным адресом агента. Запущенный контейнер сохранён.'); }
      // Refresh after network I/O: revoke, expiry and another enrollment may have changed persisted state.
      this.authorize(token);
      const agents = this.auth.preference('diskAgents', []), rows = this.rows(), current = rows.find(item => item.id === row.id);
      if (agents.length >= 64 || agents.some(agent => agent.url === url)) throw new ApiError(409, 'Этот адрес уже подключён или достигнут лимит агентов.');
      const id = `agent-${row.id}`;
      agents.push({ id, label: row.label, url, secret: this.auth.encrypt(input.agentToken) });
      current.status = 'connected'; current.agentId = id; current.agentUrl = url; current.connectedAt = this.now();
      this.auth.db.exec('BEGIN IMMEDIATE');
      try { this.auth.setPreference('diskAgents', agents); this.auth.setPreference('agentEnrollments', rows); this.auth.audit('disk.agent_enrolled', id); this.auth.db.exec('COMMIT'); }
      catch (error) { this.auth.db.exec('ROLLBACK'); throw error; }
      return { ok: true, agentId: id, agentUrl: url };
    } finally { this.pending.delete(row.id); }
  }
  async handlePublic(req, res, url, { json, bodyJSON, peerAddress } = {}) {
    if (!url.pathname.startsWith('/api/agent-install/')) return false;
    if (url.search || req.headers.origin || req.headers['sec-fetch-site']) throw new ApiError(403, 'Этот endpoint предназначен для установщика агента.');
    const assets = await this.assets();
    const send = (data, type) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment' }); res.end(data); return true; };
    if (req.method === 'GET' && url.pathname === `/api/agent-install/script/${assets.scriptSha256}.sh`) return send(assets.script, 'text/x-shellscript; charset=utf-8');
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (req.method === 'POST' && url.pathname === `/api/agent-install/bundle/${assets.sourceSha256}`) {
      const row = this.authorize(token); if (row.sourceSha256 !== assets.sourceSha256) throw new ApiError(409, 'Версия приложения изменилась. Создайте новую команду.');
      return send(assets.bundle, 'application/gzip');
    }
    if (req.method === 'POST' && url.pathname === '/api/agent-install/complete') { const result = await this.complete(token, await bodyJSON(req), peerAddress); json(res, 201, result); return true; }
    throw new ApiError(404, 'Установщик этой версии недоступен. Создайте новую команду в панели.');
  }
}

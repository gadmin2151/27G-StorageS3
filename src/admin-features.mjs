import { ApiError } from './auth.mjs';

const administrator = session => { if (session.role !== 'admin') throw new ApiError(403, 'Это действие доступно только администратору.'); };
const coordinates = url => {
  const bucket = url.searchParams.get('bucket'), key = url.searchParams.get('key');
  if (!bucket || !key) throw new ApiError(400, 'Укажите бакет и ключ объекта.');
  return { bucket, key };
};
export async function featureAPI(req, res, url, c) {
  const { auth, storage, session, json, bodyJSON, clientIP, monitor, getHa, status, publicOrigin } = c;
  const method = req.method, path = url.pathname, admin = session.role === 'admin';
  const owner = session.user;
  if (path === '/api/users') {
    administrator(session);
    if (method === 'GET') { const users = auth.listUsers(); return json(res, 200, { users: await Promise.all(users.map(async u => ({ ...u, usage: await storage.ownerUsage(u.username) }))) }); }
    if (method === 'POST') return json(res, 201, await auth.createUser(await bodyJSON(req)));
  }
  if (path.startsWith('/api/users/') && method === 'PUT') { administrator(session); return json(res, 200, await auth.updateUser(decodeURIComponent(path.slice('/api/users/'.length)), await bodyJSON(req))); }
  if (path === '/api/mfa' && method === 'GET') return json(res, 200, auth.mfaStatus(owner));
  if (path === '/api/mfa/enroll' && method === 'POST') return json(res, 200, await auth.beginMfaEnrollment(owner, await bodyJSON(req), clientIP(req)));
  if (['/api/mfa/confirm', '/api/mfa/disable'].includes(path) && method === 'POST') {
    const input = await bodyJSON(req), result = path.endsWith('/confirm') ? await auth.confirmMfaEnrollment(owner, input, clientIP(req)) : await auth.disableMfa(owner, input, clientIP(req));
    const refreshed = auth.newSession(owner); res.setHeader('Set-Cookie', auth.cookie(refreshed.token));
    return json(res, 200, { ...result, csrf: refreshed.csrf, user: refreshed.user, role: refreshed.role });
  }
  if (path === '/api/uploads') {
    if (method === 'POST') { const input = await bodyJSON(req); return json(res, 201, await storage.createMultipartUpload(input.bucket, input.key, { contentType: input.contentType, owner })); }
    if (method === 'GET') {
      const bucket = url.searchParams.get('bucket');
      const buckets = bucket ? [{ name: bucket }] : await storage.buckets();
      const uploads = [];
      for (const item of buckets) { const list = await storage.listMultipartUploads(item.name, { maxUploads: 1000 }); for (const upload of list.uploads || []) if (admin || upload.owner === owner) uploads.push({ ...upload, bucket: item.name }); }
      return json(res, 200, { uploads });
    }
  }
  const upload = /^\/api\/uploads\/([^/]+)(?:\/(parts\/(\d+)|complete))?$/.exec(path);
  if (upload) {
    const { bucket, key } = coordinates(url), id = upload[1];
    // The persisted owner is checked for every operation, including reads/abort.
    const found = storage._upload(bucket, key, id);
    if (!found || (!admin && found.owner !== owner)) throw new ApiError(404, 'Загрузка не найдена.');
    if (method === 'GET' && !upload[2]) {
      let result, marker = 0; const parts = [];
      do { result = await storage.listParts(bucket, key, id, { maxParts: 1000, partNumberMarker: marker }); parts.push(...result.parts); marker = result.nextPartNumberMarker; } while (result.isTruncated);
      return json(res, 200, { ...result, parts });
    }
    if (method === 'PUT' && upload[3]) return json(res, 200, await storage.uploadPart(bucket, key, id, Number(upload[3]), req, { owner: found.owner }));
    if (method === 'POST' && upload[2] === 'complete') return json(res, 200, await storage.completeMultipartUpload(bucket, key, id, (await bodyJSON(req)).parts, { owner: found.owner }));
    if (method === 'DELETE' && !upload[2]) { await storage.abortMultipartUpload(bucket, key, id); return json(res, 200, { ok: true }); }
  }
  if (path === '/api/versions' && method === 'GET') {
    const { bucket, key } = coordinates(url), result = await storage.listObjectVersions(bucket, { prefix: key, maxKeys: 1000 });
    return json(res, 200, { ...result, versions: (result.versions || []).filter(v => v.key === key), deleteMarkers: (result.deleteMarkers || []).filter(v => v.key === key) });
  }
  if (path === '/api/versions/restore' && method === 'POST') { const input = await bodyJSON(req); return json(res, 200, await storage.restoreObject(input.bucket, input.key, input.versionId, { owner })); }
  if (path === '/api/version' && method === 'DELETE') { const { bucket, key } = coordinates(url), versionId = url.searchParams.get('versionId'); if (!versionId) throw new ApiError(400, 'Укажите версию.'); await storage.deleteObject(bucket, key, { versionId }); return json(res, 200, { ok: true }); }
  if (path === '/api/trash' && method === 'GET') return json(res, 200, { objects: await storage.listTrash(url.searchParams.get('bucket'), { maxKeys: 1000 }) });
  if (path === '/api/trash/purge' && method === 'POST') {
    const { bucket, key } = await bodyJSON(req);
    const rows = await storage.listObjectVersions(bucket, { prefix: key, maxKeys: 1000 });
    for (const version of [...(rows.versions || []), ...(rows.deleteMarkers || [])].filter(v => v.key === key)) await storage.deleteObject(bucket, key, { versionId: version.versionId });
    auth.audit('object.purged', `${bucket}/${key}`); return json(res, 200, { ok: true });
  }
  if (path === '/api/bucket-quota') {
    const bucket = url.searchParams.get('bucket');
    if (method === 'GET') return json(res, 200, await storage.bucketUsage(bucket));
    if (method === 'PUT') { administrator(session); return json(res, 200, await storage.setBucketQuota(bucket, await bodyJSON(req))); }
  }
  if (path === '/api/ha' && method === 'GET') { administrator(session); return json(res, 200, getHa()?.status() || { enabled: false, role: 'single', isLeader: true }); }
  if (path === '/api/monitor' && method === 'GET') return json(res, 200, monitor.snapshot(await storage.status(), { ha: getHa()?.status(), scrub: auth.preference('lastScrubResult', null) }));
  if (path === '/api/monitor/settings' && method === 'PUT') { administrator(session); return json(res, 200, monitor.configure(await bodyJSON(req))); }
  if (path === '/api/monitor/ack' && method === 'POST') { monitor.acknowledge((await bodyJSON(req)).id); return json(res, 200, { ok: true }); }
  if (path === '/api/metrics' && method === 'GET') { administrator(session); const output = monitor.prometheus(monitor.snapshot(await storage.status(), { ha: getHa()?.status(), scrub: auth.preference('lastScrubResult', null) })); res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(output); return true; }
  if (path === '/api/cluster/plan' && method === 'POST') {
    administrator(session); const { mode, nodes } = await bodyJSON(req);
    if (!['raid0', 'raid1', 'raid10'].includes(mode) || !Array.isArray(nodes) || !nodes.length || nodes.length > 64 || (mode === 'raid1' && nodes.length < 2) || (mode === 'raid10' && (nodes.length < 4 || nodes.length % 2))) throw new ApiError(400, 'Недопустимый состав узлов для выбранного режима.');
    const current = await storage.status(), byId = new Map(current.nodes.map(n => [n.id, n]));
    const capacities = nodes.map(n => byId.get(n.id)?.capacityBytes ?? null), known = capacities.every(n => n !== null);
    const rawBytes = known ? capacities.reduce((a, b) => a + b, 0) : null;
    const usefulBytes = !known ? null : mode === 'raid0' ? rawBytes : mode === 'raid1' ? Math.min(...capacities) : capacities.reduce((sum, n, i) => i % 2 ? sum : sum + Math.min(n, capacities[i + 1]), 0);
    const warnings = ['Расчёт приблизительный: целые объекты, резерв для ремонта и независимость дисков влияют на полезную ёмкость.'];
    if (!known) warnings.push('Ёмкость новых узлов станет известна после проверки подключения.');
    if (mode === 'raid0') warnings.push('RAID0 не защищает от потери узла.');
    if (getHa() && nodes.some(n => n.url === 'local')) warnings.push('HA требует HTTP-узлов хранения и зеркальных копий; local нельзя использовать для новых данных.');
    return json(res, 200, { mode, nodeCount: nodes.length, rawBytes, usefulBytes, moveBytes: current.retainedBytes ?? current.totalBytes, warnings });
  }
  const agentStore = () => auth.preference('diskAgents', []);
  if (path === '/api/disk-agents') {
    administrator(session);
    if (method === 'GET') return json(res, 200, { agents: agentStore().map(({ secret, ...a }) => a) });
    if (method === 'POST') {
      const input = await bodyJSON(req); let endpoint;
      try { endpoint = new URL(input.url); } catch { throw new ApiError(400, 'Некорректный адрес агента.'); }
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new ApiError(400, 'Адрес агента должен быть HTTP(S) origin.');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 512 || /[\r\n]/.test(input.token)) throw new ApiError(400, 'Укажите ID и токен агента длиной 32–512 символов.');
      const agents = agentStore(); if (agents.some(a => a.id === input.id) || agents.length >= 64) throw new ApiError(409, 'ID занят или достигнут лимит агентов.');
      agents.push({ id: input.id, label: String(input.label || input.id).slice(0, 100), url: endpoint.origin, secret: auth.encrypt(input.token) }); auth.setPreference('diskAgents', agents); auth.audit('disk.agent_added', input.id);
      return json(res, 201, { ok: true });
    }
  }
  const disk = /^\/api\/disk-agents\/([^/]+)(?:\/disks(?:\/([a-f0-9-]{36})\/(retry))?)?$/.exec(path);
  if (disk) {
    administrator(session); const agents = agentStore(), agent = agents.find(a => a.id === disk[1]); if (!agent) throw new ApiError(404, 'Агент не найден.');
    if (method === 'DELETE' && !path.endsWith('/disks') && !disk[2]) { auth.setPreference('diskAgents', agents.filter(a => a.id !== agent.id)); return json(res, 200, { ok: true }); }
    const endpoint = disk[2] ? `/disks/${disk[2]}/retry` : '/disks';
    const input = method === 'POST' ? await bodyJSON(req) : undefined;
    const response = await fetch(agent.url + endpoint, { method, headers: { authorization: `Bearer ${auth.decrypt(agent.secret)}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), redirect: 'error', signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status >= 500 ? 502 : response.status, result.error || 'Ошибка дискового агента.');
    if (method === 'POST') {
      const { token, ...volume } = result; auth.audit('disk.added', `${agent.id}/${volume.id}`);
      return json(res, 201, { disk: volume, node: { id: `disk-${volume.id}`, label: volume.label, url: `${agent.url}/volumes/${volume.id}`, token } });
    }
    return json(res, 200, result);
  }
  return false;
}

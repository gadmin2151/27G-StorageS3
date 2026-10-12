import { ApiError } from './auth.mjs';

const defaults = { diskPercent: 85, queuePercent: 80, latencyMs: 2000 };
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
export class Monitor {
  constructor(auth) { this.auth = auth; this.startedAt = new Date().toISOString(); this.requests = 0; this.errors = 0; this.durations = []; this.series = []; this.ack = new Map(); this.last = null; }
  record(status, elapsed) {
    this.requests++; if (status >= 500) this.errors++;
    this.durations.push(Math.max(0, elapsed)); if (this.durations.length > 2048) this.durations.shift();
  }
  settings() { return { ...defaults, ...this.auth.preference('monitorThresholds', {}) }; }
  configure(values) {
    const next = { ...this.settings(), ...values };
    for (const name of ['diskPercent', 'queuePercent']) if (!Number.isInteger(next[name]) || next[name] < 1 || next[name] > 100) throw new ApiError(400, 'Порог должен быть целым числом от 1 до 100%.');
    if (!Number.isInteger(next.latencyMs) || next.latencyMs < 10 || next.latencyMs > 300000) throw new ApiError(400, 'Порог задержки: 10–300000 мс.');
    this.auth.setPreference('monitorThresholds', { diskPercent: next.diskPercent, queuePercent: next.queuePercent, latencyMs: next.latencyMs }); return this.settings();
  }
  acknowledge(id) { if (typeof id !== 'string' || !this.last?.alerts.some(a => a.id === id)) throw new ApiError(404, 'Предупреждение не найдено.'); this.ack.set(id, Date.now()); }
  snapshot(storage, { ha, scrub } = {}) {
    const settings = this.settings(), sorted = [...this.durations].sort((a, b) => a - b), now = Date.now();
    const metrics = { requests: this.requests, errors: this.errors, p50: percentile(sorted, .5), p95: percentile(sorted, .95), p99: percentile(sorted, .99), rssBytes: process.memoryUsage().rss, activeUploads: storage.queue.active, queuedUploads: storage.queue.pending, cacheHitRatio: storage.cache.hits + storage.cache.misses ? storage.cache.hits / (storage.cache.hits + storage.cache.misses) : null };
    if (!this.series.length || now - this.series.at(-1).at >= 10000) { this.series.push({ at: now, ...metrics }); if (this.series.length > 360) this.series.shift(); }
    const alerts = [], add = (id, severity, message) => alerts.push({ id, severity, message, acknowledgedAt: this.ack.has(id) ? new Date(this.ack.get(id)).toISOString() : null });
    for (const node of storage.nodes) {
      if (node.online === false) add(`node:${node.id}`, 'critical', `Узел ${node.label || node.id} недоступен. Проверьте соединение и диск.`);
      else if (node.capacityBytes > 0 && (1 - node.freeBytes / node.capacityBytes) * 100 >= settings.diskPercent) add(`disk:${node.id}`, 'warning', `На узле ${node.label || node.id} занято не менее ${settings.diskPercent}% диска.`);
    }
    const byDisk = new Map();
    for (const node of storage.nodes) if (node.filesystemId) { const group = byDisk.get(node.filesystemId) || []; group.push(node.id); byDisk.set(node.filesystemId, group); }
    for (const [disk, nodes] of byDisk) if (nodes.length > 1 && storage.mode !== 'raid0') add(`shared-disk:${disk}`, 'warning', `Узлы ${nodes.join(', ')} используют одну файловую систему: копии не независимы.`);
    if (storage.queue.limit && storage.queue.pending / storage.queue.limit * 100 >= settings.queuePercent) add('queue', 'warning', 'Очередь загрузок близка к заполнению.');
    if (metrics.p95 > settings.latencyMs) add('latency', 'warning', `Задержка p95 превышает ${settings.latencyMs} мс (учитывается полное время передачи).`);
    if (scrub?.unrecoverable || scrub?.repairFailed) add('integrity', 'critical', `Последняя проверка: невосстановимых объектов ${scrub.unrecoverable || 0}, ошибок ремонта ${scrub.repairFailed || 0}.`);
    if (ha?.enabled && !ha.isLeader) add('coordinator', 'warning', 'Этот координатор не обслуживает запись: проверьте состояние master/slave и арбитра.');
    if (ha?.enabled) add('ha-gc', 'warning', 'В режиме HA физическая очистка старых blobs отключена до внедрения fencing на узлах хранения. Следите за свободным местом.');
    for (const id of this.ack.keys()) if (!alerts.some(a => a.id === id)) this.ack.delete(id);
    this.last = { startedAt: this.startedAt, metrics, settings, alerts, series: [...this.series], nodes: storage.nodes, scrub: scrub ? { ...scrub, at: this.auth.preference('lastScrubAt', null) } : null, ha: ha || { enabled: false }, note: 'Метрики запросов и история наблюдений сбрасываются при перезапуске; полное время передачи входит в задержку.' };
    return this.last;
  }
  prometheus(snapshot) {
    const m = snapshot.metrics;
    return [`# HELP storeges3_requests_total HTTP requests since coordinator start`, '# TYPE storeges3_requests_total counter', `storeges3_requests_total ${m.requests}`, '# TYPE storeges3_errors_total counter', `storeges3_errors_total ${m.errors}`, `storeges3_process_rss_bytes ${m.rssBytes}`, `storeges3_uploads_active ${m.activeUploads}`, `storeges3_uploads_queued ${m.queuedUploads}`, `storeges3_request_duration_p95_ms ${m.p95}`, `storeges3_alerts_active ${snapshot.alerts.length}`, ''].join('\n');
  }
}

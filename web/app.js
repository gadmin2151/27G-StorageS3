import { t, setLanguage, getLanguage, locale } from './i18n.js';
import './i18n-app.js';
import { serverText } from './i18n-server.js';

'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    bucket: '<path d="m4 7 2 13c.2 2 11.8 2 12 0l2-13"/><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M6 13c3 2 9 2 12 0"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
    key: '<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9M16 16l3-3M18.5 18.5l3-3"/>',
    book: '<path d="M12 5v16M12 5C8 2 5 3 2 4v15c3-1 6-2 10 1 4-3 7-2 10-1V4c-3-1-6-2-10 1Z"/>',
    settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 3-3-2-2 1-3-3-2-1-3Z"/><circle cx="10.5" cy="11.5" r="3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    link: '<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="m6 6 12 12M6 18 18 6"/>',
    logout: '<path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    file: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v5h5M8 12h8M8 16h8"/>',
    folder: '<path d="M3 6h7l2 3h9v11H3Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>'
  };
  const icon = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
  const button = (label, action, kind = '', glyph = '', extra = '') => `<button type="button" class="button ${kind}" data-action="${esc(action)}" aria-label="${esc(label)}" ${extra}>${glyph ? icon(glyph) : ''}<span class="button-text">${esc(label)}</span></button>`;
  const bytes = n => {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n === 0) return t("0 Б");
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
    return `${new Intl.NumberFormat(locale(), {maximumFractionDigits:i ? 1 : 0}).format(n / 1024 ** i)} ${[t("Б"),t("КиБ"),t("МиБ"),t("ГиБ"),t("ТиБ")][i]}`;
  };
  const number = n => Number.isFinite(Number(n)) ? new Intl.NumberFormat(locale()).format(Number(n)) : '—';
  const date = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat(locale(), {dateStyle:'medium',timeStyle:'short'}).format(d); };
  const duration = seconds => { const n = Math.max(0, Number(seconds) || 0); return n > 86400 ? t("{p0} д {p1} ч", {p0: Math.floor(n/86400), p1: Math.floor(n%86400/3600)}) : n > 3600 ? t("{p0} ч {p1} мин", {p0: Math.floor(n/3600), p1: Math.floor(n%3600/60)}) : t("{p0} мин", {p0: Math.floor(n/60)}); };
  const state = {language:'en',csrf:null,user:null,role:'viewer',defaultCredentials:false,setupTokenRequired:false,page:'overview',data:null,status:null,bucket:'',prefix:'',renderID:0,uploads:[],uploadConcurrency:3,menu:false,topology:null,auditPage:1,auditPageSize:10};
  let features;
  const navigation = () => [['overview',t("Обзор"),'grid'],['buckets',t("Бакеты и объекты"),'bucket'],['uploads',t("Загрузки"),'upload'],['cluster',t("Кластер"),'server'],['monitoring',t("Диагностика"),'activity'],['users',t("Пользователи"),'shield'],['keys',t("Ключи доступа"),'key'],['wiki',t("Документация"),'book'],['settings',t("Настройки"),'settings']];

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && typeof options.body !== 'string' && !(options.body instanceof Blob)) {
      headers.set('Content-Type','application/json'); options.body = JSON.stringify(options.body);
    }
    if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', state.csrf || '');
    const response = await fetch(path, {...options,headers,credentials:'same-origin'});
    const raw = await response.text();
    let result = {};
    if (raw) { try { result = JSON.parse(raw); } catch { result = {message:raw.slice(0,300)}; } }
    if (!response.ok) {
      const detail = typeof result.error === 'string' ? result.error : result.error?.message || result.message || t("Ошибка {p0}", {p0: response.status});
      if (response.status === 401 && state.user && !path.includes('/password')) {
        state.user = null; state.csrf = null; stopUploads(); init(); toast(t("Сессия завершена. Войдите снова."),true);
      }
      const error = new Error(serverText(detail)); error.status = response.status; error.code = result.code || result.error?.code; throw error;
    }
    return result;
  }
  function toast(message, error = false) {
    const item = document.createElement('div'); item.className = `toast${error ? ' error' : ''}`;
    const text = document.createElement('span'); text.textContent = message;
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label',t("Закрыть уведомление")); close.addEventListener('click',() => item.remove());
    item.append(text,close); $('#toast-region').append(item); setTimeout(() => item.remove(), error ? 11000 : 6500);
  }
  function errorBlock(error, retry = true) { return `<div class="notice error" role="alert">${icon('info')}<div><strong>${esc(t("Не удалось загрузить данные"))}</strong><p>${esc(error.message)}</p>${retry ? button(t("Попробовать снова"),'refresh','small') : ''}</div></div>`; }
  function brand() { return `<span class="brand-mark" aria-hidden="true"><img src="/console/brand-mark.png" alt="" width="40" height="40"></span><div><div class="brand-name">27G-Storage<span>S3</span></div></div>`; }
  function health() {
    const nodes = state.status?.nodes || [];
    if (!nodes.length) return `<span class="health"><span class="dot warn"></span>${esc(t("Статус загружается"))}</span>`;
    if (nodes.some(n => n.online === false)) return `<span class="health"><span class="dot bad"></span>${esc(t("Есть недоступные узлы"))}</span>`;
    if (nodes.some(n => n.online === undefined)) return `<span class="health"><span class="dot warn"></span>${esc(t("Статус узлов не определён"))}</span>`;
    return `<span class="health"><span class="dot"></span>${esc(t("Все узлы доступны"))}</span>`;
  }
  function shell() {
    const title = navigation().find(n => n[0] === state.page)?.[1] || t("Бакеты и объекты");
    const username = (typeof state.user === 'string' ? state.user : state.user?.username || state.user?.name) || t("Администратор");
    $('#app').innerHTML = `<div class="shell${state.menu ? ' menu-open' : ''}">
      <div class="menu-shade" data-action="menu-close"></div>
      <aside class="sidebar" aria-label="${esc(t("Главная навигация"))}">
        <button type="button" class="icon-btn sidebar-close" data-action="menu-close" aria-label="${esc(t("Закрыть меню"))}">${icon('x')}</button>
        <a class="brand" href="#overview" aria-label="${esc(t("27G-StorageS3 — обзор"))}">${brand()}</a>
        <nav class="nav">${navigation().filter(([id]) => id !== 'users' || state.role === 'admin').map(([id,label,glyph]) => {
          const active = state.page === id || id === 'buckets' && state.page === 'objects';
          return `<a href="#${id}" class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(glyph)}${label}</a>`;
        }).join('')}</nav>
        <div class="sidebar-bottom"><div class="sidebar-family"><strong>27G</strong><p>${esc(t("Своя инфраструктура."))}<br>${esc(t("Ваши данные."))}</p></div><div class="version"><span>StorageS3</span><span id="sidebar-version">v${esc(state.status?.version || '0.3.2')}</span></div></div>
      </aside>
      <div class="workspace">
        <header class="topbar"><div class="row">
          <button type="button" class="icon-btn mobile-toggle" data-action="menu" aria-label="${esc(t("Открыть меню"))}" aria-expanded="${state.menu}">${icon('menu')}</button>
          <div class="breadcrumb"><span class="workspace-title">27G / STORAGE</span>${icon('chevron').replace('class="icon"','class="icon breadcrumb-icon"')}<strong>${esc(title)}</strong></div>
        </div><div class="topbar-actions"><div id="system-health">${health()}</div><div class="user-menu"><span class="avatar" title="${esc(username)}">${esc(username.slice(0,2).toUpperCase())}</span><button class="icon-btn" type="button" data-action="logout" aria-label="${esc(t("Выйти из аккаунта"))}" title="${esc(t("Выйти"))}">${icon('logout')}</button></div></div></header>
        <main class="main" id="main" tabindex="-1"><div class="loading" role="status">${esc(t("Загружаем данные…"))}</div></main>
      </div></div><div id="upload-container"></div>`;
    renderQueue();
  }
  function heading(title, description, actions = '', eyebrow = t("Панель управления")) { return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="row wrap">${actions}</div>` : ''}</div>`; }
  function modeName(mode, nodes = []) { return nodes.length === 1 && (mode === 'raid0' || mode === 'single') ? t("Один узел") : String(mode || '—').toUpperCase(); }
  function modeDescription(mode, nodes = []) {
    if (nodes.length === 1) return t("Объекты хранятся на одном узле. Добавьте узлы для расширения ёмкости или создания копий.");
    return ({raid0:t("Объекты распределяются между узлами. Суммарная ёмкость растёт, резервных копий нет."),raid1:t("Каждый объект записывается на все узлы. Загрузка завершается после подтверждения каждой копии."),raid10:t("Объекты распределяются между парами узлов. Внутри каждой пары хранятся две одинаковые копии.")})[mode] || t("Топология хранилища.");
  }
  function clusterGraphic(nodes, mode, limit = 6) {
    const node = n => `<div class="node-tile">${icon('server')}<strong title="${esc(n.label || n.id)}">${esc(n.id === 'local' && n.label === 'Coordinator storage' ? t("Локальный узел") : n.label || n.id)}</strong><small><span class="dot${n.online === false ? ' bad' : n.online === undefined ? ' warn' : ''}"></span>${n.online === false ? t("Недоступен") : n.online === undefined ? t("Не проверен") : t("Доступен")}</small></div>`;
    const visible = nodes.slice(0,limit);
    const content = mode === 'raid10' ? visible.reduce((acc,n,i) => i%2 ? acc : acc + `<div class="node-pair">${node(n)}${visible[i+1] ? node(visible[i+1]) : ''}</div>`, '') : visible.map(node).join('');
    return `<div class="cluster-visual">${content || `<span class="muted">${esc(t("Нет настроенных узлов"))}</span>`}</div>${nodes.length > limit ? `<p class="cluster-limit">${esc(t('Дополнительных узлов: {p0}', {p0:number(nodes.length-limit)}))}</p>` : ''}`;
  }
  function stat(label, value, foot, glyph, accent = false) {
    return `<article class="stat${accent ? ' stat-accent' : ''}"><div class="stat-icon">${icon(glyph)}</div><div class="stat-content"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div></article>`;
  }
  function bucketTable(buckets, compact = false) {
    if (!buckets.length) return `<div class="empty">${icon('bucket')}<h3>${esc(t("Первый бакет — начало хранилища"))}</h3><p>${esc(t("Создайте пространство для файлов, резервных копий или данных приложения."))}</p>${button(t("Создать бакет"),'new-bucket','primary','plus')}</div>`;
    return `<div class="table-wrap"><table><thead><tr><th>${esc(t("Название бакета"))}</th><th>${esc(t("Объекты"))}</th><th>${esc(t("Объём данных"))}</th><th>${compact ? t("Доступ") : t("Создан")}</th><th><span class="visually-hidden">${esc(t("Действия"))}</span></th></tr></thead><tbody>${buckets.map(b => `<tr><td><a class="table-name" href="#objects?bucket=${encodeURIComponent(b.name)}">${icon('bucket')}<span>${esc(b.name)}</span></a></td><td>${number(b.objects)}</td><td>${bytes(b.bytes)}</td><td class="muted">${compact ? `<span class="badge ${b.accessMode==='public-read'?'accent':''}">${b.accessMode==='public-read'?t("По прямой ссылке"):t("Закрытый")}</span>` : date(b.createdAt)}</td><td class="table-actions">${compact ? `<a href="#objects?bucket=${encodeURIComponent(b.name)}" aria-label="${esc(t("Открыть"))} ${esc(b.name)}">${icon('arrow')}</a>` : button(t("Удалить"),'delete-bucket','small danger','trash',`data-bucket="${esc(b.name)}"`)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderOverview(s, buckets) {
    const nodes = s.nodes || [], knownCapacity = nodes.length && nodes.every(n => Number.isFinite(n.capacityBytes ?? n.totalBytes) && Number.isFinite(n.freeBytes));
    const capacity = knownCapacity ? nodes.reduce((a,n) => a+(n.capacityBytes ?? n.totalBytes),0) : null;
    const free = knownCapacity ? nodes.reduce((a,n) => a+n.freeBytes,0) : null;
    const used = knownCapacity ? capacity-free : null;
    const percentage = knownCapacity && capacity > 0 ? Math.max(0,Math.min(100,Math.round(used/capacity*100))) : null;
    const cache = s.cache || {}, queue = s.queue || {};
    const hits = Number(cache.hits || 0), misses = Number(cache.misses || 0), ratio = hits+misses ? Math.round(hits/(hits+misses)*100)+'%' : t("Нет запросов");
    return heading(t("Ваши данные. Под контролем."),t("Объекты, ресурсы и состояние кластера в одном месте."),button(t("Обновить"),'refresh','','refresh') + button(t("Создать бакет"),'new-bucket','primary','plus'), '') +
      `<section class="system-banner${nodes.some(n => n.online === false) ? ' degraded' : ''}" aria-label="${esc(t("Состояние узлов"))}"><span class="system-banner-dot dot${nodes.some(n => n.online === false) ? ' bad' : !nodes.length || nodes.some(n => n.online !== true) ? ' warn' : ''}" aria-hidden="true"></span><div class="system-banner-copy"><strong>${nodes.length && nodes.every(n => n.online === true) ? t("Все узлы на связи") : nodes.some(n => n.online === false) ? t("Есть недоступные узлы") : t("Доступность узлов не определена")}</strong><p>${esc(modeName(s.mode,nodes))} · ${nodes.length === 1 ? t("Подключите дополнительные узлы в разделе «Кластер».") : t("Состояние подключённых узлов на момент обновления.")}</p></div><div class="system-banner-meta"><span class="eyebrow">${esc(t("Время работы"))}</span><strong>${duration(s.uptime)}</strong></div></section><div class="stats">${stat(t("Объём объектов"),bytes(s.totalBytes), t("Без учёта реплик"),'bucket',true)}${stat(t("Объектов"),number(s.objectCount), t("Бакетов: {p0}", {p0: number(buckets.length)}),'file')}${stat(t("Узлы хранилища"),`${nodes.filter(n => n.online === true).length}<small> / ${nodes.length}</small>`, `${esc(modeName(s.mode,nodes))} · ${nodes.filter(n => n.online === false).length ? t("есть недоступные") : t("доступны")}`,'server')}${stat(t("Активные загрузки"),number(queue.active ?? 0), t("В очереди: {p0} · лимит {p1}", {p0: number(queue.pending ?? 0), p1: number(queue.concurrency)}),'activity')}</div>
      <div class="overview-grid"><section class="panel"><div class="panel-head"><div><h2>${esc(t("Пространство для ваших данных"))}</h2><p>${esc(t("Физические диски подключённых узлов"))}</p></div><span class="badge">${knownCapacity ? bytes(capacity) : t("Ёмкость не определена")}</span></div><div class="panel-body"><div class="capacity"><div class="storage-ring"><svg class="ring-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52"/><circle class="ring-value" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${percentage ?? 0} 100" transform="rotate(-90 60 60)"/></svg><span>${percentage === null ? '—' : percentage+'%'}<small>${knownCapacity ? t("дисков занято") : t("нет данных о дисках")}</small></span></div><div class="capacity-details"><div class="legend-item"><span><i class="legend-dot"></i>${esc(t("Объекты без реплик"))}</span><strong>${bytes(s.totalBytes)}</strong></div><div class="legend-item"><span><i class="legend-dot gray"></i>${esc(t("Занято на дисках"))}</span><strong>${used === null ? '—' : bytes(used)}</strong></div><div class="legend-item"><span><i class="legend-dot outline"></i>${esc(t("Свободно на дисках"))}</span><strong>${free === null ? '—' : bytes(free)}</strong></div></div></div><div class="endpoint-box"><div class="spacer"><div class="eyebrow">S3 endpoint · path-style</div><code>${esc(s.endpoint || location.origin)}</code></div><button class="icon-btn" type="button" data-action="copy" data-copy="${esc(s.endpoint || location.origin)}" aria-label="${esc(t("Скопировать S3 endpoint"))}">${icon('copy')}</button></div><p class="tiny muted note-top">${esc(t("Ёмкость дисков включает другие файлы; диски общих файловых систем могут учитываться несколько раз."))}</p></div></section>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t("Ваш кластер"))}</h2><p>${esc(t("Топология и доступность узлов"))}</p></div><span class="badge accent">${esc(modeName(s.mode,nodes))}</span></div><div class="panel-body"><div class="overview-cluster">${clusterGraphic(nodes,s.mode)}</div><p class="cluster-caption">${esc(modeDescription(s.mode,nodes))}</p><div class="row between small-summary"><span>${esc(t("RAM-кэш"))} <strong>${bytes(cache.bytes ?? 0)}</strong> / ${bytes(cache.limit)}</span><span>${esc(t("Попадания"))} <strong>${ratio}</strong></span></div><progress class="cache-meter" max="${Math.max(1,Number(cache.limit) || 0)}" value="${Math.max(0,Number(cache.bytes) || 0)}" aria-label="${esc(t("Использование RAM-кэша"))}"></progress></div><div class="panel-footer"><span>${esc(t("В работе"))} ${duration(s.uptime)}</span><a href="#cluster">${esc(t("Управление кластером"))} ${icon('arrow')}</a></div></section></div>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t("Бакеты"))}</h2><p>${esc(t("Пространства для хранения объектов"))}</p></div><div class="search-wrap"><label class="visually-hidden" for="overview-bucket-search">${esc(t("Поиск бакетов в обзоре"))}</label>${icon('search')}<input id="overview-bucket-search" class="search-input" type="search" placeholder="${esc(t("Поиск по бакетам…"))}"></div></div><div id="overview-bucket-results">${bucketTable(buckets.slice(0,5),true)}</div><div class="panel-footer"><span>${esc(t("Бакетов:"))} ${number(buckets.length)}</span><a href="#buckets">${esc(t("Все бакеты"))} ${icon('arrow')}</a></div></section>
      <div class="notice section-gap">${icon('book')}<div><strong>${esc(t("Всё начинается с понятной настройки."))}</strong> ${esc(t("Подключите S3-клиент, выберите топологию и узнайте, как защитить данные."))} <a href="#wiki">${esc(t("Открыть документацию →"))}</a></div></div>
      ${s.limitations?.length ? `<details class="section-gap small-summary"><summary>${esc(t("Границы текущей версии"))}</summary><ul>${s.limitations.map(x => `<li>${esc(serverText(x))}</li>`).join('')}</ul></details>` : ''}<p class="footer-note">27G-StorageS3 · ${esc(s.version || '0.3.1')} ${esc(t("· Собственная инфраструктура. Ваши данные."))}</p>`;
  }
  function renderBuckets(buckets) { return heading(t("Бакеты и объекты"),t("Разделяйте данные по проектам и управляйте файлами."),button(t("Создать бакет"),'new-bucket','primary','plus')) + `<div class="toolbar"><div class="search-wrap">${icon('search')}<input id="bucket-search" class="search-input" type="search" placeholder="${esc(t("Найти бакет…"))}" aria-label="${esc(t("Поиск бакетов"))}"></div><span class="muted tiny">${esc(t('Всего бакетов: {p0}', {p0:number(buckets.length)}))}</span><span class="spacer"></span>${button(t("Обновить"),'refresh','','refresh')}</div><section class="panel" id="bucket-results">${bucketTable(buckets)}</section>`; }
  function objectTable(objects, prefixes) {
    if (!objects.length && !prefixes.length) return `<div class="empty">${icon('folder')}<h3>${esc(t("Здесь пока нет объектов"))}</h3><p>${state.prefix ? t("В этом префиксе нет файлов. Выберите другой префикс или загрузите объекты сюда.") : t("Перетащите файлы в область выше или подключите приложение по S3 API.")}</p></div>`;
    return `<div class="table-wrap"><table class="object-table"><thead><tr><th>${esc(t("Объект"))}</th><th>${esc(t("Размер"))}</th><th class="object-modified">${esc(t("Изменён"))}</th><th><span class="visually-hidden">${esc(t("Действия"))}</span></th></tr></thead><tbody>${prefixes.map(p => {const prefix = typeof p === 'string' ? p : p.prefix || p.Prefix; return `<tr><td><a class="table-name" href="#objects?bucket=${encodeURIComponent(state.bucket)}&prefix=${encodeURIComponent(prefix)}">${icon('folder')}<span>${esc(prefix)}</span></a></td><td class="muted">${esc(t("Префикс"))}</td><td class="object-modified">—</td><td></td></tr>`;}).join('')}${objects.map(o => `<tr><td><button class="table-name object-open" type="button" data-action="object-preview" data-key="${esc(o.key)}" title="${esc(t("Просмотреть"))} ${esc(o.key)}">${icon('file')}<span class="object-key">${esc(o.key.startsWith(state.prefix) ? o.key.slice(state.prefix.length) : o.key)}</span></button><small class="object-mobile-date muted">${date(o.modifiedAt)}</small></td><td>${bytes(o.size)}</td><td class="muted object-modified">${date(o.modifiedAt)}</td><td class="table-actions"><div class="object-actions">${button(t("Поделиться"),'share-object','small','link',t("data-key=\"{p0}\" title=\"Поделиться файлом\"", {p0: esc(o.key)}))}<a class="button small square" href="/api/object?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(o.key)}" download aria-label="${esc(t("Скачать"))} ${esc(o.key)}" title="${esc(t("Скачать"))}">${icon('download')}</a>${button(t("Другие действия"),'object-menu','small square','more',t("data-key=\"{p0}\" title=\"Другие действия\"", {p0: esc(o.key)}))}</div></td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderObjects(data) {
    return heading(state.bucket,t("Просматривайте, загружайте и скачивайте объекты."),`<a href="#buckets" class="button">${esc(t("Все бакеты"))}</a>${button(t("Обновить"),'refresh','','refresh')}`, t("Бакеты / объекты")) +
      `<div class="dropzone" id="dropzone">${icon('upload')}<strong>${esc(t("Перетащите файлы сюда"))} ${button(t("Выбрать файлы"),'choose-files','','plus')}</strong><p>${esc(t("Загрузка в"))} ${esc(state.bucket)}${state.prefix ? ' / '+esc(state.prefix) : ''} ${esc(t("· до"))} ${state.uploadConcurrency} ${esc(t("файлов одновременно"))}</p><input class="visually-hidden" id="upload-files" type="file" multiple aria-label="${esc(t("Файлы для загрузки"))}"></div><form id="prefix-form" class="toolbar"><div class="search-wrap">${icon('search')}<input class="search-input" name="prefix" type="search" value="${esc(state.prefix)}" placeholder="${esc(t("Фильтр по префиксу, например photos/"))}" aria-label="${esc(t("Префикс объектов"))}"></div><button class="button" type="submit">${esc(t("Показать"))}</button>${state.prefix ? '<a class="button ghost" href="#objects?bucket='+encodeURIComponent(state.bucket)+`">${esc(t("Сбросить"))}</a>` : ''}<span class="spacer"></span><span class="muted tiny">${esc(t('Объектов на странице: {p0}', {p0:number(data.objects?.length || 0)}))}</span></form><section class="panel">${objectTable(data.objects || [],data.commonPrefixes || [])}${data.isTruncated ? `<div class="panel-footer"><span>${esc(t("Показаны не все объекты"))}</span>${button(t("Следующая страница"),'next-objects','small','arrow',`data-token="${esc(data.nextContinuationToken)}"`)}</div>` : ''}</section>`;
  }
  function nodeFields(node, index) { return `<div class="node-form" data-node><div class="field"><label for="node-id-${index}">${esc(t("ID узла"))}</label><input id="node-id-${index}" name="nodeId" value="${esc(node.id || '')}" required pattern="[a-zA-Z0-9_-]+" maxlength="64" ${node.id === 'local' ? 'readonly' : ''}></div><div class="field"><label for="node-label-${index}">${esc(t("Название"))}</label><input id="node-label-${index}" name="nodeLabel" value="${esc(node.label || '')}" required maxlength="80"></div><div class="field"><label for="node-url-${index}">${esc(t("Внутренний адрес"))}</label><input id="node-url-${index}" name="nodeUrl" value="${esc(node.url || '')}" ${node.id === 'local' ? 'readonly' : ''} required placeholder="http://node1:9100"></div><div class="field"><label for="node-token-${index}">${esc(t("Токен узла"))}</label><input id="node-token-${index}" name="nodeToken" type="password" autocomplete="new-password" placeholder="${node.id === 'local' ? t("Не требуется") : t("Оставить текущий")}" ${node.id === 'local' ? 'disabled' : ''}></div><button type="button" class="icon-btn" data-action="remove-node" aria-label="${esc(t("Удалить узел"))} ${esc(node.label || node.id)}">${icon('trash')}</button></div>`; }
  function renderCluster(topology, status) {
    const hasObjects = Number(status.objectCount) > 0, nodes = topology.nodes || [], mode = topology.mode === 'single' ? 'raid0' : topology.mode;
    state.topology = topology;
    return heading(t("Кластер хранилища"),t("Объединяйте узлы для ёмкости, копирования или обоих сценариев."),button(t("Проверить и восстановить"),'scrub','','shield')) +
      `<div class="notice${hasObjects ? ' warn' : ''}">${icon('info')}<div>${hasObjects ? `<strong>${esc(t("Изменение топологии запустит перенос объектов."))}</strong> ${esc(t("Чтение остаётся доступным, фиксация новых записей ждёт окончания переноса. Подготовьте запас свободного места. Если перенос не удастся, прежняя конфигурация останется активной."))}` : `<strong>${esc(t("Настройте топологию до загрузки данных."))}</strong> ${esc(t("Это распределение и копирование целых объектов между узлами по аналогии с RAID. Каждый узел запускается отдельно и подключается по внутреннему адресу."))}`}</div></div>
      <form id="topology-form" class="section-gap"><fieldset class="plain-fieldset"><legend class="visually-hidden">${esc(t("Режим хранения"))}</legend><div class="mode-grid"><label class="mode-option"><input type="radio" name="mode" value="raid0" ${mode === 'raid0' ? 'checked' : ''}><div class="eyebrow">${esc(t("Больше места"))}</div><strong>RAID 0</strong><span>${esc(t("Один экземпляр объекта. Ёмкость узлов складывается. Потеря узла означает потерю части объектов."))}</span></label><label class="mode-option"><input type="radio" name="mode" value="raid1" ${mode === 'raid1' ? 'checked' : ''}><div class="eyebrow">${esc(t("Копии данных"))}</div><strong>RAID 1</strong><span>${esc(t("Каждый объект на каждом узле. Минимум 2 узла. Полезная ёмкость ограничена самым маленьким."))}</span></label><label class="mode-option"><input type="radio" name="mode" value="raid10" ${mode === 'raid10' ? 'checked' : ''}><div class="eyebrow">${esc(t("Место + копии"))}</div><strong>RAID 10</strong><span>${esc(t("Распределение между зеркальными парами. От 4 узлов, чётное количество. Пары определяются порядком."))}</span></label></div><section class="panel"><div class="panel-head"><div><h2>${esc(t("Узлы кластера"))}</h2><p>${esc(t("Порядок узлов определяет зеркальные пары в RAID 10"))}</p></div>${button(t("Добавить узел"),'add-node','small','plus')}</div><div class="panel-body"><div id="nodes-form" class="nodes-form">${nodes.map(nodeFields).join('')}</div><p class="tiny muted note-top">URL <code>local</code> ${esc(t("— встроенный диск координатора. Для удалённых узлов используйте закрытую сеть Docker и собственный секретный токен."))}</p>${hasObjects ? `<label class="check-label section-gap"><input type="checkbox" id="migration-consent" required>${esc(t("Подтверждаю перенос существующих объектов. На узлах достаточно свободного места; записи могут ждать окончания переноса."))}</label>` : ''}<div id="migration-progress" class="small-summary section-gap" aria-live="polite"></div><div class="form-error" id="topology-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">${icon('check')}${esc(t("Сохранить топологию"))}</button></div></div></section></fieldset></form>
      <div class="overview-grid section-gap"><section class="panel"><div class="panel-head"><div><h2>${esc(t("Текущая схема"))}</h2><p>${esc(modeName(status.mode,status.nodes || []))}</p></div></div><div class="panel-body">${clusterGraphic(status.nodes || [],status.mode,10)}<p class="small-summary">${esc(modeDescription(status.mode,status.nodes || []))}</p></div></section><section class="panel"><div class="panel-head"><h2>${esc(t("Что важно для надёжности"))}</h2></div><div class="panel-body"><p class="small-summary">${esc(t("Копии объектов помогают пережить потерю диска, но не заменяют резервное копирование."))} ${status.ha?.enabled ? t("В HA метаданные фиксируются кворумом etcd; нужны независимые серверы и резервная копия состояния кворума и секретов.") : t("Метаданные и ключи находятся на одном координаторе. Для переключения координатора разверните отдельный профиль HA.")}</p><p class="small-summary">${esc(t("RAID 1 и RAID 10 подтверждают запись только после сохранения всех требуемых копий. При недоступности реплики загрузка завершится ошибкой."))}</p><a href="#wiki-cluster" class="small-summary">${esc(t("Подробнее о режимах и восстановлении →"))}</a></div></section></div><div id="scrub-result"></div>`;
  }
  function renderKeys(keys) {
    return heading(t("Ключи доступа"),t("Подключайте приложения к S3 API и ограничивайте их доступ."),button(t("Создать ключ"),'new-key','primary','plus')) + `<div class="notice">${icon('shield')}<div>${esc(t("По умолчанию бакеты закрыты. Доступ по прямым ссылкам настраивается отдельно в бакете. Создайте отдельный ключ для каждого приложения. Секрет показывается один раз; доступ можно отозвать в любой момент."))}</div></div><section class="panel section-gap"><div class="panel-head"><div><h2>${esc(t("Ключи приложений"))}</h2><p>${esc(t('Ключей доступа: {p0}', {p0:number(keys.length)}))}</p></div><a class="button small ghost" href="#wiki-s3">${esc(t("Подключение S3"))} ${icon('arrow')}</a></div>${keys.length ? `<div class="table-wrap"><table><thead><tr><th>${esc(t("Приложение / ключ"))}</th><th>${esc(t("Разрешения"))}</th><th>${esc(t("Бакеты"))}</th><th>${esc(t("Создан"))}</th><th><span class="visually-hidden">${esc(t("Действия"))}</span></th></tr></thead><tbody>${keys.map(k => `<tr><td><strong>${esc(k.label || t("Без названия"))}</strong><div class="mono muted tiny key-caption">${esc(k.accessKey)}</div></td><td><span class="badge${k.role === 'readonly' ? '' : ' accent'}">${k.role === 'readonly' ? t("Только чтение") : t("Чтение и запись")}</span></td><td class="muted">${Array.isArray(k.buckets) && k.buckets.length ? esc(k.buckets.join(', ')) : t("Все бакеты")}</td><td class="muted">${date(k.createdAt)}</td><td class="table-actions">${button(t("Отозвать"),'revoke-key','small danger','trash',`data-id="${esc(k.id)}" data-label="${esc(k.label || k.accessKey)}"`)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${icon('key')}<h3>${esc(t("Подключите первое приложение"))}</h3><p>${esc(t("Пара ключей даст вашему приложению доступ к объектам через совместимый S3 API."))}</p>${button(t("Создать ключ"),'new-key','primary','plus')}</div>`}</section>`;
  }
  function renderAudit(audit) {
    const size=Number(audit.pageSize||state.auditPageSize),page=Number(audit.page||state.auditPage),total=Number(audit.total||0),pages=Math.max(1,Number(audit.totalPages||1));
    const controls=`<div class="audit-controls"><label for="audit-page-size">${esc(t("На странице"))}</label><select id="audit-page-size" aria-label="${esc(t("Событий на странице"))}">${[10,25,50].map(value=>`<option value="${value}" ${value===size?'selected':''}>${value}</option>`).join('')}</select></div>`;
    if(audit.error)return controls+`<p class="form-error" role="alert">${esc(audit.error)}</p>${button(t("Повторить"),'audit-page','small','refresh',`data-page="${page}"`)}`;
    const list=audit.events?.length?`<ul class="audit-list">${audit.events.map(event=>`<li><span class="dot"></span><div><p><strong>${esc(event.action)}</strong></p><p class="muted">${esc(typeof event.detail==='object'?JSON.stringify(event.detail):event.detail||'')}</p><time>${date(event.at)}</time></div></li>`).join('')}</ul>`:`<p class="small-summary">${esc(t("Событий пока нет."))}</p>`;
    return controls+list+`<div class="audit-pagination"><span class="tiny muted" role="status">${total?number((page-1)*size+1)+'–'+number(Math.min(page*size,total))+t(" из ")+number(total):t("0 событий")}</span><div class="row">${button(t("Предыдущая страница"),'audit-page','small square','chevron',t("data-page=\"{p0}\" title=\"Предыдущая страница\" {p1}", {p0: Math.max(1,page-1), p1: page<=1?'disabled':''}))}<span class="tiny muted">${number(page)} / ${number(pages)}</span>${button(t("Следующая страница"),'audit-page','small square','chevron',t("data-page=\"{p0}\" title=\"Следующая страница\" {p1}", {p0: page+1, p1: page>=pages?'disabled':''}))}</div></div>`;
  }
  async function loadAuditPage(page=1) {
    const host=$('#audit-content');if(!host||host.dataset.pending==='true')return;
    host.dataset.pending='true';host.setAttribute('aria-busy','true');$$('button,select',host).forEach(control=>control.disabled=true);
    state.auditPage=Math.max(1,page);
    try{const result=await api(`/api/audit?page=${state.auditPage}&pageSize=${state.auditPageSize}`);if(host.isConnected){state.auditPage=Number(result.page);host.innerHTML=renderAudit(result);}}
    catch(error){if(host.isConnected)host.innerHTML=renderAudit({error:error.message});}
    finally{host.dataset.pending='false';host.removeAttribute('aria-busy');}
  }
  function renderSettings(settings, status, audit) {
    return heading(t("Настройки системы"),t("Ресурсы, безопасность аккаунта и журнал действий."),button(t("Обновить"),'refresh','','refresh')) +
      `<div class="settings-layout"><div class="stack"><section class="panel"><div class="panel-head"><div><h2>${esc(t("Ресурсы и производительность"))}</h2><p>${esc(t("Лимиты помогают удерживать нагрузку в пределах сервера"))}</p></div></div><form class="panel-body" id="settings-form"><div class="form-grid"><div class="field"><label for="cache-size">${esc(t("Лимит RAM-кэша, МиБ"))}</label><input id="cache-size" type="number" name="cacheMB" min="0" max="1024" step="1" value="${Math.round(Number(settings.cacheBytes || 0)/1048576)}" required><small>${esc(t("0 отключает кэш. Горячие объекты хранятся в памяти в пределах лимита."))}</small></div><div class="field"><label for="concurrency">${esc(t("Параллельные операции записи"))}</label><input id="concurrency" type="number" name="concurrency" min="1" max="64" step="1" value="${Number(settings.concurrency) || 4}" required><small>${esc(t("Более высокий лимит увеличивает нагрузку на диски, сеть и память."))}</small></div></div><div class="field full"><label for="scrub-interval">${esc(t("Автопроверка и восстановление, секунд"))}</label><input id="scrub-interval" type="number" name="scrubIntervalSeconds" min="0" max="86400" step="1" value="${Number(settings.scrubIntervalSeconds ?? 900)}" required><small>${esc(t("От 60 до 86400 секунд. 0 отключает автоматическую проверку. По умолчанию — каждые 15 минут."))}</small></div><div class="settings-item"><span>${esc(t("Максимальный размер объекта"))}</span><strong>${bytes(settings.maxObjectBytes)}</strong></div><div class="settings-item"><span>${esc(t("Лимит ожидающей очереди"))}</span><strong>${number(settings.queueLimit)}</strong></div><p class="tiny muted">${esc(t("Размер объекта и лимит очереди задаются при запуске контейнера."))}</p><div id="settings-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">${esc(t("Сохранить настройки"))}</button></div></form></section><section class="panel"><div class="panel-head"><h2>${esc(t("Пароль администратора"))}</h2></div><form class="panel-body" id="password-form"><div class="form-grid"><div class="field full"><label for="current-password">${esc(t("Текущий пароль"))}</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">${esc(t("Новый пароль"))}</label><input id="new-password" name="password" type="password" minlength="12" autocomplete="new-password" required><small>${esc(t("Минимум 12 символов."))}</small></div><div class="field"><label for="repeat-password">${esc(t("Повторите новый пароль"))}</label><input id="repeat-password" name="repeatPassword" type="password" minlength="12" autocomplete="new-password" required></div></div><div id="password-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button" type="submit">${esc(t("Обновить пароль"))}</button></div></form></section></div><div class="stack align-start"><section class="panel"><div class="panel-head"><h2>${esc(t("О системе"))}</h2></div><div class="panel-body"><div class="settings-item"><span>${esc(t("Версия"))}</span><strong>${esc(status.version || '0.3.1')}</strong></div><div class="settings-item"><span>${esc(t("Время работы"))}</span><strong>${duration(status.uptime)}</strong></div><div class="settings-item"><span>${esc(t("Защищённые cookie"))}</span><span class="badge ${status.security?.secureCookies ? 'success' : 'warn'}">${status.security?.secureCookies ? t("Включены") : t("Отключены")}</span></div><p class="tiny muted note-top">${esc(t("Для доступа через интернет используйте HTTPS и настройте secure cookie. Порты узлов оставляйте в закрытой сети."))}</p><a href="#wiki-security" class="small-summary">${esc(t("Руководство по безопасному запуску →"))}</a></div></section><section class="panel"><div class="panel-head"><div><h2>${esc(t("Журнал действий"))}</h2><p>${esc(t("События администратора"))}</p></div>${icon('clock')}</div><div class="panel-body" id="audit-content">${renderAudit(audit)}</div></section></div></div>`;
  }

  const wiki = [
    {id:'start',get title() { return t("Первый запуск"); },get tag() { return t("01 · Начало работы"); },get body() { return `<p>${esc(t("27G-StorageS3 — самостоятельное объектное хранилище с S3 API и управлением через браузер. Координатор хранит метаданные, проверяет доступ и распределяет объекты между узлами."))}</p><h3>${esc(t("Запуск через Docker Compose"))}</h3><pre><code>docker compose up -d --build
docker compose logs app</code></pre><p>${esc(t("Откройте"))} <code>__CONSOLE_ENDPOINT__</code>${esc(t(". Новая установка автоматически создаёт администратора: логин"))} <code>admin</code>${esc(t(", пароль"))} <code>admin!123</code>${esc(t(". В Docker и при сетевом запуске введите также"))} <code>Initial setup token</code> ${esc(t("из логов. Он требуется при каждом сетевом входе со стандартным паролем. При прямом запуске только на loopback без прокси и PUBLIC_ORIGIN достаточно логина и пароля. В «Настройках» можно задать уникальный пароль от 12 символов — после этого токен не нужен. Перезапуск не сбрасывает изменённый пароль. Логи и токен должны быть доступны только владельцу сервера."))}</p><ol><li>${esc(t("Откройте «Кластер» и выберите режим хранения."))}</li><li>${esc(t("Создайте бакет — пространство для объектов одного проекта."))}</li><li>${esc(t("Загрузите файлы из браузера или создайте ключ доступа для приложения."))}</li><li>${esc(t("Перед доступом через интернет настройте HTTPS, резервное копирование и ограничения сети."))}</li></ol><p>${esc(t("Изменения настроек и файлы должны сохраняться в постоянных Docker volumes. Остановка контейнера не должна означать удаление данных."))}</p>`; }},
    {id:'init',get title() { return t("Автоматическая инициализация"); },get tag() { return t("01 · Начало работы"); },get body() { return `<p>${esc(t("Параметры INIT_* применяются как начальная миграция: до открытия HTTP-порта создаются пользователи, S3-ключи и бакеты. Повторный запуск не меняет существующие учётные данные и настройки. Прерванная инициализация завершается при следующем запуске."))}</p><pre><code>INIT_BUCKET=app-files docker compose -f compose.yaml -f compose.init.yaml up -d --build</code></pre><p>${esc(t("Этот пример для новой установки создаёт администратора, случайный пароль, закрытый бакет app-files и пару S3-ключей. Результат хранится в /data/init-credentials.json с правами 0600; секреты не выводятся в журнал."))}</p><p>${esc(t("Для нескольких пользователей и бакетов задайте INIT_CONFIG_FILE с JSON-конфигурацией версии 1. Можно указать роли, язык, квоты, ограничения ключей и публичное чтение по префиксам. Пароли и секреты также можно передать через файлы. Списки файлов анонимным посетителям остаются недоступны."))}</p><p>${esc(t("Отдельный init-контейнер запускает node src/server.mjs --init-only на том же постоянном томе до запуска сервера. После первого запуска используйте обычный compose.yaml; перед повторным запуском init-контейнера остановите сервер. В HA начальную настройку выполняет первый master под защитой lease; slave загружает состояние кластера."))}</p><p>${esc(t("Примеры всех параметров и JSON находятся в docs/INITIALIZATION.md и docs/INITIALIZATION.ru.md. Дальнейшие изменения пользователей, ключей и бакетов выполняются через веб-панель."))}</p><h3>${esc(t("Бакеты командами в init-скрипте"))}</h3><p>${esc(t("В образе 0.3.4 и новее есть команда 27g. Она обращается к уже запущенному серверу через S3 API и не открывает каталог данных. Задайте S3_ENDPOINT и отдельную пару AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, либо их варианты _FILE. Пароль панели для этих команд не подходит."))}</p><pre><code>set -eu
27g create-bucket "my-bucket" --if-not-exists
27g create-bucket "my-bucket-2" --if-not-exists
27g create-bucket "my-bucket-3" --if-not-exists</code></pre><p>${esc(t("Флаг --if-not-exists (также --if-no-exists) пропускает уже существующий бакет, сохраняя его файлы, политику и квоты. Новые бакеты закрыты. Остальные ошибки останавливают скрипт с set -eu; ранее выполненные команды не откатываются."))}</p><p>${esc(t("В разделе «Ключи доступа» создайте отдельный ключ: разрешите только «Создание бакетов», выберите «Все существующие и будущие бакеты» и оставьте префиксы пустыми. Это разрешение создавать бакеты с любыми допустимыми именами; ограничить ключ точными будущими именами можно через INIT_CONFIG_FILE или API. Ключ от INIT_BUCKET ограничен одним бакетом."))}</p><p>${esc(t("Пример повторяемого init-контейнера находится в compose.buckets-init.yaml, три команды — в docs/examples/init-buckets.sh. Этот клиент запускается после сервера и не подключает его том. Подробности и секрет-файлы описаны в инструкции инициализации."))}</p>`; }},
    {id:'s3',get title() { return t("Подключение S3-клиента"); },get tag() { return t("02 · Интеграции"); },get body() { return `<p>${esc(t("Используйте endpoint координатора, подпись AWS Signature V4 и адресацию"))} <code>path-style</code>${esc(t(": имя бакета входит в путь URL. В разделе «Ключи доступа» создайте отдельную пару ключей для каждого приложения."))}</p><h3>Python · boto3</h3><pre><code>import os
import shutil
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ.get("S3_ENDPOINT", __S3_ENDPOINT_JSON__),
    region_name="us-east-1",
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "path", "payload_signing_enabled": True},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
    ),
)

s3.create_bucket(Bucket="my-backups")
with open("report.pdf", "rb") as file:
    s3.put_object(
        Bucket="my-backups",
        Key="reports/report.pdf",
        Body=file,
        ContentType="application/pdf",
    )
response = s3.get_object(Bucket="my-backups", Key="reports/report.pdf")
with response["Body"] as body, open("copy.pdf", "wb") as output:
    shutil.copyfileobj(body, output)</code></pre><h3>AWS CLI</h3><p>${esc(t("Передайте ключи через переменные окружения"))} <code>AWS_ACCESS_KEY_ID</code> ${esc(t("и"))} <code>AWS_SECRET_ACCESS_KEY</code>${esc(t(". Не вставляйте секреты в команды, которые попадут в историю оболочки. Создайте отдельный файл настроек без секретов:"))}</p><pre><code>cat &gt; s3-client.config &lt;&lt;'EOF'
[default]
region = us-east-1
request_checksum_calculation = when_required
response_checksum_validation = when_required
s3 =
    addressing_style = path
    payload_signing_enabled = true
EOF
export AWS_CONFIG_FILE="$PWD/s3-client.config"
export AWS_PROFILE=default
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export S3_ENDPOINT=__S3_ENDPOINT_SHELL__

aws --endpoint-url "$S3_ENDPOINT" s3api list-buckets
aws --endpoint-url "$S3_ENDPOINT" s3api put-object \\
  --bucket my-backups --key report.pdf --body report.pdf
aws --endpoint-url "$S3_ENDPOINT" s3api get-object \\
  --bucket my-backups --key report.pdf copy.pdf</code></pre><p>${esc(t("Примеры предполагают существующий файл"))} <code>report.pdf</code>${esc(t("; бакет"))} <code>my-backups</code> ${esc(t("создайте в панели либо Python-командой выше. На создание и загрузку нужен ключ с правами записи. Для удалённого сервера замените endpoint на HTTPS-адрес."))}</p><p>${esc(t("Используйте актуальные boto3/botocore с указанными checksum-параметрами. Значение"))} <code>when_required</code> ${esc(t("отключает необязательные автоматические checksum/trailers, а"))} <code>payload_signing_enabled</code> ${esc(t("включает подпись тела. Поддерживаются одиночный PUT и multipart: создание загрузки, части, просмотр, завершение и отмена. Клиенты должны использовать обычные подписанные запросы без AWS streaming signatures и checksum trailers; конкретную версию SDK проверяйте перед переносом данных."))}</p><h3>${esc(t("Границы совместимости"))}</h3><p>${esc(t("Доступны базовые операции с бакетами и объектами, список объектов, скачивание и удаление. Поддерживаются multipart и история до пяти версий содержимого с versionId: текущая и четыре предыдущие. Максимум одного объекта — 5 ГиБ, включая сумму multipart-частей; администратор может уменьшить лимит. Это не полная реализация AWS S3: CopyObject, пакетное удаление DeleteObjects, пользовательские x-amz-meta-*, AWS streaming signatures и trailers, ACL, политики AWS, object lock, lifecycle и события не поддерживаются. CORS задаётся глобально в панели; S3 bucket CORS API не реализован. Ограниченная история всегда включена и не равна неограниченному AWS versioning; точный контракт описан в docs/S3-COMPATIBILITY.md репозитория. Проверьте нужные операции вашего клиента перед переносом рабочих данных."))}</p>`; }},
    {id:'cluster',get title() { return t("Кластер и режимы хранения"); },get tag() { return t("03 · Архитектура"); },get body() { return `<p>${esc(t("Режимы работают на уровне целых объектов. Они повторяют логику распределения и зеркалирования RAID, но не создают блочное RAID-устройство сами по себе не обеспечивают отказоустойчивость каталога. Для координаторов доступен отдельный режим HA master/slave с тремя голосующими etcd."))}</p><div class="table-wrap"><table><thead><tr><th>${esc(t("Режим"))}</th><th>${esc(t("Расположение объектов"))}</th><th>${esc(t("Требования и риски"))}</th></tr></thead><tbody><tr><td><strong>RAID 0</strong></td><td>${esc(t("Один экземпляр на выбранном узле"))}</td><td>${esc(t("От 1 узла. Потеря узла означает потерю его объектов."))}</td></tr><tr><td><strong>RAID 1</strong></td><td>${esc(t("Каждый объект на всех узлах"))}</td><td>${esc(t("От 2 узлов. Полезная ёмкость ограничена наименьшим узлом."))}</td></tr><tr><td><strong>RAID 10</strong></td><td>${esc(t("Объект в одной зеркальной паре"))}</td><td>${esc(t("От 4 узлов, чётное количество. Потеря обоих узлов одной пары теряет её объекты."))}</td></tr></tbody></table></div><h3>${esc(t("Подключение узлов"))}</h3><pre><code>sh scripts/init-cluster.sh
docker compose --profile cluster up -d --build</code></pre><p>${esc(t("Комплект Compose запускает четыре узла:"))} <code>http://node1:9100</code> — <code>http://node4:9100</code>${esc(t(". Токен для них создаётся в файле"))} <code>secrets/node_token</code>${esc(t("; скопируйте его в форму подключения. Не публикуйте этот файл и не добавляйте его в Git."))}</p><p>${esc(t("Запустите дополнительные контейнеры узлов с постоянными дисками и секретными токенами. В панели «Кластер» добавьте ID, название, внутренний URL и токен каждого узла. Для встроенного диска координатора используется адрес"))} <code>local</code>${esc(t(". Пустой токен у уже подключённого узла сохраняет текущий токен."))}</p><p>${esc(t("В RAID 10 пары образуются по порядку: 1 + 2, 3 + 4 и так далее. Размещайте копии на разных физических дисках и серверах. Два контейнера на одном диске не защищают от отказа диска."))}</p><h3>${esc(t("Изменение заполненного кластера"))}</h3><p>${esc(t("Для изменения состава или режима заполненного хранилища подтвердите перенос данных в форме. Система копирует объекты на новые места, а затем переключает топологию. Чтение остаётся доступным; фиксация новых записей ждёт окончания переноса. Подготовьте свободное место для временного сосуществования копий и не останавливайте контейнеры во время операции."))}</p><p>${esc(t("Если перенос не удаётся, прежняя конфигурация остаётся активной. Удаление устаревших физических копий выполняется с задержкой. Проверьте доступность объектов после переноса, прежде чем отключать прежние серверы."))}</p><h3>${esc(t("Что происходит при отказе"))}</h3><p>${esc(t("Чтение зеркального объекта использует доступную исправную копию. Для записи нужны все требуемые реплики: недоступный узел приводит к ошибке записи, успешный ответ не означает сохранение только в памяти. При одиночном запуске координатор остаётся точкой отказа. HA требует отдельного развёртывания: два координатора, три голосующих etcd, общие HTTP-узлы с зеркальными копиями и общий секретный master.key. Переключение сбрасывает сессии панели; при отсутствии кворума запросы к данным прекращаются. Локальные диски координатора в HA не подходят."))}</p>`; }},
    {id:'uploads',get title() { return t("Загрузка, очередь и RAM-кэш"); },get tag() { return t("04 · Повседневная работа"); },get body() { return `<p>${esc(t("Откройте бакет и перетащите файлы в область загрузки. Панель выполняет до трёх загрузок одновременно и показывает очередь, прогресс и результат каждого файла. Файлы передаются частями по 8 МиБ. В разделе «Загрузки» можно приостановить задание; сохранённые части остаются на сервере. После перезагрузки выберите исходный файл повторно: панель проверит SHA-256 и передаст только отсутствующие части. Браузер хранит идентификатор задания и контрольные суммы без ключей доступа."))}</p><p>${esc(t("Имя файла становится ключом объекта. Значение фильтра по префиксу добавляется в начало ключа при загрузке. Например, префикс"))} <code>photos/</code> ${esc(t("и файл"))} <code>summer.jpg</code> ${esc(t("дадут ключ"))} <code>photos/summer.jpg</code>.</p><h3>${esc(t("Повторная запись и удаление"))}</h3><p>${esc(t("Запись с тем же ключом создаёт новую текущую версию. Хранятся до пяти версий содержимого, более старые вытесняются. Кнопка «История» позволяет скачать или восстановить сохранённую версию. Обычное удаление перемещает файл в корзину; администратор может удалить конкретную версию или все версии навсегда, введя подтверждение. Для удаления бакета необходимо очистить также историю, корзину и незавершённые загрузки. История не заменяет независимый backup."))}</p><h3>${esc(t("Очередь на сервере"))}</h3><p>${esc(t("Число одновременно выполняемых записей ограничено настройкой сервера. Когда очередь заполнена, запрос может завершиться ошибкой перегрузки: повторите его позже. Ограничение размера объекта задаётся при запуске."))}</p><h3>${esc(t("Кэш в оперативной памяти"))}</h3><p>${esc(t("RAM-кэш ускоряет повторные чтения, пока объект находится в кэше. Лимит памяти и параллелизм меняются в «Настройках». Кэш можно отключить значением 0. После перезапуска он пуст; постоянные данные должны находиться на дисках, а не в RAM."))}</p><p>${esc(t("Высокий параллелизм не гарантирует высокую скорость. Подбирайте значения по реальным дискам, сети и нагрузке. Опубликованных эталонных замеров производительности для этой версии нет."))}</p>`; }},
    {id:'sharing',get title() { return t("Как поделиться фото или файлом"); },get tag() { return t("05 · Временный доступ"); },get body() { return `<p>${esc(t("В разделе «Бакеты и объекты» откройте бакет и нажмите «Поделиться» у нужного файла. Укажите срок в днях и часах (от 1 часа до 7 дней), нажмите «Сгенерировать ссылку» и скопируйте адрес."))}</p><p>${esc(t("Получателю не нужны аккаунт, пароль и S3-ключи. Сама ссылка даёт временное право чтения, поэтому передавайте её только нужным людям. Адрес показывается при создании; позже можно создать новую ссылку. Все ещё действующие ссылки видны в том же окне, где их можно отозвать."))}</p><p>${esc(t("После окончания срока, отзыва, удаления или перезаписи файла ссылка перестаёт работать. Уже скачанную получателем копию отозвать нельзя. JPEG, PNG, GIF, WebP и AVIF с соответствующим типом содержимого открываются в браузере; остальные типы скачиваются."))}</p><p>${esc(t("Адрес"))} <code>127.0.0.1</code> ${esc(t("или"))} <code>localhost</code> ${esc(t("работает только на вашем компьютере. Для других устройств нужен доступный им адрес сервера; для публикации в интернете сначала настройте DNS, HTTPS и прокси согласно README, затем задайте публичный адрес в «Настройках». После его смены управление панелью требует нового адреса. CORS настраивается отдельно и не открывает приватные файлы. Временная ссылка — отдельный маршрут приложения; она не меняет политику бакета. Временные ссылки S3 SigV4 также поддерживаются независимо."))}</p>`; }},
    {id:'security',get title() { return t("Доступ и безопасность"); },get tag() { return t("06 · Защита данных"); },get body() { return `<p>${esc(t("Для публикации API и панели используйте обратный прокси с HTTPS. Включите защищённые cookie согласно конфигурации сервера. Обычный HTTP допустим только в доверенной локальной среде; пароли, S3-ключи и данные должны передаваться шифрованно."))}</p><ul><li>${esc(t("Не публикуйте порт узла"))} <code>9100</code> ${esc(t("в интернет. Доступ к узлам нужен только координатору в закрытой сети."))}</li><li>${esc(t("Используйте отдельные длинные случайные токены узлов. Ограничьте доступ к конфигурации, секретам, Docker и томам."))}</li><li>${esc(t("Создавайте отдельный S3-ключ для каждого приложения. Выберите только нужные операции, ограничьте бакеты и префиксы, задайте срок действия. Отключение владельца блокирует его ключи."))}</li><li>${esc(t("В «Пользователях» назначайте роли: наблюдатель — чтение, оператор — объекты и свои ключи, администратор — полное управление. Квоты пользователей и бакетов учитывают сохранённые версии и незавершённые части; пусто означает отсутствие лимита, 0 запрещает новые данные."))}</li><li>${esc(t("В «Настройках» подключите TOTP MFA. Секрет добавляется в приложение вручную; десять кодов восстановления показываются один раз и каждый работает один раз. Храните их отдельно от телефона."))}</li><li>${esc(t("Храните secret key в менеджере секретов. Если ключ раскрыт, сразу отзовите его и создайте новый."))}</li><li>${esc(t("Используйте длинный уникальный пароль администратора, своевременно обновляйте образ и контролируйте журнал действий."))}</li><li>${esc(t("Регулярно проверяйте восстановление резервной копии на отдельном сервере."))}</li></ul><p>${esc(t("Текущая версия содержит базовые механизмы защиты, но не является результатом независимого аудита и не обещает неуязвимость. Перед критичной эксплуатацией нужны проверка конфигурации, тестирование и внешний аудит."))}</p>`; }},
    {id:'recovery',get title() { return t("Проверка и резервные копии"); },get tag() { return t("07 · Восстановление"); },get body() { return `<h3>${esc(t("Проверка и восстановление копий"))}</h3><p>${esc(t("Автоматическая проверка и восстановление выполняются каждые 15 минут по умолчанию. Интервал меняется в «Настройках»; 0 отключает фоновую проверку."))}</p><p>${esc(t("В разделе «Кластер» кнопка «Проверить и восстановить» запускает сверку контрольных сумм. Когда исправная реплика доступна, система может восстановить отсутствующую или повреждённую копию. Результат показывает проверенные, восстановленные и проблемные объекты. Проверка большого хранилища занимает время и создаёт нагрузку на диски и сеть."))}</p><p>${esc(t("Если потеряны все копии объекта, проверка не сможет создать его заново. Для RAID 0 восстановление утраченного объекта возможно только из внешней резервной копии."))}</p><h3>${esc(t("Что включить в бэкап"))}</h3><p>${esc(t("Сохраняйте объекты узлов, базу метаданных SQLite координатора, его конфигурацию и секреты. Копия только объектных файлов не заменяет полное восстановление системы. Защитите бэкап секретов так же строго, как рабочие ключи."))}</p><p>${esc(t("В HA дополнительно сохраняйте снимок etcd и общие секреты; физическая сборка мусора в HA пока отключена, поэтому окончательное удаление метаданных не освобождает место автоматически. Для дискового агента сохраните его состояние и master.key. Для согласованной резервной копии остановите операции записи и используйте корректный способ копирования SQLite либо остановите сервис. Проверьте восстановление отдельно до того, как полагаться на бэкап."))}</p><h3>${esc(t("Зеркало не является резервной копией"))}</h3><p>${esc(t("Удаление и замена объекта затрагивают активное хранилище. Ошибка администратора, скомпрометированный ключ или потеря координатора требуют независимой резервной копии с собственной историей хранения."))}</p>`; }}
    ,{id:'operations',get title() { return t("Диагностика, диски и план изменений"); },get tag() { return t("08 · Обслуживание"); },get body() { return `<p>${esc(t("«Диагностика» показывает запросы, ошибки сервера, задержки, память, очередь, узлы и предупреждения. Пороги заполнения диска, очереди и p95 меняет администратор. Метрики сбрасываются при перезапуске; история в памяти не заменяет внешнюю систему мониторинга. Prometheus-экспорт защищён административной сессией."))}</p><h3>${esc(t("Подключение дисков из панели"))}</h3><p>${esc(t("В «Кластере» нажмите «Подключить сервер», укажите название и создайте одноразовую команду. Выполните её на Linux-сервере с установленным Docker; агент подключится автоматически. Команда действует 15 минут и содержит временный секрет, не публикуйте её. В дополнительных параметрах задаются адрес, порт, папка и разрешение монтировать диски/SMB/NFS. Без него агент работает с папками. Координатор и агент должны видеть друг друга по доверенной сети; установка Docker и открытие сетевых портов выполняются отдельно. Подробности — docs/DISKS.md. Для установленного вручную агента оставлено подключение по адресу и токену. Затем выберите существующую папку, раздел ext4/XFS/Btrfs, SMB 3.1.1 или NFS. Форматирование не выполняется. Путь относится к серверу агента; SMB-пароль хранится агентом зашифрованно."))}</p><p>${esc(t("Подключённый ресурс добавляется в форму узлов. До сохранения топологии данные на него не переносятся. Для временно недоступного ресурса восстановите сеть или диск и нажмите «Проверить / подключить». Две папки одного диска или два сетевых ресурса одного NAS не создают независимые копии."))}</p><h3>${esc(t("План смены топологии"))}</h3><p>${esc(t("Перед применением панель показывает число узлов, известную полезную ёмкость, объём переноса и предупреждения. Неизвестную ёмкость проверьте на сервере. Подтвердите запас места и независимость копий. Перенос может быть длительным; после ошибки старый состав остаётся активным."))}</p><h3>HA master/slave</h3><p>${esc(t("Для запуска используйте отдельную инструкцию docs/HA.md и compose.ha.yaml. Роль master означает предпочтение участия в выборе лидера, а право записи даёт действующий lease кворума. Кнопка назначения роли может прервать соединения. Все контейнеры на одном сервере защищают только от отдельных отказов процессов; для отказа сервера нужны независимые физические хосты. Полные зашифрованные снимки каталога ограничивают масштаб первой реализации HA."))}</p>`; }}
    ,{id:'preview-access',get title() { return t("Предпросмотр и доступ к файлам"); },get tag() { return t("09 · Объекты и политики"); },get body() { return `<h3>${esc(t("Просмотр без скачивания"))}</h3><p>${esc(t("Нажмите имя файла в таблице. Панель показывает поддерживаемые растровые изображения до 20 МиБ и начало текстового файла до 1 МиБ. JSON, исходный код и другие текстовые форматы отображаются как текст; код не исполняется. Для других типов доступна информация о файле и скачивание. В меню «…» находятся история, ссылки и корзина; сохранённую версию также можно просмотреть из истории."))}</p><h3>${esc(t("Закрытый и открытый бакет"))}</h3><p>${esc(t("По умолчанию бакет закрыт: доступ получают авторизованные пользователи, разрешённые S3-ключи или получатели временной ссылки. Администратор может открыть «Доступ» в бакете и включить чтение по полному пути без входа. Список файлов, запись, удаление и история версий остаются недоступны анонимным посетителям."))}</p><p>${esc(t("Укажите префиксы, например"))} <code>photos/</code> ${esc(t("и"))} <code>public/</code>${esc(t(", если открыты должны быть только отдельные группы файлов. Пустой список префиксов в открытом режиме разрешает все текущие объекты. Любой, кто получит или угадает подходящий путь, сможет прочитать файл; закрытый список не заменяет авторизацию для конфиденциальных данных."))}</p><p>${esc(t("В меню файла выберите «Постоянная ссылка», чтобы скопировать URL с настроенным публичным адресом. Она показывает текущий файл по этому пути и действует, пока это разрешает политика. Возврат бакета в закрытый режим прекращает анонимный доступ, но не отзывает отдельно созданные временные ссылки: ими управляйте через «Поделиться»."))}</p><h3>${esc(t("Ключ для чтения без списка"))}</h3><p>${esc(t("Для приложения можно оставить разрешение «Чтение файлов» и снять «Просмотр списка». Такой S3-ключ читает известные пути в разрешённых бакетах и префиксах, но не перечисляет их содержимое. Политика панели не является полной реализацией AWS bucket policies или IAM."))}</p>`; }}
  ];
  function renderWiki(query = '') {
    const list = wiki.filter(w => `${w.title} ${w.body.replace(/<[^>]*>/g,' ')}`.toLocaleLowerCase(locale()).includes(query.toLocaleLowerCase(locale())));
    return `${heading(t("Документация"),t("От первого бакета до кластера: всё необходимое в одном месте."), '', t("Встроенная wiki"))}<div class="search-wrap wiki-search">${icon('search')}<input class="search-input" id="wiki-search" type="search" value="${esc(query)}" placeholder="${esc(t("Найти в документации: подключение, RAID, резервные копии…"))}" aria-label="${esc(t("Поиск в документации"))}"></div><div id="wiki-results">${wikiResults(list)}</div>`;
  }
  function wikiBody(article) {
    const endpoint=state.status?.endpoint||location.origin;
    const shellValue="'"+endpoint.replaceAll("'", "'\\''")+"'";
    return article.body.replaceAll('__CONSOLE_ENDPOINT__',esc(endpoint+'/console/')).replaceAll('__S3_ENDPOINT_JSON__',esc(JSON.stringify(endpoint))).replaceAll('__S3_ENDPOINT_SHELL__',esc(shellValue));
  }
  function wikiResults(list) { return list.length ? `<div class="wiki-layout"><nav class="wiki-nav" aria-label="${esc(t("Разделы документации"))}">${list.map(w => `<a href="#wiki-${w.id}">${esc(w.title)}</a>`).join('')}</nav><div class="stack">${list.map(w => `<article class="panel wiki-article" id="wiki-${w.id}"><div class="wiki-tag">${esc(w.tag)}</div><h2>${esc(w.title)}</h2>${wikiBody(w)}</article>`).join('')}</div></div>` : `<div class="empty">${icon('search')}<h3>${esc(t("Ничего не найдено"))}</h3><p>${esc(t("Попробуйте другое слово: бакеты, ключи, загрузка или восстановление."))}</p></div>`; }

  function renderAuth(error = '') {
    ++state.renderID;
    $('#app').innerHTML = `<main class="auth" id="main"><section class="auth-story"><div class="brand">${brand()}</div><div class="auth-story-main"><div class="eyebrow">${esc(t("Простое управление. Своя инфраструктура."))}</div><h1>${esc(t("Ваши данные."))}<br>${esc(t("Ваши серверы."))}<br><em>${esc(t("Одно хранилище."))}</em></h1><p>${esc(t("Соберите диски в общее пространство, подключите приложения по S3 и управляйте всем из браузера."))}</p><div class="auth-art"><div class="node-tile">${icon('server')}<strong>${esc(t("Хранение"))}</strong><small>${esc(t("Собственные узлы"))}</small></div><span class="cluster-separator">+</span><div class="node-tile">${icon('shield')}<strong>${esc(t("Репликация"))}</strong><small>${esc(t("Копии объектов"))}</small></div><span class="cluster-separator">=</span><div class="node-tile">${icon('layers')}<strong>${esc(t("Один S3"))}</strong><small>${esc(t("Единый endpoint"))}</small></div></div></div><div class="auth-story-foot">${esc(t("27G-StorageS3 · Самостоятельное объектное хранилище"))}</div></section><section class="auth-content"><div class="auth-card"><span class="brand-mark" aria-hidden="true"><img src="/console/brand-mark.png" alt="" width="48" height="48"></span><div class="eyebrow">${esc(t("Панель управления"))}</div><h2>${state.defaultCredentials ? t("Добро пожаловать") : t("С возвращением")}</h2><p>${esc(t("Войдите, чтобы управлять объектами, узлами и доступом."))}</p>${state.defaultCredentials ? '<div class="notice">'+icon('key')+`<div>${esc(t("Начальный вход:"))} <strong>admin</strong> / <code>admin!123</code>${esc(t(". Пароль можно изменить в настройках."))}</div></div>` : ''}<form id="auth-form"><div class="field"><label for="username">${esc(t("Имя пользователя"))}</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="80" value="${state.defaultCredentials ? 'admin' : ''}" required autofocus></div><div class="field"><label for="password">${esc(t("Пароль"))}</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>${state.setupTokenRequired ? `<div class="field"><label for="setup-token">${esc(t("Токен первоначального доступа"))}</label><input id="setup-token" name="setupToken" type="password" autocomplete="off" required><small>${esc(t("Для сетевого входа со стандартным паролем нужен"))} <code>Initial setup token</code> ${esc(t("из"))} <code>docker compose logs app</code>${esc(t(". После смены пароля токен не требуется."))}</small></div>` : ''}<div id="auth-error" class="form-error" role="alert">${esc(error)}</div><button type="submit" class="button primary">${esc(t("Войти в панель"))}${icon('arrow')}</button></form><p class="auth-footer">${location.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(location.hostname) ? t("Подключение использует HTTP. Для удалённого доступа настройте HTTPS перед вводом секретов.") : t("Войдите в свою учётную запись панели. Ключи S3 создаются отдельно для каждого приложения.")}</p></div></section></main>`;
  }
  function route() {
    if (!state.user) return;
    const hash = location.hash.slice(1) || 'overview';
    const [name,query] = hash.split('?');
    const params = new URLSearchParams(query);
    const page = name.startsWith('wiki-') ? 'wiki' : name;
    state.page = ['overview','buckets','objects','cluster','keys','wiki','settings','users','uploads','monitoring'].includes(page) ? page : 'overview';
    state.bucket = params.get('bucket') || '';
    state.prefix = params.get('prefix') || '';
    state.menu = false;
    loadPage(name.startsWith('wiki-') ? name : undefined, params.get('continuationToken'));
  }
  async function loadPage(anchor, continuationToken) {
    const id = ++state.renderID;
    shell();
    try {
      let html;
      if (features?.hasPage(state.page)) html = await features.page(state.page);
      else if (state.page === 'wiki') { state.status = await api('/api/status'); if (id !== state.renderID) return; html = renderWiki(); }
      else if (state.page === 'overview') {
        const [s,b] = await Promise.all([api('/api/status'),api('/api/buckets')]);
        if (id !== state.renderID) return;
        state.status = s; state.data = b.buckets || []; html = renderOverview(s,state.data);
      } else if (state.page === 'buckets') {
        const result = await api('/api/buckets'); if (id !== state.renderID) return;
        state.data = result.buckets || []; html = renderBuckets(state.data);
      } else if (state.page === 'objects') {
        if (!state.bucket) {location.hash = '#buckets';return;}
        const result = await api(`/api/objects?${new URLSearchParams({bucket:state.bucket,prefix:state.prefix,...(continuationToken ? {continuationToken} : {})})}`);
        if (id !== state.renderID) return;
        state.data = result; html = renderObjects(result);
      } else if (state.page === 'cluster') {
        const [t,s] = await Promise.all([api('/api/topology'),api('/api/status')]);
        if (id !== state.renderID) return;
        state.status = s; html = renderCluster(t,s);
      } else if (state.page === 'keys') {
        const result = await api('/api/keys'); if (id !== state.renderID) return;
        state.data = result.keys || []; html = renderKeys(state.data);
      } else if (state.page === 'settings') {
        const [settings,s,audit] = await Promise.all([api('/api/settings'),api('/api/status'),api(`/api/audit?page=${state.auditPage}&pageSize=${state.auditPageSize}`).catch(error => ({error:error.message}))]);
        if (id !== state.renderID) return;
        state.status = s; html = renderSettings(settings,s,audit);
      }
      if (id !== state.renderID) return;
      $('#main').innerHTML = (state.defaultCredentials && state.role === 'admin' ? `<div class="notice warn">${icon('key')}<div>${esc(t("Используется начальный пароль администратора."))} <a href="#settings">${esc(t("Изменить пароль в настройках"))}</a>.</div></div>` : '') + html;
      $('#system-health').innerHTML = health();
      $('#sidebar-version').textContent = 'v' + (state.status?.version || '0.3.2');
      if (state.page === 'objects') bindDropzone();
      await features?.afterRender(state.page);
      if (anchor) document.getElementById(anchor)?.scrollIntoView({block:'start'});
    } catch (error) { if (id === state.renderID && $('#main')) $('#main').innerHTML = errorBlock(error); }
  }

  function openDialog(title, content, onSubmit) {
    const dialog = $('#dialog');
    dialog.dispatchEvent(new Event('dialog-replace'));
    dialog.className = '';
    dialog.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="${esc(t("Закрыть окно"))}">${icon('x')}</button></div><div class="dialog-body">${content}</div>`;
    dialog.showModal();
    if (onSubmit) $('form',dialog)?.addEventListener('submit',onSubmit);
    setTimeout(() => $('input:not([type=hidden]),select,button', $('.dialog-body',dialog))?.focus(),30);
  }
  function confirmAction(title, description, label, action) {
    openDialog(title,`<p>${esc(description)}</p><form><div class="form-error" role="alert"></div><div class="form-actions">${button(t("Отмена"),'close-dialog')}<button class="button danger" type="submit">${esc(label)}</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form, $('.form-error',form), async () => {await action();$('#dialog').close();});
    });
  }
  async function submit(form, errorElement, action) {
    if (form.dataset.pending === 'true') return;
    form.dataset.pending = 'true'; errorElement.textContent = '';
    const buttons = $$('button[type=submit]',form); const originals = buttons.map(b => b.innerHTML);
    buttons.forEach(b => {b.disabled = true;b.textContent = t("Выполняется…");});
    try { await action(); } catch (error) { errorElement.textContent = error.message; }
    finally {form.dataset.pending = 'false';buttons.forEach((b,i) => {b.disabled = false;b.innerHTML = originals[i];});}
  }
  function newBucket() {
    openDialog(t("Создать бакет"),`<p>${esc(t("Выберите уникальное имя. Бакет будет доступен авторизованным пользователям панели и разрешённым S3-ключам."))}</p><form><div class="field"><label for="bucket-name">${esc(t("Имя бакета"))}</label><input id="bucket-name" name="name" required minlength="3" maxlength="63" pattern="[a-z0-9][a-z0-9.-]*[a-z0-9]" placeholder="project-backups" autocomplete="off"><small>${esc(t("От 3 до 63 символов: строчные латинские буквы, цифры, точки и дефисы."))}</small></div><div class="form-error" role="alert"></div><div class="form-actions">${button(t("Отмена"),'close-dialog')}<button type="submit" class="button primary">${esc(t("Создать бакет"))}</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form,$('.form-error',form),async () => {const name = new FormData(form).get('name').trim(); await api('/api/buckets',{method:'POST',body:{name}}); $('#dialog').close();toast(t("Бакет {p0} создан", {p0: name}));location.hash = '#objects?bucket='+encodeURIComponent(name);});
    });
  }
  function shareList(shares) {
    return shares.length ? `<ul class="share-list">${shares.map(item => `<li data-share-id="${esc(item.id)}"><div><strong>${esc(t("До"))} ${date(item.expiresAt)}</strong><small>${esc(t("Создана"))} ${date(item.createdAt)}</small></div>${button(t("Отозвать"),'revoke-share','small danger','x',`data-id="${esc(item.id)}"`)}</li>`).join('')}</ul>` : `<p class="small-summary">${esc(t("Активных ссылок нет."))}</p>`;
  }
  async function shareObject(key) {
    const bucket = state.bucket;
    const query = new URLSearchParams({bucket,key});
    const {shares=[]} = await api('/api/shares?'+query);
    openDialog(t("Поделиться файлом"),`<div class="share-object-name">${icon('file')}<strong>${esc(key)}</strong></div><p>${esc(t("Каждый, у кого есть ссылка, сможет открыть этот файл без входа до конца выбранного срока."))}</p><form id="share-form"><fieldset class="share-duration"><legend>${esc(t("На сколько времени открыть доступ?"))}</legend><div class="form-grid"><div class="field"><label for="share-days">${esc(t("Дни"))}</label><input id="share-days" name="days" type="number" min="0" max="7" step="1" value="0" required></div><div class="field"><label for="share-hours">${esc(t("Часы"))}</label><input id="share-hours" name="hours" type="number" min="0" max="23" step="1" value="1" required></div></div><p class="tiny muted">${esc(t("От 1 часа до 7 дней. Например: 1 день и 6 часов."))}</p></fieldset><div class="form-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">${icon('link')}${esc(t("Сгенерировать ссылку"))}</button></div></form><div id="share-result" aria-live="polite"></div><section class="section-gap"><h3>${esc(t("Активные ссылки"))}</h3><div id="share-list">${shareList(shares)}</div><p class="tiny muted">${esc(t("Ссылку можно отозвать раньше срока. Перезапись или удаление файла также прекращает её действие."))}</p></section>`,async event => {
      event.preventDefault(); const form = event.target;
      const resultBox = $('#share-result'), listBox = $('#share-list');
      await submit(form,$('.form-error',form),async () => {
        const values = new FormData(form), days = Number(values.get('days')), hours = Number(values.get('hours'));
        const expiresIn = (days*24+hours)*3600;
        if (!Number.isInteger(days) || !Number.isInteger(hours) || days<0 || days>7 || hours<0 || hours>23 || expiresIn<3600 || expiresIn>604800) throw new Error(t("Укажите срок от 1 часа до 7 дней."));
        const result = await api('/api/shares',{method:'POST',body:{bucket,key,expiresIn}});
        if (!form.isConnected) return;
        const hostname = new URL(result.url).hostname;
        const local = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
        resultBox.dataset.shareId = result.id;
        resultBox.innerHTML = `<div class="notice section-gap">${icon('check')}<div><strong>${esc(t("Ссылка готова"))}</strong><p>${esc(t("Действует до"))} ${date(result.expiresAt)}.</p></div></div><div class="field section-gap"><label for="share-url">${esc(t("Ссылка на файл"))}</label><input id="share-url" type="text" readonly value="${esc(result.url)}" autocomplete="off" spellcheck="false"><small>${esc(t("Скопируйте сейчас: после закрытия окна адрес повторно не показывается."))}</small></div><div class="row wrap section-gap">${button(t("Скопировать ссылку"),'copy','primary','copy',`data-copy="${esc(result.url)}"`)}<a class="button" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">${esc(t("Открыть файл"))} ${icon('arrow')}</a></div>${local ? `<p class="share-local-note">${esc(t("Этот адрес открывается только на данном компьютере. Для обмена между устройствами настройте доступный адрес сервера."))}</p>` : ''}`;
        const updated = await api('/api/shares?'+query);
        if (listBox.isConnected) listBox.innerHTML = shareList(updated.shares || []);
      });
    });
  }
  async function newKey() {
    const {buckets=[]} = await api('/api/buckets');
    openDialog(t("Создать ключ доступа"),`<p>${esc(t("Дайте приложению только необходимые разрешения."))}</p><form><div class="stack"><div class="field"><label for="key-label">${esc(t("Название приложения"))}</label><input id="key-label" name="label" required maxlength="100" placeholder="${esc(t("Сервис резервного копирования"))}"></div><div class="field"><label for="key-role">${esc(t("Разрешения"))}</label><select name="role" id="key-role"><option value="readonly">${esc(t("Только чтение"))}</option><option value="readwrite">${esc(t("Чтение и запись"))}</option></select></div><div class="field"><span class="field-label">${esc(t("Доступные бакеты"))}</span><label class="check-label"><input type="checkbox" id="all-buckets" name="allBuckets" checked>${esc(t("Все существующие и будущие бакеты"))}</label><div id="key-bucket-list" class="stack hidden">${buckets.length ? buckets.map(b => `<label class="check-label"><input type="checkbox" name="buckets" value="${esc(b.name)}">${esc(b.name)}</label>`).join('') : `<small>${esc(t("Сначала создайте бакет или разрешите все бакеты."))}</small>`}</div></div></div><div class="form-error" role="alert"></div><div class="form-actions">${button(t("Отмена"),'close-dialog')}<button type="submit" class="button primary">${esc(t("Создать ключ"))}</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form,$('.form-error',form),async () => {
        const fd = new FormData(form), all = fd.get('allBuckets') === 'on', selected = fd.getAll('buckets'), label = String(fd.get('label') || '').trim();
        if (!label) throw new Error(t("Укажите название приложения: оно не может состоять только из пробелов."));
        if (!all && !selected.length) throw new Error(t("Выберите хотя бы один бакет или разрешите все бакеты."));
        const result = await api('/api/keys',{method:'POST',body:{label,role:fd.get('role'),buckets:all ? [] : selected}});
        $('#dialog').close();
        openDialog(t("Ключ доступа создан"),`<div class="notice warn">${icon('key')}<div>${esc(t("Сохраните secret key сейчас. После закрытия окна его нельзя будет посмотреть повторно."))}</div></div><div class="stack section-gap"><div class="field"><label>Access key</label><div class="secret-value">${esc(result.accessKey)}</div>${button(t("Скопировать"),'copy','small','copy',`data-copy="${esc(result.accessKey)}"`)}</div><div class="field"><label>Secret key</label><div class="secret-value">${esc(result.secretKey)}</div>${button(t("Скопировать секрет"),'copy','small','copy',`data-copy="${esc(result.secretKey)}"`)}</div></div><div class="form-actions">${button(t("Я сохранил ключ"),'close-dialog','primary','check')}</div>`);
        if (state.page === 'keys') loadPage();
      });
    });
  }

  function enqueueFiles(files) {
    if (features) return features.enqueueFiles(files).catch(error=>toast(error.message,true));
    if (!state.user || !state.bucket) return;
    const available = Math.max(0,100 - state.uploads.filter(u => ['queued','uploading'].includes(u.status)).length);
    const selected = [...files].slice(0,available);
    if (selected.length < files.length) toast(t("В очереди может быть до 100 файлов. Добавьте остальные после завершения загрузок."),true);
    if (!selected.length) return;
    const bucket = state.bucket, prefix = state.prefix;
    const append = () => {
      state.uploads = state.uploads.filter(u => ['queued','uploading'].includes(u.status)).concat(selected.map(file => ({id:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),file,bucket,key:prefix+file.name,status:'queued',progress:0,error:'',xhr:null})));
      renderQueue();pumpUploads();
    };
    const names = new Set(selected.map(f => prefix+f.name));
    const existing = (state.data?.objects || []).some(o => names.has(o.key));
    if (existing) confirmAction(t("Заменить существующие объекты?"),t("Среди выбранных файлов есть имена, которые уже встречаются на открытой странице. Объекты с тем же ключом будут заменены без сохранения старой версии."),t("Загрузить и заменить"),async () => append());
    else append();
  }
  function pumpUploads() {
    if (!state.user) return;
    const active = state.uploads.filter(u => u.status === 'uploading').length;
    state.uploads.filter(u => u.status === 'queued').slice(0,Math.max(0,state.uploadConcurrency-active)).forEach(startUpload);
  }
  function startUpload(item) {
    item.status = 'uploading';const xhr = new XMLHttpRequest();item.xhr=xhr;
    xhr.open('PUT',`/api/object?${new URLSearchParams({bucket:item.bucket,key:item.key})}`);
    xhr.setRequestHeader('Content-Type',item.file.type || 'application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',state.csrf || '');
    xhr.upload.onprogress = event => {if(event.lengthComputable){item.progress=Math.round(event.loaded/event.total*100);renderQueue();}};
    xhr.onload = () => {
      item.status = xhr.status >= 200 && xhr.status < 300 ? 'done' : 'error';
      if (item.status === 'error') { try { const r=JSON.parse(xhr.responseText);item.error=serverText(typeof r.error==='string'?r.error:r.error?.message||r.message||t("Ошибка {p0}", {p0: xhr.status})); } catch {item.error=t("Ошибка {p0}", {p0: xhr.status});} }
      completeUpload(item);
    };
    xhr.onerror = () => {item.status='error';item.error=t("Соединение прервано");completeUpload(item);};
    xhr.onabort = () => {item.status='cancelled';completeUpload(item);};
    xhr.send(item.file);renderQueue();
  }
  function completeUpload(item) {
    item.xhr=null;item.file=null;renderQueue();pumpUploads();
    if (!state.uploads.some(u => ['queued','uploading'].includes(u.status)) && state.user && state.page === 'objects' && state.bucket === item.bucket) loadPage();
  }
  function stopUploads() {if(features)return features.pauseAll();state.uploads.forEach(u=>{if(u.status==='queued'){u.status='cancelled';u.file=null;}});state.uploads.forEach(u=>{if(u.xhr)u.xhr.abort();});renderQueue();}
  function renderQueue() {
    if (features) return features.renderQueue();
    const container = $('#upload-container');if(!container)return;
    if(!state.uploads.length){container.innerHTML='';return;}
    const active=state.uploads.filter(u=>['queued','uploading'].includes(u.status)).length;
    const done=state.uploads.filter(u=>u.status==='done').length;
    container.innerHTML=`<section class="queue-drawer" aria-label="${esc(t("Очередь загрузки"))}"><div class="queue-head"><strong>${active ? t("Загрузка файлов · осталось {p0}", {p0: active}) : t("Загрузка завершена · {p0} из {p1}", {p0: done, p1: state.uploads.length})}</strong>${button(active?t("Отменить"):t("Закрыть"),active?'cancel-uploads':'close-uploads','small ghost',active?'x':'check')}</div><div class="queue-list">${state.uploads.map(u=>`<div class="queue-item"><div class="row between"><span class="queue-item-name" title="${esc(u.bucket+'/'+u.key)}">${esc(u.key)}</span><span class="queue-item-status${u.status==='error'?' error':''}">${u.status==='queued'?t("В очереди"):u.status==='uploading'?(u.progress===100?t("Сохраняем…"):u.progress+'%'):u.status==='done'?t("Готово"):u.status==='cancelled'?t("Отменено"):t("Ошибка")}</span></div>${u.status==='uploading'?`<progress max="100" value="${u.progress}" aria-label="${esc(t("Загрузка"))} ${esc(u.key)}"></progress>`:''}${u.error?`<p class="queue-item-status error">${esc(u.error)}</p>`:''}</div>`).join('')}</div></section>`;
  }
  function bindDropzone() {
    const zone=$('#dropzone'); if(!zone)return;
    for(const event of ['dragenter','dragover'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.add('dragover');});
    for(const event of ['dragleave','drop'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.remove('dragover');});
    zone.addEventListener('drop',event=>{const list=[...event.dataTransfer.files];if(list.length)enqueueFiles(list);});
    $('#upload-files').addEventListener('change',event=>{enqueueFiles(event.target.files);event.target.value='';});
  }

  document.addEventListener('click',async event => {
    const target=event.target.closest('[data-action]');if(!target)return;
    const action=target.dataset.action;
    try {
      if (features && await features.click(action,target)) return;
      if(action==='menu'||action==='menu-close'){state.menu=action==='menu'?!state.menu:false;$('.shell')?.classList.toggle('menu-open',state.menu);$('.mobile-toggle')?.setAttribute('aria-expanded',String(state.menu));}
      else if(action==='refresh')loadPage();
      else if(action==='audit-page')await loadAuditPage(Number(target.dataset.page));
      else if(action==='close-dialog')$('#dialog').close();
      else if(action==='copy'){if(!navigator.clipboard?.writeText)throw new Error(t("Буфер обмена недоступен. Выделите и скопируйте значение вручную или откройте панель через HTTPS."));await navigator.clipboard.writeText(target.dataset.copy);toast(t("Скопировано в буфер обмена"));}
      else if(action==='new-bucket')newBucket();
      else if(action==='delete-bucket')confirmAction(t("Удалить бакет?"),t("Бакет «{p0}» будет удалён. Удалить можно только пустой бакет.", {p0: target.dataset.bucket}), t("Удалить бакет"),async()=>{await api('/api/buckets/'+encodeURIComponent(target.dataset.bucket),{method:'DELETE'});toast(t("Бакет удалён"));loadPage();});
      else if(action==='delete-object'){const bucket=state.bucket,key=target.dataset.key;confirmAction(t("Удалить объект?"),t("Объект «{p0}» будет удалён без возможности восстановления из панели. Это действие затрагивает все его реплики.", {p0: key}), t("Удалить объект"),async()=>{await api('/api/object?'+new URLSearchParams({bucket,key}),{method:'DELETE'});toast(t("Объект удалён"));loadPage();});}
      else if(action==='share-object')await shareObject(target.dataset.key);
      else if(action==='revoke-share'){
        target.disabled=true;
        try{
          await api('/api/shares/'+encodeURIComponent(target.dataset.id),{method:'DELETE'});
          const list=target.closest('#share-list');target.closest('[data-share-id]')?.remove();
          if(list&&!list.querySelector('[data-share-id]'))list.innerHTML=shareList([]);
          const result=$('#share-result');if(result?.dataset.shareId===target.dataset.id){result.innerHTML=`<div class="notice section-gap" role="status">${esc(t("Ссылка отозвана и больше не открывается."))}</div>`;delete result.dataset.shareId;}
          toast(t("Ссылка отозвана"));
        }finally{target.disabled=false;}
      }
      else if(action==='choose-files')$('#upload-files')?.click();
      else if(action==='next-objects')location.hash='#objects?'+new URLSearchParams({bucket:state.bucket,prefix:state.prefix,continuationToken:target.dataset.token});
      else if(action==='add-node'){const list=$('#nodes-form');list.insertAdjacentHTML('beforeend',nodeFields({id:'node-'+(Date.now().toString(36)),label:t("Новый узел"),url:''},Date.now()));$('input',list.lastElementChild)?.focus();}
      else if(action==='remove-node'){if($$('[data-node]').length<=1)throw new Error(t("В конфигурации нужен хотя бы один узел."));target.closest('[data-node]').remove();}
      else if(action==='new-key')await newKey();
      else if(action==='revoke-key')confirmAction(t("Отозвать ключ доступа?"),t("Приложение «{p0}» сразу потеряет доступ по этому ключу. Восстановить отозванный ключ нельзя.", {p0: target.dataset.label}), t("Отозвать ключ"),async()=>{await api('/api/keys/'+encodeURIComponent(target.dataset.id),{method:'DELETE'});toast(t("Ключ отозван"));loadPage();});
      else if(action==='scrub'){
        target.disabled=true;const original=target.innerHTML;target.textContent=t("Проверка выполняется…");
        try{const r=await api('/api/scrub',{method:'POST',body:{}});const failed=Number(r.unrecoverable||0)+Number(r.repairFailed||0)+Number(r.failed||0)+Number(r.garbage?.failed||0);const result=$('#scrub-result');if(result)result.innerHTML=`<div class="notice ${failed?'warn':''} section-gap" role="status">${icon('shield')}<div><strong>${esc(t("Проверка завершена"))}</strong><p>${esc(t("Проверено:"))} ${number(r.checked)} ${esc(t("· Восстановлено:"))} ${number(r.repaired)} ${esc(t("· Ошибок:"))} ${number(failed)}${r.garbage?t(" · Удалено устаревших копий: {p0}", {p0: number(r.garbage.removed)}):''}</p>${failed?`<p>${esc(t("Не все объекты удалось восстановить. Проверьте доступность узлов и внешние резервные копии."))}</p>`:''}</div></div>`;toast(failed?t("Проверка завершена с ошибками"):t("Проверка завершена"),Boolean(failed));}finally{target.disabled=false;target.innerHTML=original;}
      }
      else if(action==='cancel-uploads')stopUploads();
      else if(action==='close-uploads'){state.uploads=[];renderQueue();}
      else if(action==='logout'){
        const leave=async()=>{await api('/api/logout',{method:'POST',body:{}});state.user=null;state.csrf=null;stopUploads();state.uploads=[];await init();};
        if(state.uploads.some(u=>['queued','uploading'].includes(u.status)))confirmAction(t("Выйти и остановить загрузки?"),t("В очереди есть незавершённые загрузки. Выход остановит их. Уже сохранённые объекты останутся в хранилище."),t("Выйти"),leave);else await leave();
      }
    }catch(error){toast(error.message,true);}
  });
  document.addEventListener('invalid', event => {
    const field=event.target, validity=field.validity;
    if(!validity || typeof field.setCustomValidity !== 'function') return;
    let message='';
    if(validity.valueMissing) message=field.type==='checkbox' ? t('Подтвердите этот выбор.') : t('Заполните это поле.');
    else if(validity.typeMismatch || validity.patternMismatch) message=t('Проверьте формат значения.');
    else if(validity.tooShort) message=t('Введите не менее {p0} символов.', {p0:number(field.minLength)});
    else if(validity.tooLong) message=t('Введите не более {p0} символов.', {p0:number(field.maxLength)});
    else if(validity.rangeUnderflow) message=t('Введите значение не меньше {p0}.', {p0:number(field.min)});
    else if(validity.rangeOverflow) message=t('Введите значение не больше {p0}.', {p0:number(field.max)});
    else if(validity.stepMismatch || validity.badInput) message=t('Введите допустимое число.');
    if(message){field.setCustomValidity(message);field.dataset.localizedValidation='true';}
  }, true);
  document.addEventListener('input',event=>{
    if(event.target.dataset?.localizedValidation){event.target.setCustomValidity('');delete event.target.dataset.localizedValidation;}
    if(event.target.id==='overview-bucket-search'){const query=event.target.value.toLowerCase();const matches=state.data.filter(b=>b.name.toLowerCase().includes(query));$('#overview-bucket-results').innerHTML=matches.length?bucketTable(matches.slice(0,5),true):`<div class="empty"><h3>${esc(t("Бакеты не найдены"))}</h3><p>${esc(t("Попробуйте другое название."))}</p></div>`;}
    if(event.target.id==='bucket-search'){const query=event.target.value.toLowerCase();$('#bucket-results').innerHTML=bucketTable(state.data.filter(b=>b.name.toLowerCase().includes(query)));}
    if(event.target.id==='wiki-search'){const query=event.target.value.toLocaleLowerCase(locale());$('#wiki-results').innerHTML=wikiResults(wiki.filter(w=>`${w.title} ${w.body.replace(/<[^>]*>/g,' ')}`.toLocaleLowerCase(locale()).includes(query)));}
  });
  document.addEventListener('change',event=>{if(event.target.id==='audit-page-size'){state.auditPageSize=Number(event.target.value);loadAuditPage(1);}if(event.target.id==='all-buckets')$('#key-bucket-list').classList.toggle('hidden',event.target.checked);});
  document.addEventListener('submit',async event=>{
    const form=event.target;
    if(form.id==='auth-form'){
      event.preventDefault();await submit(form,$('#auth-error'),async()=>{const fd=new FormData(form);const body={username:fd.get('username'),password:fd.get('password'),code:fd.get('code')||undefined};if(state.setupTokenRequired)body.setupToken=fd.get('setupToken');const result=await api('/api/login',{method:'POST',body});state.user=result.user||{username:body.username};state.role=result.role||result.user?.role||'viewer';state.csrf=result.csrf;applyLanguage(result.language);state.defaultCredentials=Boolean(result.defaultCredentials);await features?.restoreUploads();route();});
    }else if(form.id==='prefix-form'){event.preventDefault();location.hash='#objects?'+new URLSearchParams({bucket:state.bucket,prefix:new FormData(form).get('prefix')});}
    else if(form.id==='topology-form'){
      event.preventDefault();await submit(form,$('#topology-error'),async()=>{
        const mode=new FormData(form).get('mode');const nodes=$$('[data-node]',form).map(row=>{const node={id:$('[name=nodeId]',row).value.trim(),label:$('[name=nodeLabel]',row).value.trim(),url:$('[name=nodeUrl]',row).value.trim()};const token=$('[name=nodeToken]',row).value;if(token)node.token=token;return node;});
        if(new Set(nodes.map(n=>n.id)).size!==nodes.length)throw new Error(t("ID каждого узла должен быть уникальным."));
        if(mode==='raid1'&&nodes.length<2)throw new Error(t("Для RAID 1 нужно минимум 2 узла."));
        if(mode==='raid10'&&(nodes.length<4||nodes.length%2!==0))throw new Error(t("Для RAID 10 нужно чётное количество узлов, минимум 4."));
        const migrate=Number(state.status?.objectCount)>0;
        if(migrate&&!$('#migration-consent')?.checked)throw new Error(t("Подтвердите перенос существующих объектов."));
        const progress=$('#migration-progress');progress.textContent=migrate?t("Перенос запущен. Не отключайте узлы."):t("Проверяем и сохраняем конфигурацию…");
        let polling=false;
        const timer=setInterval(async()=>{if(polling)return;polling=true;try{const current=await api('/api/status');if(progress.isConnected&&current.migration?.active){progress.textContent=t("Перенос объектов: ")+number(current.migration.completed)+t(" из ")+number(current.migration.total)+t(". Фиксация новых записей ожидает завершения.");}}catch{}finally{polling=false;}},2000);
        try{const result=features?await features.planTopology({mode,nodes,migrate}):await api('/api/topology',{method:'PUT',body:{mode,nodes,migrate}});toast(result.migrated?t("Топология сохранена, объекты перенесены"):t("Топология сохранена"));loadPage();}finally{clearInterval(timer);if(progress.isConnected)progress.textContent='';}
      });
    }else if(form.id==='settings-form'){
      event.preventDefault();await submit(form,$('#settings-error'),async()=>{const fd=new FormData(form);const interval=Number(fd.get('scrubIntervalSeconds'));if(interval!==0&&interval<60)throw new Error(t("Интервал проверки должен быть 0 или не меньше 60 секунд."));await api('/api/settings',{method:'PUT',body:{cacheBytes:Number(fd.get('cacheMB'))*1048576,concurrency:Number(fd.get('concurrency')),scrubIntervalSeconds:Number(fd.get('scrubIntervalSeconds'))}});$$('input,textarea',form).forEach(field=>{field.defaultValue=field.value;});toast(t("Настройки сохранены"));});
    }else if(form.id==='password-form'){
      event.preventDefault();await submit(form,$('#password-error'),async()=>{const fd=new FormData(form);if(fd.get('password')!==fd.get('repeatPassword'))throw new Error(t("Новые пароли не совпадают."));const result=await api('/api/password',{method:'PUT',body:{currentPassword:fd.get('currentPassword'),password:fd.get('password')}});state.csrf=result.csrf;state.user=result.user;state.defaultCredentials=false;state.setupTokenRequired=false;form.reset();toast(t("Пароль аккаунта изменён"));loadPage();});
    }
  });
  $('#dialog').addEventListener('close',()=>{if(!$('#dialog').open){$('#dialog').innerHTML='';$('#dialog').className='';}});
  window.addEventListener('hashchange',route);
  window.addEventListener('beforeunload',event=>{if(state.uploads.some(u=>['queued','uploading'].includes(u.status))){event.preventDefault();event.returnValue='';}});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.menu){state.menu=false;$('.shell')?.classList.remove('menu-open');$('.mobile-toggle')?.setAttribute('aria-expanded','false');}});
  function applyLanguage(language) {
    state.language=setLanguage(language);
    document.title=t('27G-StorageS3 — хранилище объектов');
    const skip=$('.skip-link');if(skip)skip.textContent=t('Перейти к содержимому');
  }
  async function setLanguagePreference(language) {
    const preference=await api('/api/preferences',{method:'PUT',body:{language}});
    applyLanguage(preference.language || language);
    // Labels are rendered from static messages again; stored names and content stay untouched.
    await loadPage();
  }
  async function init(){
    try{const session=await api('/api/session');applyLanguage(session.authenticated ? session.language : 'en');state.defaultCredentials=Boolean(session.defaultCredentials);state.setupTokenRequired=Boolean(session.setupTokenRequired);if(session.authenticated){state.user=session.user||{username:t("Администратор")};state.role=session.role||session.user?.role||'viewer';state.csrf=session.csrf;await features?.restoreUploads();route();}else {renderAuth();features?.decorateLogin();}}
    catch(error){$('#app').innerHTML=`<main id="main" class="initial-loader"><span class="brand-mark" aria-hidden="true"><img src="/console/brand-mark.png" alt="" width="48" height="48"></span>${errorBlock(error,false)}<button class="button" id="retry-connection">${esc(t("Повторить подключение"))}</button></main>`;$('#retry-connection').addEventListener('click',init);}
  }
  import('/console/features.js').then(({createFeatures})=>{features=createFeatures({$, $$, esc, icon, button, bytes, number, date, duration, state, api, toast, heading, openDialog, confirmAction, submit, loadPage, init, wiki, setLanguagePreference,addNode:node=>{const list=$('#nodes-form');if(!list)throw new Error(t("Откройте раздел Кластер перед подключением диска."));list.insertAdjacentHTML('beforeend',nodeFields(node,Date.now()));if(node.token)$('[name=nodeToken]',list.lastElementChild).value=node.token;}});return init();}).catch(error=>{ $('#app').innerHTML=`<main class="initial-loader">${errorBlock(error,false)}<button class="button" type="button" id="retry-app">${esc(t("Перезагрузить"))}</button></main>`;$('#retry-app').addEventListener('click',()=>location.reload());});
})();

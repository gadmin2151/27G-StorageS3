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
    activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>'
  };
  const icon = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
  const button = (label, action, kind = '', glyph = '', extra = '') => `<button type="button" class="button ${kind}" data-action="${esc(action)}" aria-label="${esc(label)}" ${extra}>${glyph ? icon(glyph) : ''}<span class="button-text">${esc(label)}</span></button>`;
  const bytes = n => {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n === 0) return '0 Б';
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
    return `${new Intl.NumberFormat('ru', {maximumFractionDigits:i ? 1 : 0}).format(n / 1024 ** i)} ${['Б','КиБ','МиБ','ГиБ','ТиБ'][i]}`;
  };
  const number = n => Number.isFinite(Number(n)) ? new Intl.NumberFormat('ru').format(Number(n)) : '—';
  const date = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('ru', {dateStyle:'medium',timeStyle:'short'}).format(d); };
  const duration = seconds => { const n = Math.max(0, Number(seconds) || 0); return n > 86400 ? `${Math.floor(n/86400)} д ${Math.floor(n%86400/3600)} ч` : n > 3600 ? `${Math.floor(n/3600)} ч ${Math.floor(n%3600/60)} мин` : `${Math.floor(n/60)} мин`; };
  const state = {csrf:null,user:null,defaultCredentials:false,setupTokenRequired:false,page:'overview',data:null,status:null,bucket:'',prefix:'',renderID:0,uploads:[],uploadConcurrency:3,menu:false,topology:null};
  const navigation = [['overview','Обзор','grid'],['buckets','Бакеты и объекты','bucket'],['cluster','Кластер','server'],['keys','Ключи доступа','key'],['wiki','Документация','book'],['settings','Настройки','settings']];

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
      const detail = typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Ошибка ${response.status}`;
      if (response.status === 401 && state.user && !path.includes('/password')) {
        state.user = null; state.csrf = null; stopUploads(); init(); toast('Сессия завершена. Войдите снова.',true);
      }
      throw new Error(detail);
    }
    return result;
  }
  function toast(message, error = false) {
    const item = document.createElement('div'); item.className = `toast${error ? ' error' : ''}`;
    const text = document.createElement('span'); text.textContent = message;
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label','Закрыть уведомление'); close.addEventListener('click',() => item.remove());
    item.append(text,close); $('#toast-region').append(item); setTimeout(() => item.remove(), error ? 11000 : 6500);
  }
  function errorBlock(error, retry = true) { return `<div class="notice error" role="alert">${icon('info')}<div><strong>Не удалось загрузить данные</strong><p>${esc(error.message)}</p>${retry ? button('Попробовать снова','refresh','small') : ''}</div></div>`; }
  function brand() { return `<span class="brand-mark" aria-hidden="true"><img src="/console/storage-mark.svg" alt="" width="40" height="40"></span><div><div class="brand-name">27g-Storege<span>S3</span></div></div>`; }
  function health() {
    const nodes = state.status?.nodes || [];
    if (!nodes.length) return `<span class="health"><span class="dot warn"></span>Статус загружается</span>`;
    if (nodes.some(n => n.online === false)) return `<span class="health"><span class="dot bad"></span>Есть недоступные узлы</span>`;
    if (nodes.some(n => n.online === undefined)) return `<span class="health"><span class="dot warn"></span>Статус узлов не определён</span>`;
    return `<span class="health"><span class="dot"></span>Все узлы доступны</span>`;
  }
  function shell() {
    const title = navigation.find(n => n[0] === state.page)?.[1] || 'Бакеты и объекты';
    const username = (typeof state.user === 'string' ? state.user : state.user?.username || state.user?.name) || 'Администратор';
    $('#app').innerHTML = `<div class="shell${state.menu ? ' menu-open' : ''}">
      <div class="menu-shade" data-action="menu-close"></div>
      <aside class="sidebar" aria-label="Главная навигация">
        <button type="button" class="icon-btn sidebar-close" data-action="menu-close" aria-label="Закрыть меню">${icon('x')}</button>
        <a class="brand" href="#overview" aria-label="27g-StoregeS3 — обзор">${brand()}</a>
        <nav class="nav">${navigation.map(([id,label,glyph]) => {
          const active = state.page === id || id === 'buckets' && state.page === 'objects';
          return `<a href="#${id}" class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(glyph)}${label}</a>`;
        }).join('')}</nav>
        <div class="sidebar-bottom"><div class="sidebar-family"><strong>27G</strong><p>Своя инфраструктура.<br>Ваши данные.</p></div><div class="version"><span>StoregeS3</span><span>v${esc(state.status?.version || '0.1.0')}</span></div></div>
      </aside>
      <div class="workspace">
        <header class="topbar"><div class="row">
          <button type="button" class="icon-btn mobile-toggle" data-action="menu" aria-label="Открыть меню" aria-expanded="${state.menu}">${icon('menu')}</button>
          <div class="breadcrumb"><span class="workspace-title">27G / STORAGE</span>${icon('chevron').replace('class="icon"','class="icon breadcrumb-icon"')}<strong>${esc(title)}</strong></div>
        </div><div class="topbar-actions"><div id="system-health">${health()}</div><div class="user-menu"><span class="avatar" title="${esc(username)}">${esc(username.slice(0,2).toUpperCase())}</span><button class="icon-btn" type="button" data-action="logout" aria-label="Выйти из аккаунта" title="Выйти">${icon('logout')}</button></div></div></header>
        <main class="main" id="main" tabindex="-1"><div class="loading" role="status">Загружаем данные…</div></main>
      </div></div><div id="upload-container"></div>`;
    renderQueue();
  }
  function heading(title, description, actions = '', eyebrow = 'Панель управления') { return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="row wrap">${actions}</div>` : ''}</div>`; }
  function modeName(mode, nodes = []) { return nodes.length === 1 && (mode === 'raid0' || mode === 'single') ? 'Один узел' : String(mode || '—').toUpperCase(); }
  function modeDescription(mode, nodes = []) {
    if (nodes.length === 1) return 'Объекты хранятся на одном узле. Добавьте узлы для расширения ёмкости или создания копий.';
    return ({raid0:'Объекты распределяются между узлами. Суммарная ёмкость растёт, резервных копий нет.',raid1:'Каждый объект записывается на все узлы. Загрузка завершается после подтверждения каждой копии.',raid10:'Объекты распределяются между парами узлов. Внутри каждой пары хранятся две одинаковые копии.'})[mode] || 'Топология хранилища.';
  }
  function clusterGraphic(nodes, mode, limit = 6) {
    const node = n => `<div class="node-tile">${icon('server')}<strong title="${esc(n.label || n.id)}">${esc(n.id === 'local' && n.label === 'Coordinator storage' ? 'Локальный узел' : n.label || n.id)}</strong><small><span class="dot${n.online === false ? ' bad' : n.online === undefined ? ' warn' : ''}"></span>${n.online === false ? 'Недоступен' : n.online === undefined ? 'Не проверен' : 'Доступен'}</small></div>`;
    const visible = nodes.slice(0,limit);
    const content = mode === 'raid10' ? visible.reduce((acc,n,i) => i%2 ? acc : acc + `<div class="node-pair">${node(n)}${visible[i+1] ? node(visible[i+1]) : ''}</div>`, '') : visible.map(node).join('');
    return `<div class="cluster-visual">${content || '<span class="muted">Нет настроенных узлов</span>'}</div>${nodes.length > limit ? `<p class="cluster-limit">Ещё ${nodes.length - limit} узлов в конфигурации</p>` : ''}`;
  }
  function stat(label, value, foot, glyph, accent = false) {
    return `<article class="stat${accent ? ' stat-accent' : ''}"><div class="stat-icon">${icon(glyph)}</div><div class="stat-content"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div></article>`;
  }
  function bucketTable(buckets, compact = false) {
    if (!buckets.length) return `<div class="empty">${icon('bucket')}<h3>Первый бакет — начало хранилища</h3><p>Создайте пространство для файлов, резервных копий или данных приложения.</p>${button('Создать бакет','new-bucket','primary','plus')}</div>`;
    return `<div class="table-wrap"><table><thead><tr><th>Название бакета</th><th>Объекты</th><th>Объём данных</th><th>${compact ? 'Доступ' : 'Создан'}</th><th><span class="visually-hidden">Действия</span></th></tr></thead><tbody>${buckets.map(b => `<tr><td><a class="table-name" href="#objects?bucket=${encodeURIComponent(b.name)}">${icon('bucket')}<span>${esc(b.name)}</span></a></td><td>${number(b.objects)}</td><td>${bytes(b.bytes)}</td><td class="muted">${compact ? '<span class="badge">Приватный</span>' : date(b.createdAt)}</td><td class="table-actions">${compact ? `<a href="#objects?bucket=${encodeURIComponent(b.name)}" aria-label="Открыть ${esc(b.name)}">${icon('arrow')}</a>` : button('Удалить','delete-bucket','small danger','trash',`data-bucket="${esc(b.name)}"`)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderOverview(s, buckets) {
    const nodes = s.nodes || [], knownCapacity = nodes.length && nodes.every(n => Number.isFinite(n.capacityBytes ?? n.totalBytes) && Number.isFinite(n.freeBytes));
    const capacity = knownCapacity ? nodes.reduce((a,n) => a+(n.capacityBytes ?? n.totalBytes),0) : null;
    const free = knownCapacity ? nodes.reduce((a,n) => a+n.freeBytes,0) : null;
    const used = knownCapacity ? capacity-free : null;
    const percentage = knownCapacity && capacity > 0 ? Math.max(0,Math.min(100,Math.round(used/capacity*100))) : null;
    const cache = s.cache || {}, queue = s.queue || {};
    const hits = Number(cache.hits || 0), misses = Number(cache.misses || 0), ratio = hits+misses ? Math.round(hits/(hits+misses)*100)+'%' : 'Нет запросов';
    return heading('Ваши данные. Под контролем.','Объекты, ресурсы и состояние кластера в одном месте.',button('Обновить','refresh','','refresh') + button('Создать бакет','new-bucket','primary','plus'), '') +
      `<section class="system-banner${nodes.some(n => n.online === false) ? ' degraded' : ''}" aria-label="Состояние узлов"><span class="system-banner-dot dot${nodes.some(n => n.online === false) ? ' bad' : !nodes.length || nodes.some(n => n.online !== true) ? ' warn' : ''}" aria-hidden="true"></span><div class="system-banner-copy"><strong>${nodes.length && nodes.every(n => n.online === true) ? 'Все узлы на связи' : nodes.some(n => n.online === false) ? 'Есть недоступные узлы' : 'Доступность узлов не определена'}</strong><p>${esc(modeName(s.mode,nodes))} · ${nodes.length === 1 ? 'Подключите дополнительные узлы в разделе «Кластер».' : 'Состояние подключённых узлов на момент обновления.'}</p></div><div class="system-banner-meta"><span class="eyebrow">Время работы</span><strong>${duration(s.uptime)}</strong></div></section><div class="stats">${stat('Объём объектов',bytes(s.totalBytes), 'Без учёта реплик','bucket',true)}${stat('Объектов',number(s.objectCount), `Бакетов: ${number(buckets.length)}`,'file')}${stat('Узлы хранилища',`${nodes.filter(n => n.online === true).length}<small> / ${nodes.length}</small>`, `${esc(modeName(s.mode,nodes))} · ${nodes.filter(n => n.online === false).length ? 'есть недоступные' : 'доступны'}`,'server')}${stat('Активные загрузки',number(queue.active ?? 0), `В очереди: ${number(queue.pending ?? 0)} · лимит ${number(queue.concurrency)}`,'activity')}</div>
      <div class="overview-grid"><section class="panel"><div class="panel-head"><div><h2>Пространство для ваших данных</h2><p>Физические диски подключённых узлов</p></div><span class="badge">${knownCapacity ? bytes(capacity) : 'Ёмкость не определена'}</span></div><div class="panel-body"><div class="capacity"><div class="storage-ring"><svg class="ring-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52"/><circle class="ring-value" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${percentage ?? 0} 100" transform="rotate(-90 60 60)"/></svg><span>${percentage === null ? '—' : percentage+'%'}<small>${knownCapacity ? 'дисков занято' : 'нет данных о дисках'}</small></span></div><div class="capacity-details"><div class="legend-item"><span><i class="legend-dot"></i>Объекты без реплик</span><strong>${bytes(s.totalBytes)}</strong></div><div class="legend-item"><span><i class="legend-dot gray"></i>Занято на дисках</span><strong>${used === null ? '—' : bytes(used)}</strong></div><div class="legend-item"><span><i class="legend-dot outline"></i>Свободно на дисках</span><strong>${free === null ? '—' : bytes(free)}</strong></div></div></div><div class="endpoint-box"><div class="spacer"><div class="eyebrow">S3 endpoint · path-style</div><code>${esc(s.endpoint || location.origin)}</code></div><button class="icon-btn" type="button" data-action="copy" data-copy="${esc(s.endpoint || location.origin)}" aria-label="Скопировать S3 endpoint">${icon('copy')}</button></div><p class="tiny muted note-top">Ёмкость дисков включает другие файлы; диски общих файловых систем могут учитываться несколько раз.</p></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Ваш кластер</h2><p>Топология и доступность узлов</p></div><span class="badge accent">${esc(modeName(s.mode,nodes))}</span></div><div class="panel-body"><div class="overview-cluster">${clusterGraphic(nodes,s.mode)}</div><p class="cluster-caption">${esc(modeDescription(s.mode,nodes))}</p><div class="row between small-summary"><span>RAM-кэш <strong>${bytes(cache.bytes ?? 0)}</strong> / ${bytes(cache.limit)}</span><span>Попадания <strong>${ratio}</strong></span></div><progress class="cache-meter" max="${Math.max(1,Number(cache.limit) || 0)}" value="${Math.max(0,Number(cache.bytes) || 0)}" aria-label="Использование RAM-кэша"></progress></div><div class="panel-footer"><span>В работе ${duration(s.uptime)}</span><a href="#cluster">Управление кластером ${icon('arrow')}</a></div></section></div>
      <section class="panel"><div class="panel-head"><div><h2>Бакеты</h2><p>Приватные пространства для хранения объектов</p></div><div class="search-wrap"><label class="visually-hidden" for="overview-bucket-search">Поиск бакетов в обзоре</label>${icon('search')}<input id="overview-bucket-search" class="search-input" type="search" placeholder="Поиск по бакетам…"></div></div><div id="overview-bucket-results">${bucketTable(buckets.slice(0,5),true)}</div><div class="panel-footer"><span>Бакетов: ${number(buckets.length)}</span><a href="#buckets">Все бакеты ${icon('arrow')}</a></div></section>
      <div class="notice section-gap">${icon('book')}<div><strong>Всё начинается с понятной настройки.</strong> Подключите S3-клиент, выберите топологию и узнайте, как защитить данные. <a href="#wiki">Открыть документацию →</a></div></div>
      ${s.limitations?.length ? `<details class="section-gap small-summary"><summary>Границы текущей версии</summary><ul>${s.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}<p class="footer-note">27g-StoregeS3 · ${esc(s.version || '0.1.0')} · Собственная инфраструктура. Ваши данные.</p>`;
  }
  function renderBuckets(buckets) { return heading('Бакеты и объекты','Разделяйте данные по проектам и управляйте файлами.',button('Создать бакет','new-bucket','primary','plus')) + `<div class="toolbar"><div class="search-wrap">${icon('search')}<input id="bucket-search" class="search-input" type="search" placeholder="Найти бакет…" aria-label="Поиск бакетов"></div><span class="muted tiny">Всего ${number(buckets.length)} бакетов</span><span class="spacer"></span>${button('Обновить','refresh','','refresh')}</div><section class="panel" id="bucket-results">${bucketTable(buckets)}</section>`; }
  function objectTable(objects, prefixes) {
    if (!objects.length && !prefixes.length) return `<div class="empty">${icon('folder')}<h3>Здесь пока нет объектов</h3><p>${state.prefix ? 'В этом префиксе нет файлов. Выберите другой префикс или загрузите объекты сюда.' : 'Перетащите файлы в область выше или подключите приложение по S3 API.'}</p></div>`;
    return `<div class="table-wrap"><table><thead><tr><th>Объект</th><th>Размер</th><th>Изменён</th><th><span class="visually-hidden">Действия</span></th></tr></thead><tbody>${prefixes.map(p => {const prefix = typeof p === 'string' ? p : p.prefix || p.Prefix; return `<tr><td><a class="table-name" href="#objects?bucket=${encodeURIComponent(state.bucket)}&prefix=${encodeURIComponent(prefix)}">${icon('folder')}<span>${esc(prefix)}</span></a></td><td class="muted">Префикс</td><td>—</td><td></td></tr>`;}).join('')}${objects.map(o => `<tr><td><span class="table-name">${icon('file')}<span class="object-key" title="${esc(o.key)}">${esc(o.key.startsWith(state.prefix) ? o.key.slice(state.prefix.length) : o.key)}</span></span></td><td>${bytes(o.size)}</td><td class="muted">${date(o.modifiedAt)}</td><td class="table-actions"><div class="row justify-end">${button('Поделиться','share-object','small','link',`data-key="${esc(o.key)}"`)}<a class="button small" href="/api/object?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(o.key)}" download aria-label="Скачать ${esc(o.key)}">${icon('download')}<span class="button-text">Скачать</span></a>${button('Удалить','delete-object','small danger','trash',`data-key="${esc(o.key)}"`)}</div></td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderObjects(data) {
    return heading(state.bucket,'Просматривайте, загружайте и скачивайте объекты.',`<a href="#buckets" class="button">Все бакеты</a>${button('Обновить','refresh','','refresh')}`, 'Бакеты / объекты') +
      `<div class="dropzone" id="dropzone">${icon('upload')}<strong>Перетащите файлы сюда ${button('Выбрать файлы','choose-files','','plus')}</strong><p>Загрузка в ${esc(state.bucket)}${state.prefix ? ' / '+esc(state.prefix) : ''} · до ${state.uploadConcurrency} файлов одновременно</p><input class="visually-hidden" id="upload-files" type="file" multiple aria-label="Файлы для загрузки"></div><form id="prefix-form" class="toolbar"><div class="search-wrap">${icon('search')}<input class="search-input" name="prefix" type="search" value="${esc(state.prefix)}" placeholder="Фильтр по префиксу, например photos/" aria-label="Префикс объектов"></div><button class="button" type="submit">Показать</button>${state.prefix ? '<a class="button ghost" href="#objects?bucket='+encodeURIComponent(state.bucket)+'">Сбросить</a>' : ''}<span class="spacer"></span><span class="muted tiny">${number(data.objects?.length || 0)} объектов на странице</span></form><section class="panel">${objectTable(data.objects || [],data.commonPrefixes || [])}${data.isTruncated ? `<div class="panel-footer"><span>Показаны не все объекты</span>${button('Следующая страница','next-objects','small','arrow',`data-token="${esc(data.nextContinuationToken)}"`)}</div>` : ''}</section>`;
  }
  function nodeFields(node, index) { return `<div class="node-form" data-node><div class="field"><label for="node-id-${index}">ID узла</label><input id="node-id-${index}" name="nodeId" value="${esc(node.id || '')}" required pattern="[a-zA-Z0-9_-]+" maxlength="64" ${node.id === 'local' ? 'readonly' : ''}></div><div class="field"><label for="node-label-${index}">Название</label><input id="node-label-${index}" name="nodeLabel" value="${esc(node.label || '')}" required maxlength="80"></div><div class="field"><label for="node-url-${index}">Внутренний адрес</label><input id="node-url-${index}" name="nodeUrl" value="${esc(node.url || '')}" ${node.id === 'local' ? 'readonly' : ''} required placeholder="http://node1:9100"></div><div class="field"><label for="node-token-${index}">Токен узла</label><input id="node-token-${index}" name="nodeToken" type="password" autocomplete="new-password" placeholder="${node.id === 'local' ? 'Не требуется' : 'Оставить текущий'}" ${node.id === 'local' ? 'disabled' : ''}></div><button type="button" class="icon-btn" data-action="remove-node" aria-label="Удалить узел ${esc(node.label || node.id)}">${icon('trash')}</button></div>`; }
  function renderCluster(topology, status) {
    const hasObjects = Number(status.objectCount) > 0, nodes = topology.nodes || [], mode = topology.mode === 'single' ? 'raid0' : topology.mode;
    state.topology = topology;
    return heading('Кластер хранилища','Объединяйте узлы для ёмкости, копирования или обоих сценариев.',button('Проверить и восстановить','scrub','','shield')) +
      `<div class="notice${hasObjects ? ' warn' : ''}">${icon('info')}<div>${hasObjects ? '<strong>Изменение топологии запустит перенос объектов.</strong> Чтение остаётся доступным, фиксация новых записей ждёт окончания переноса. Подготовьте запас свободного места. Если перенос не удастся, прежняя конфигурация останется активной.' : '<strong>Настройте топологию до загрузки данных.</strong> Это распределение и копирование целых объектов между узлами по аналогии с RAID. Каждый узел запускается отдельно и подключается по внутреннему адресу.'}</div></div>
      <form id="topology-form" class="section-gap"><fieldset class="plain-fieldset"><legend class="visually-hidden">Режим хранения</legend><div class="mode-grid"><label class="mode-option"><input type="radio" name="mode" value="raid0" ${mode === 'raid0' ? 'checked' : ''}><div class="eyebrow">Больше места</div><strong>RAID 0</strong><span>Один экземпляр объекта. Ёмкость узлов складывается. Потеря узла означает потерю части объектов.</span></label><label class="mode-option"><input type="radio" name="mode" value="raid1" ${mode === 'raid1' ? 'checked' : ''}><div class="eyebrow">Копии данных</div><strong>RAID 1</strong><span>Каждый объект на каждом узле. Минимум 2 узла. Полезная ёмкость ограничена самым маленьким.</span></label><label class="mode-option"><input type="radio" name="mode" value="raid10" ${mode === 'raid10' ? 'checked' : ''}><div class="eyebrow">Место + копии</div><strong>RAID 10</strong><span>Распределение между зеркальными парами. От 4 узлов, чётное количество. Пары определяются порядком.</span></label></div><section class="panel"><div class="panel-head"><div><h2>Узлы кластера</h2><p>Порядок узлов определяет зеркальные пары в RAID 10</p></div>${button('Добавить узел','add-node','small','plus')}</div><div class="panel-body"><div id="nodes-form" class="nodes-form">${nodes.map(nodeFields).join('')}</div><p class="tiny muted note-top">URL <code>local</code> — встроенный диск координатора. Для удалённых узлов используйте закрытую сеть Docker и собственный секретный токен.</p>${hasObjects ? '<label class="check-label section-gap"><input type="checkbox" id="migration-consent" required>Подтверждаю перенос существующих объектов. На узлах достаточно свободного места; записи могут ждать окончания переноса.</label>' : ''}<div id="migration-progress" class="small-summary section-gap" aria-live="polite"></div><div class="form-error" id="topology-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">${icon('check')}Сохранить топологию</button></div></div></section></fieldset></form>
      <div class="overview-grid section-gap"><section class="panel"><div class="panel-head"><div><h2>Текущая схема</h2><p>${esc(modeName(status.mode,status.nodes || []))}</p></div></div><div class="panel-body">${clusterGraphic(status.nodes || [],status.mode,10)}<p class="small-summary">${esc(modeDescription(status.mode,status.nodes || []))}</p></div></section><section class="panel"><div class="panel-head"><h2>Что важно для надёжности</h2></div><div class="panel-body"><p class="small-summary">Копии объектов помогают пережить потерю диска, но не заменяют резервное копирование. Метаданные и ключи остаются на одном координаторе: его данные тоже нужно сохранять.</p><p class="small-summary">RAID 1 и RAID 10 подтверждают запись только после сохранения всех требуемых копий. При недоступности реплики загрузка завершится ошибкой.</p><a href="#wiki-cluster" class="small-summary">Подробнее о режимах и восстановлении →</a></div></section></div><div id="scrub-result"></div>`;
  }
  function renderKeys(keys) {
    return heading('Ключи доступа','Подключайте приложения к S3 API и ограничивайте их доступ.',button('Создать ключ','new-key','primary','plus')) + `<div class="notice">${icon('shield')}<div>Бакеты приватные. Создайте отдельный ключ для каждого приложения. Секрет показывается один раз; доступ можно отозвать в любой момент.</div></div><section class="panel section-gap"><div class="panel-head"><div><h2>Ключи приложений</h2><p>${number(keys.length)} ключей доступа</p></div><a class="button small ghost" href="#wiki-s3">Подключение S3 ${icon('arrow')}</a></div>${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Приложение / ключ</th><th>Разрешения</th><th>Бакеты</th><th>Создан</th><th><span class="visually-hidden">Действия</span></th></tr></thead><tbody>${keys.map(k => `<tr><td><strong>${esc(k.label || 'Без названия')}</strong><div class="mono muted tiny key-caption">${esc(k.accessKey)}</div></td><td><span class="badge${k.role === 'readonly' ? '' : ' accent'}">${k.role === 'readonly' ? 'Только чтение' : 'Чтение и запись'}</span></td><td class="muted">${Array.isArray(k.buckets) && k.buckets.length ? esc(k.buckets.join(', ')) : 'Все бакеты'}</td><td class="muted">${date(k.createdAt)}</td><td class="table-actions">${button('Отозвать','revoke-key','small danger','trash',`data-id="${esc(k.id)}" data-label="${esc(k.label || k.accessKey)}"`)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${icon('key')}<h3>Подключите первое приложение</h3><p>Пара ключей даст вашему приложению доступ к объектам через совместимый S3 API.</p>${button('Создать ключ','new-key','primary','plus')}</div>`}</section>`;
  }
  function renderSettings(settings, status, audit) {
    return heading('Настройки системы','Ресурсы, безопасность аккаунта и журнал действий.',button('Обновить','refresh','','refresh')) +
      `<div class="settings-layout"><div class="stack"><section class="panel"><div class="panel-head"><div><h2>Ресурсы и производительность</h2><p>Лимиты помогают удерживать нагрузку в пределах сервера</p></div></div><form class="panel-body" id="settings-form"><div class="form-grid"><div class="field"><label for="cache-size">Лимит RAM-кэша, МиБ</label><input id="cache-size" type="number" name="cacheMB" min="0" max="1024" step="1" value="${Math.round(Number(settings.cacheBytes || 0)/1048576)}" required><small>0 отключает кэш. Горячие объекты хранятся в памяти в пределах лимита.</small></div><div class="field"><label for="concurrency">Параллельные операции записи</label><input id="concurrency" type="number" name="concurrency" min="1" max="64" step="1" value="${Number(settings.concurrency) || 4}" required><small>Более высокий лимит увеличивает нагрузку на диски, сеть и память.</small></div></div><div class="field full"><label for="scrub-interval">Автопроверка и восстановление, секунд</label><input id="scrub-interval" type="number" name="scrubIntervalSeconds" min="0" max="86400" step="1" value="${Number(settings.scrubIntervalSeconds ?? 900)}" required><small>От 60 до 86400 секунд. 0 отключает автоматическую проверку. По умолчанию — каждые 15 минут.</small></div><div class="settings-item"><span>Максимальный размер объекта</span><strong>${bytes(settings.maxObjectBytes)}</strong></div><div class="settings-item"><span>Лимит ожидающей очереди</span><strong>${number(settings.queueLimit)}</strong></div><p class="tiny muted">Размер объекта и лимит очереди задаются при запуске контейнера.</p><div id="settings-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">Сохранить настройки</button></div></form></section><section class="panel"><div class="panel-head"><h2>Пароль администратора</h2></div><form class="panel-body" id="password-form"><div class="form-grid"><div class="field full"><label for="current-password">Текущий пароль</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">Новый пароль</label><input id="new-password" name="password" type="password" minlength="12" autocomplete="new-password" required><small>Минимум 12 символов.</small></div><div class="field"><label for="repeat-password">Повторите новый пароль</label><input id="repeat-password" name="repeatPassword" type="password" minlength="12" autocomplete="new-password" required></div></div><div id="password-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button" type="submit">Обновить пароль</button></div></form></section></div><div class="stack align-start"><section class="panel"><div class="panel-head"><h2>О системе</h2></div><div class="panel-body"><div class="settings-item"><span>Версия</span><strong>${esc(status.version || '0.1.0')}</strong></div><div class="settings-item"><span>Время работы</span><strong>${duration(status.uptime)}</strong></div><div class="settings-item"><span>Защищённые cookie</span><span class="badge ${status.security?.secureCookies ? 'success' : 'warn'}">${status.security?.secureCookies ? 'Включены' : 'Отключены'}</span></div><p class="tiny muted note-top">Для доступа через интернет используйте HTTPS и настройте secure cookie. Порты узлов оставляйте в закрытой сети.</p><a href="#wiki-security" class="small-summary">Руководство по безопасному запуску →</a></div></section><section class="panel"><div class="panel-head"><div><h2>Журнал действий</h2><p>Последние события администратора</p></div>${icon('clock')}</div><div class="panel-body">${audit.error ? `<p class="small-summary">${esc(audit.error)}</p>` : audit.events?.length ? `<ul class="audit-list">${audit.events.slice(0,12).map(e => `<li><span class="dot"></span><div><p><strong>${esc(e.action)}</strong></p><p class="muted">${esc(typeof e.detail === 'object' ? JSON.stringify(e.detail) : e.detail || '')}</p><time>${date(e.at)}</time></div></li>`).join('')}</ul>` : '<p class="small-summary">Событий пока нет.</p>'}</div></section></div></div>`;
  }

  const wiki = [
    {id:'start',title:'Первый запуск',tag:'01 · Начало работы',body:`<p>27g-StoregeS3 — самостоятельное объектное хранилище с S3 API и управлением через браузер. Координатор хранит метаданные, проверяет доступ и распределяет объекты между узлами.</p><h3>Запуск через Docker Compose</h3><pre><code>docker compose up -d --build
docker compose logs app</code></pre><p>Откройте <code>http://localhost:9000/console/</code>. Новая установка автоматически создаёт администратора: логин <code>admin</code>, пароль <code>admin!123</code>. В Docker и при сетевом запуске введите также <code>Initial setup token</code> из логов. Он требуется при каждом сетевом входе со стандартным паролем. При прямом запуске только на loopback без прокси и PUBLIC_ORIGIN достаточно логина и пароля. В «Настройках» можно задать уникальный пароль от 12 символов — после этого токен не нужен. Перезапуск не сбрасывает изменённый пароль. Логи и токен должны быть доступны только владельцу сервера.</p><ol><li>Откройте «Кластер» и выберите режим хранения.</li><li>Создайте бакет — пространство для объектов одного проекта.</li><li>Загрузите файлы из браузера или создайте ключ доступа для приложения.</li><li>Перед доступом через интернет настройте HTTPS, резервное копирование и ограничения сети.</li></ol><p>Изменения настроек и файлы должны сохраняться в постоянных Docker volumes. Остановка контейнера не должна означать удаление данных.</p>`},
    {id:'s3',title:'Подключение S3-клиента',tag:'02 · Интеграции',body:`<p>Используйте endpoint координатора, подпись AWS Signature V4 и адресацию <code>path-style</code>: имя бакета входит в путь URL. В разделе «Ключи доступа» создайте отдельную пару ключей для каждого приложения.</p><h3>Python · boto3</h3><pre><code>import os
import shutil
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ.get("S3_ENDPOINT", "http://127.0.0.1:9000"),
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
    shutil.copyfileobj(body, output)</code></pre><h3>AWS CLI</h3><p>Передайте ключи через переменные окружения <code>AWS_ACCESS_KEY_ID</code> и <code>AWS_SECRET_ACCESS_KEY</code>. Не вставляйте секреты в команды, которые попадут в историю оболочки. Создайте отдельный файл настроек без секретов:</p><pre><code>cat &gt; s3-client.config &lt;&lt;'EOF'
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
export S3_ENDPOINT=http://127.0.0.1:9000

aws --endpoint-url "$S3_ENDPOINT" s3api list-buckets
aws --endpoint-url "$S3_ENDPOINT" s3api put-object \\
  --bucket my-backups --key report.pdf --body report.pdf
aws --endpoint-url "$S3_ENDPOINT" s3api get-object \\
  --bucket my-backups --key report.pdf copy.pdf</code></pre><p>Примеры предполагают существующий файл <code>report.pdf</code>; бакет <code>my-backups</code> создайте в панели либо Python-командой выше. На создание и загрузку нужен ключ с правами записи. Для удалённого сервера замените endpoint на HTTPS-адрес.</p><p>Используйте актуальные boto3/botocore с указанными checksum-параметрами. Значение <code>when_required</code> отключает необязательные автоматические checksum/trailers, а <code>payload_signing_enabled</code> включает подпись тела. Для загрузки используйте <code>put_object</code> или <code>s3api put-object</code>: высокоуровневые загрузчики могут автоматически переключаться на неподдерживаемый multipart.</p><h3>Границы совместимости</h3><p>Доступны базовые операции с бакетами и объектами, список объектов, скачивание и удаление. Это не полная реализация AWS S3: multipart upload, AWS streaming signatures и trailers, версионирование, ACL и политики AWS, object lock, lifecycle и события не заявлены. Проверьте нужные операции вашего клиента перед переносом рабочих данных.</p>`},
    {id:'cluster',title:'Кластер и режимы хранения',tag:'03 · Архитектура',body:`<p>Режимы работают на уровне целых объектов. Они повторяют логику распределения и зеркалирования RAID, но не создают блочное RAID-устройство и не превращают координатор в отказоустойчивый кластер.</p><div class="table-wrap"><table><thead><tr><th>Режим</th><th>Расположение объектов</th><th>Требования и риски</th></tr></thead><tbody><tr><td><strong>RAID 0</strong></td><td>Один экземпляр на выбранном узле</td><td>От 1 узла. Потеря узла означает потерю его объектов.</td></tr><tr><td><strong>RAID 1</strong></td><td>Каждый объект на всех узлах</td><td>От 2 узлов. Полезная ёмкость ограничена наименьшим узлом.</td></tr><tr><td><strong>RAID 10</strong></td><td>Объект в одной зеркальной паре</td><td>От 4 узлов, чётное количество. Потеря обоих узлов одной пары теряет её объекты.</td></tr></tbody></table></div><h3>Подключение узлов</h3><pre><code>sh scripts/init-cluster.sh
docker compose --profile cluster up -d --build</code></pre><p>Комплект Compose запускает четыре узла: <code>http://node1:9100</code> — <code>http://node4:9100</code>. Токен для них создаётся в файле <code>secrets/node_token</code>; скопируйте его в форму подключения. Не публикуйте этот файл и не добавляйте его в Git.</p><p>Запустите дополнительные контейнеры узлов с постоянными дисками и секретными токенами. В панели «Кластер» добавьте ID, название, внутренний URL и токен каждого узла. Для встроенного диска координатора используется адрес <code>local</code>. Пустой токен у уже подключённого узла сохраняет текущий токен.</p><p>В RAID 10 пары образуются по порядку: 1 + 2, 3 + 4 и так далее. Размещайте копии на разных физических дисках и серверах. Два контейнера на одном диске не защищают от отказа диска.</p><h3>Изменение заполненного кластера</h3><p>Для изменения состава или режима заполненного хранилища подтвердите перенос данных в форме. Система копирует объекты на новые места, а затем переключает топологию. Чтение остаётся доступным; фиксация новых записей ждёт окончания переноса. Подготовьте свободное место для временного сосуществования копий и не останавливайте контейнеры во время операции.</p><p>Если перенос не удаётся, прежняя конфигурация остаётся активной. Удаление устаревших физических копий выполняется с задержкой. Проверьте доступность объектов после переноса, прежде чем отключать прежние серверы.</p><h3>Что происходит при отказе</h3><p>Чтение зеркального объекта использует доступную исправную копию. Для записи нужны все требуемые реплики: недоступный узел приводит к ошибке записи, успешный ответ не означает сохранение только в памяти. Один координатор остаётся точкой отказа для API и метаданных.</p>`},
    {id:'uploads',title:'Загрузка, очередь и RAM-кэш',tag:'04 · Повседневная работа',body:`<p>Откройте бакет и перетащите файлы в область загрузки. Панель выполняет до трёх загрузок одновременно и показывает очередь, прогресс и результат каждого файла. Не закрывайте вкладку, пока загрузки не завершились.</p><p>Имя файла становится ключом объекта. Значение фильтра по префиксу добавляется в начало ключа при загрузке. Например, префикс <code>photos/</code> и файл <code>summer.jpg</code> дадут ключ <code>photos/summer.jpg</code>.</p><h3>Повторная запись и удаление</h3><p>Запись с тем же ключом заменяет текущий объект. В этой версии нет версий и корзины, поэтому перед перезаписью и удалением убедитесь, что у вас есть нужная резервная копия. Бакет можно удалить, только когда он пуст.</p><h3>Очередь на сервере</h3><p>Число одновременно выполняемых записей ограничено настройкой сервера. Когда очередь заполнена, запрос может завершиться ошибкой перегрузки: повторите его позже. Ограничение размера объекта задаётся при запуске.</p><h3>Кэш в оперативной памяти</h3><p>RAM-кэш ускоряет повторные чтения, пока объект находится в кэше. Лимит памяти и параллелизм меняются в «Настройках». Кэш можно отключить значением 0. После перезапуска он пуст; постоянные данные должны находиться на дисках, а не в RAM.</p><p>Высокий параллелизм не гарантирует высокую скорость. Подбирайте значения по реальным дискам, сети и нагрузке. Опубликованных эталонных замеров производительности для этой версии нет.</p>`},
    {id:'sharing',title:'Как поделиться фото или файлом',tag:'05 · Временный доступ',body:`<p>В разделе «Бакеты и объекты» откройте бакет и нажмите «Поделиться» у нужного файла. Укажите срок в днях и часах (от 1 часа до 7 дней), нажмите «Сгенерировать ссылку» и скопируйте адрес.</p><p>Получателю не нужны аккаунт, пароль и S3-ключи. Сама ссылка даёт временное право чтения, поэтому передавайте её только нужным людям. Адрес показывается при создании; позже можно создать новую ссылку. Все ещё действующие ссылки видны в том же окне, где их можно отозвать.</p><p>После окончания срока, отзыва, удаления или перезаписи файла ссылка перестаёт работать. Уже скачанную получателем копию отозвать нельзя. JPEG, PNG, GIF, WebP и AVIF с соответствующим типом содержимого открываются в браузере; остальные типы скачиваются.</p><p>Адрес <code>127.0.0.1</code> или <code>localhost</code> работает только на вашем компьютере. Для других устройств нужен доступный им адрес сервера; для публикации в интернете задайте HTTPS-адрес в <code>PUBLIC_ORIGIN</code> и настройте прокси согласно README. Публичная ссылка — отдельный маршрут приложения; бакет остаётся приватным. Временные ссылки S3 SigV4 также поддерживаются независимо.</p>`},
    {id:'security',title:'Доступ и безопасность',tag:'06 · Защита данных',body:`<p>Для публикации API и панели используйте обратный прокси с HTTPS. Включите защищённые cookie согласно конфигурации сервера. Обычный HTTP допустим только в доверенной локальной среде; пароли, S3-ключи и данные должны передаваться шифрованно.</p><ul><li>Не публикуйте порт узла <code>9100</code> в интернет. Доступ к узлам нужен только координатору в закрытой сети.</li><li>Используйте отдельные длинные случайные токены узлов. Ограничьте доступ к конфигурации, секретам, Docker и томам.</li><li>Создавайте отдельный S3-ключ для каждого приложения. Для чтения выбирайте «Только чтение» и ограничивайте список бакетов.</li><li>Храните secret key в менеджере секретов. Если ключ раскрыт, сразу отзовите его и создайте новый.</li><li>Используйте длинный уникальный пароль администратора, своевременно обновляйте образ и контролируйте журнал действий.</li><li>Регулярно проверяйте восстановление резервной копии на отдельном сервере.</li></ul><p>Текущая версия содержит базовые механизмы защиты, но не является результатом независимого аудита и не обещает неуязвимость. Перед критичной эксплуатацией нужны проверка конфигурации, тестирование и внешний аудит.</p>`},
    {id:'recovery',title:'Проверка и резервные копии',tag:'07 · Восстановление',body:`<h3>Проверка и восстановление копий</h3><p>Автоматическая проверка и восстановление выполняются каждые 15 минут по умолчанию. Интервал меняется в «Настройках»; 0 отключает фоновую проверку.</p><p>В разделе «Кластер» кнопка «Проверить и восстановить» запускает сверку контрольных сумм. Когда исправная реплика доступна, система может восстановить отсутствующую или повреждённую копию. Результат показывает проверенные, восстановленные и проблемные объекты. Проверка большого хранилища занимает время и создаёт нагрузку на диски и сеть.</p><p>Если потеряны все копии объекта, проверка не сможет создать его заново. Для RAID 0 восстановление утраченного объекта возможно только из внешней резервной копии.</p><h3>Что включить в бэкап</h3><p>Сохраняйте объекты узлов, базу метаданных SQLite координатора, его конфигурацию и секреты. Копия только объектных файлов не заменяет полное восстановление системы. Защитите бэкап секретов так же строго, как рабочие ключи.</p><p>Для согласованной резервной копии остановите операции записи и используйте корректный способ копирования SQLite либо остановите сервис. Проверьте восстановление отдельно до того, как полагаться на бэкап.</p><h3>Зеркало не является резервной копией</h3><p>Удаление и замена объекта затрагивают активное хранилище. Ошибка администратора, скомпрометированный ключ или потеря координатора требуют независимой резервной копии с собственной историей хранения.</p>`}
  ];
  function renderWiki(query = '') {
    const list = wiki.filter(w => `${w.title} ${w.body.replace(/<[^>]*>/g,' ')}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
    return `${heading('Документация','От первого бакета до кластера: всё необходимое в одном месте.', '', 'Встроенная wiki')}<div class="search-wrap wiki-search">${icon('search')}<input class="search-input" id="wiki-search" type="search" value="${esc(query)}" placeholder="Найти в документации: подключение, RAID, резервные копии…" aria-label="Поиск в документации"></div><div id="wiki-results">${wikiResults(list)}</div>`;
  }
  function wikiResults(list) { return list.length ? `<div class="wiki-layout"><nav class="wiki-nav" aria-label="Разделы документации">${list.map(w => `<a href="#wiki-${w.id}">${esc(w.title)}</a>`).join('')}</nav><div class="stack">${list.map(w => `<article class="panel wiki-article" id="wiki-${w.id}"><div class="wiki-tag">${esc(w.tag)}</div><h2>${esc(w.title)}</h2>${w.body}</article>`).join('')}</div></div>` : `<div class="empty">${icon('search')}<h3>Ничего не найдено</h3><p>Попробуйте другое слово: бакеты, ключи, загрузка или восстановление.</p></div>`; }

  function renderAuth(error = '') {
    ++state.renderID;
    $('#app').innerHTML = `<main class="auth" id="main"><section class="auth-story"><div class="brand">${brand()}</div><div class="auth-story-main"><div class="eyebrow">Простое управление. Своя инфраструктура.</div><h1>Ваши данные.<br>Ваши серверы.<br><em>Одно хранилище.</em></h1><p>Соберите диски в общее пространство, подключите приложения по S3 и управляйте всем из браузера.</p><div class="auth-art"><div class="node-tile">${icon('server')}<strong>Хранение</strong><small>Собственные узлы</small></div><span class="cluster-separator">+</span><div class="node-tile">${icon('shield')}<strong>Репликация</strong><small>Копии объектов</small></div><span class="cluster-separator">=</span><div class="node-tile">${icon('layers')}<strong>Один S3</strong><small>Единый endpoint</small></div></div></div><div class="auth-story-foot">27g-StoregeS3 · Самостоятельное объектное хранилище</div></section><section class="auth-content"><div class="auth-card"><span class="brand-mark" aria-hidden="true"><img src="/console/storage-mark.svg" alt="" width="48" height="48"></span><div class="eyebrow">Панель администратора</div><h2>${state.defaultCredentials ? 'Добро пожаловать' : 'С возвращением'}</h2><p>Войдите, чтобы управлять объектами, узлами и доступом.</p>${state.defaultCredentials ? '<div class="notice">'+icon('key')+'<div>Начальный вход: <strong>admin</strong> / <code>admin!123</code>. Пароль можно изменить в настройках.</div></div>' : ''}<form id="auth-form"><div class="field"><label for="username">Имя пользователя</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="64" value="${state.defaultCredentials ? 'admin' : ''}" required autofocus></div><div class="field"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>${state.setupTokenRequired ? '<div class="field"><label for="setup-token">Токен первоначального доступа</label><input id="setup-token" name="setupToken" type="password" autocomplete="off" required><small>Для сетевого входа со стандартным паролем нужен <code>Initial setup token</code> из <code>docker compose logs app</code>. После смены пароля токен не требуется.</small></div>' : ''}<div id="auth-error" class="form-error" role="alert">${esc(error)}</div><button type="submit" class="button primary">Войти в панель${icon('arrow')}</button></form><p class="auth-footer">${location.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(location.hostname) ? 'Подключение использует HTTP. Для удалённого доступа настройте HTTPS перед вводом секретов.' : 'Доступ предназначен для администратора сервера. Ключи S3 создаются отдельно для каждого приложения.'}</p></div></section></main>`;
  }
  function route() {
    if (!state.user) return;
    const hash = location.hash.slice(1) || 'overview';
    const [name,query] = hash.split('?');
    const params = new URLSearchParams(query);
    const page = name.startsWith('wiki-') ? 'wiki' : name;
    state.page = ['overview','buckets','objects','cluster','keys','wiki','settings'].includes(page) ? page : 'overview';
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
      if (state.page === 'wiki') html = renderWiki();
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
        const [settings,s,audit] = await Promise.all([api('/api/settings'),api('/api/status'),api('/api/audit').catch(error => ({error:error.message}))]);
        if (id !== state.renderID) return;
        state.status = s; html = renderSettings(settings,s,audit);
      }
      if (id !== state.renderID) return;
      $('#main').innerHTML = (state.defaultCredentials ? `<div class="notice warn">${icon('key')}<div>Используется начальный пароль администратора. <a href="#settings">Изменить пароль в настройках</a>.</div></div>` : '') + html;
      $('#system-health').innerHTML = health();
      if (state.page === 'objects') bindDropzone();
      if (anchor) document.getElementById(anchor)?.scrollIntoView({block:'start'});
    } catch (error) { if (id === state.renderID && $('#main')) $('#main').innerHTML = errorBlock(error); }
  }

  function openDialog(title, content, onSubmit) {
    const dialog = $('#dialog');
    dialog.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Закрыть окно">${icon('x')}</button></div><div class="dialog-body">${content}</div>`;
    dialog.showModal();
    if (onSubmit) $('form',dialog)?.addEventListener('submit',onSubmit);
    setTimeout(() => $('input:not([type=hidden]),select,button', $('.dialog-body',dialog))?.focus(),30);
  }
  function confirmAction(title, description, label, action) {
    openDialog(title,`<p>${esc(description)}</p><form><div class="form-error" role="alert"></div><div class="form-actions">${button('Отмена','close-dialog')}<button class="button danger" type="submit">${esc(label)}</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form, $('.form-error',form), async () => {await action();$('#dialog').close();});
    });
  }
  async function submit(form, errorElement, action) {
    if (form.dataset.pending === 'true') return;
    form.dataset.pending = 'true'; errorElement.textContent = '';
    const buttons = $$('button[type=submit]',form); const originals = buttons.map(b => b.innerHTML);
    buttons.forEach(b => {b.disabled = true;b.textContent = 'Выполняется…';});
    try { await action(); } catch (error) { errorElement.textContent = error.message; }
    finally {form.dataset.pending = 'false';buttons.forEach((b,i) => {b.disabled = false;b.innerHTML = originals[i];});}
  }
  function newBucket() {
    openDialog('Создать бакет',`<p>Выберите уникальное имя. Бакет будет доступен только администратору и разрешённым S3-ключам.</p><form><div class="field"><label for="bucket-name">Имя бакета</label><input id="bucket-name" name="name" required minlength="3" maxlength="63" pattern="[a-z0-9][a-z0-9.-]*[a-z0-9]" placeholder="project-backups" autocomplete="off"><small>От 3 до 63 символов: строчные латинские буквы, цифры, точки и дефисы.</small></div><div class="form-error" role="alert"></div><div class="form-actions">${button('Отмена','close-dialog')}<button type="submit" class="button primary">Создать бакет</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form,$('.form-error',form),async () => {const name = new FormData(form).get('name').trim(); await api('/api/buckets',{method:'POST',body:{name}}); $('#dialog').close();toast(`Бакет ${name} создан`);location.hash = '#objects?bucket='+encodeURIComponent(name);});
    });
  }
  function shareList(shares) {
    return shares.length ? `<ul class="share-list">${shares.map(item => `<li data-share-id="${esc(item.id)}"><div><strong>До ${date(item.expiresAt)}</strong><small>Создана ${date(item.createdAt)}</small></div>${button('Отозвать','revoke-share','small danger','x',`data-id="${esc(item.id)}"`)}</li>`).join('')}</ul>` : '<p class="small-summary">Активных ссылок нет.</p>';
  }
  async function shareObject(key) {
    const bucket = state.bucket;
    const query = new URLSearchParams({bucket,key});
    const {shares=[]} = await api('/api/shares?'+query);
    openDialog('Поделиться файлом',`<div class="share-object-name">${icon('file')}<strong>${esc(key)}</strong></div><p>Каждый, у кого есть ссылка, сможет открыть этот файл без входа до конца выбранного срока.</p><form id="share-form"><fieldset class="share-duration"><legend>На сколько времени открыть доступ?</legend><div class="form-grid"><div class="field"><label for="share-days">Дни</label><input id="share-days" name="days" type="number" min="0" max="7" step="1" value="0" required></div><div class="field"><label for="share-hours">Часы</label><input id="share-hours" name="hours" type="number" min="0" max="23" step="1" value="1" required></div></div><p class="tiny muted">От 1 часа до 7 дней. Например: 1 день и 6 часов.</p></fieldset><div class="form-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">${icon('link')}Сгенерировать ссылку</button></div></form><div id="share-result" aria-live="polite"></div><section class="section-gap"><h3>Активные ссылки</h3><div id="share-list">${shareList(shares)}</div><p class="tiny muted">Ссылку можно отозвать раньше срока. Перезапись или удаление файла также прекращает её действие.</p></section>`,async event => {
      event.preventDefault(); const form = event.target;
      const resultBox = $('#share-result'), listBox = $('#share-list');
      await submit(form,$('.form-error',form),async () => {
        const values = new FormData(form), days = Number(values.get('days')), hours = Number(values.get('hours'));
        const expiresIn = (days*24+hours)*3600;
        if (!Number.isInteger(days) || !Number.isInteger(hours) || days<0 || days>7 || hours<0 || hours>23 || expiresIn<3600 || expiresIn>604800) throw new Error('Укажите срок от 1 часа до 7 дней.');
        const result = await api('/api/shares',{method:'POST',body:{bucket,key,expiresIn}});
        if (!form.isConnected) return;
        const hostname = new URL(result.url).hostname;
        const local = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
        resultBox.dataset.shareId = result.id;
        resultBox.innerHTML = `<div class="notice section-gap">${icon('check')}<div><strong>Ссылка готова</strong><p>Действует до ${date(result.expiresAt)}.</p></div></div><div class="field section-gap"><label for="share-url">Ссылка на файл</label><input id="share-url" type="text" readonly value="${esc(result.url)}" autocomplete="off" spellcheck="false"><small>Скопируйте сейчас: после закрытия окна адрес повторно не показывается.</small></div><div class="row wrap section-gap">${button('Скопировать ссылку','copy','primary','copy',`data-copy="${esc(result.url)}"`)}<a class="button" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">Открыть файл ${icon('arrow')}</a></div>${local ? '<p class="share-local-note">Этот адрес открывается только на данном компьютере. Для обмена между устройствами настройте доступный адрес сервера.</p>' : ''}`;
        const updated = await api('/api/shares?'+query);
        if (listBox.isConnected) listBox.innerHTML = shareList(updated.shares || []);
      });
    });
  }
  async function newKey() {
    const {buckets=[]} = await api('/api/buckets');
    openDialog('Создать ключ доступа',`<p>Дайте приложению только необходимые разрешения.</p><form><div class="stack"><div class="field"><label for="key-label">Название приложения</label><input id="key-label" name="label" required maxlength="100" placeholder="Сервис резервного копирования"></div><div class="field"><label for="key-role">Разрешения</label><select name="role" id="key-role"><option value="readonly">Только чтение</option><option value="readwrite">Чтение и запись</option></select></div><div class="field"><span class="field-label">Доступные бакеты</span><label class="check-label"><input type="checkbox" id="all-buckets" name="allBuckets" checked>Все существующие и будущие бакеты</label><div id="key-bucket-list" class="stack hidden">${buckets.length ? buckets.map(b => `<label class="check-label"><input type="checkbox" name="buckets" value="${esc(b.name)}">${esc(b.name)}</label>`).join('') : '<small>Сначала создайте бакет или разрешите все бакеты.</small>'}</div></div></div><div class="form-error" role="alert"></div><div class="form-actions">${button('Отмена','close-dialog')}<button type="submit" class="button primary">Создать ключ</button></div></form>`,async event => {
      event.preventDefault();const form = event.target;
      await submit(form,$('.form-error',form),async () => {
        const fd = new FormData(form), all = fd.get('allBuckets') === 'on', selected = fd.getAll('buckets'), label = String(fd.get('label') || '').trim();
        if (!label) throw new Error('Укажите название приложения: оно не может состоять только из пробелов.');
        if (!all && !selected.length) throw new Error('Выберите хотя бы один бакет или разрешите все бакеты.');
        const result = await api('/api/keys',{method:'POST',body:{label,role:fd.get('role'),buckets:all ? [] : selected}});
        $('#dialog').close();
        openDialog('Ключ доступа создан',`<div class="notice warn">${icon('key')}<div>Сохраните secret key сейчас. После закрытия окна его нельзя будет посмотреть повторно.</div></div><div class="stack section-gap"><div class="field"><label>Access key</label><div class="secret-value">${esc(result.accessKey)}</div>${button('Скопировать','copy','small','copy',`data-copy="${esc(result.accessKey)}"`)}</div><div class="field"><label>Secret key</label><div class="secret-value">${esc(result.secretKey)}</div>${button('Скопировать секрет','copy','small','copy',`data-copy="${esc(result.secretKey)}"`)}</div></div><div class="form-actions">${button('Я сохранил ключ','close-dialog','primary','check')}</div>`);
        if (state.page === 'keys') loadPage();
      });
    });
  }

  function enqueueFiles(files) {
    if (!state.user || !state.bucket) return;
    const available = Math.max(0,100 - state.uploads.filter(u => ['queued','uploading'].includes(u.status)).length);
    const selected = [...files].slice(0,available);
    if (selected.length < files.length) toast('В очереди может быть до 100 файлов. Добавьте остальные после завершения загрузок.',true);
    if (!selected.length) return;
    const bucket = state.bucket, prefix = state.prefix;
    const append = () => {
      state.uploads = state.uploads.filter(u => ['queued','uploading'].includes(u.status)).concat(selected.map(file => ({id:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),file,bucket,key:prefix+file.name,status:'queued',progress:0,error:'',xhr:null})));
      renderQueue();pumpUploads();
    };
    const names = new Set(selected.map(f => prefix+f.name));
    const existing = (state.data?.objects || []).some(o => names.has(o.key));
    if (existing) confirmAction('Заменить существующие объекты?','Среди выбранных файлов есть имена, которые уже встречаются на открытой странице. Объекты с тем же ключом будут заменены без сохранения старой версии.','Загрузить и заменить',async () => append());
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
      if (item.status === 'error') { try { const r=JSON.parse(xhr.responseText);item.error=typeof r.error==='string'?r.error:r.error?.message||r.message||`Ошибка ${xhr.status}`; } catch {item.error=`Ошибка ${xhr.status}`;} }
      completeUpload(item);
    };
    xhr.onerror = () => {item.status='error';item.error='Соединение прервано';completeUpload(item);};
    xhr.onabort = () => {item.status='cancelled';completeUpload(item);};
    xhr.send(item.file);renderQueue();
  }
  function completeUpload(item) {
    item.xhr=null;item.file=null;renderQueue();pumpUploads();
    if (!state.uploads.some(u => ['queued','uploading'].includes(u.status)) && state.user && state.page === 'objects' && state.bucket === item.bucket) loadPage();
  }
  function stopUploads() {state.uploads.forEach(u=>{if(u.status==='queued'){u.status='cancelled';u.file=null;}});state.uploads.forEach(u=>{if(u.xhr)u.xhr.abort();});renderQueue();}
  function renderQueue() {
    const container = $('#upload-container');if(!container)return;
    if(!state.uploads.length){container.innerHTML='';return;}
    const active=state.uploads.filter(u=>['queued','uploading'].includes(u.status)).length;
    const done=state.uploads.filter(u=>u.status==='done').length;
    container.innerHTML=`<section class="queue-drawer" aria-label="Очередь загрузки"><div class="queue-head"><strong>${active ? `Загрузка файлов · осталось ${active}` : `Загрузка завершена · ${done} из ${state.uploads.length}`}</strong>${button(active?'Отменить':'Закрыть',active?'cancel-uploads':'close-uploads','small ghost',active?'x':'check')}</div><div class="queue-list">${state.uploads.map(u=>`<div class="queue-item"><div class="row between"><span class="queue-item-name" title="${esc(u.bucket+'/'+u.key)}">${esc(u.key)}</span><span class="queue-item-status${u.status==='error'?' error':''}">${u.status==='queued'?'В очереди':u.status==='uploading'?(u.progress===100?'Сохраняем…':u.progress+'%'):u.status==='done'?'Готово':u.status==='cancelled'?'Отменено':'Ошибка'}</span></div>${u.status==='uploading'?`<progress max="100" value="${u.progress}" aria-label="Загрузка ${esc(u.key)}"></progress>`:''}${u.error?`<p class="queue-item-status error">${esc(u.error)}</p>`:''}</div>`).join('')}</div></section>`;
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
      if(action==='menu'||action==='menu-close'){state.menu=action==='menu'?!state.menu:false;$('.shell')?.classList.toggle('menu-open',state.menu);$('.mobile-toggle')?.setAttribute('aria-expanded',String(state.menu));}
      else if(action==='refresh')loadPage();
      else if(action==='close-dialog')$('#dialog').close();
      else if(action==='copy'){if(!navigator.clipboard?.writeText)throw new Error('Буфер обмена недоступен. Выделите и скопируйте значение вручную или откройте панель через HTTPS.');await navigator.clipboard.writeText(target.dataset.copy);toast('Скопировано в буфер обмена');}
      else if(action==='new-bucket')newBucket();
      else if(action==='delete-bucket')confirmAction('Удалить бакет?',`Бакет «${target.dataset.bucket}» будет удалён. Удалить можно только пустой бакет.`, 'Удалить бакет',async()=>{await api('/api/buckets/'+encodeURIComponent(target.dataset.bucket),{method:'DELETE'});toast('Бакет удалён');loadPage();});
      else if(action==='delete-object'){const bucket=state.bucket,key=target.dataset.key;confirmAction('Удалить объект?',`Объект «${key}» будет удалён без возможности восстановления из панели. Это действие затрагивает все его реплики.`, 'Удалить объект',async()=>{await api('/api/object?'+new URLSearchParams({bucket,key}),{method:'DELETE'});toast('Объект удалён');loadPage();});}
      else if(action==='share-object')await shareObject(target.dataset.key);
      else if(action==='revoke-share'){
        target.disabled=true;
        try{
          await api('/api/shares/'+encodeURIComponent(target.dataset.id),{method:'DELETE'});
          const list=target.closest('#share-list');target.closest('[data-share-id]')?.remove();
          if(list&&!list.querySelector('[data-share-id]'))list.innerHTML=shareList([]);
          const result=$('#share-result');if(result?.dataset.shareId===target.dataset.id){result.innerHTML='<div class="notice section-gap" role="status">Ссылка отозвана и больше не открывается.</div>';delete result.dataset.shareId;}
          toast('Ссылка отозвана');
        }finally{target.disabled=false;}
      }
      else if(action==='choose-files')$('#upload-files')?.click();
      else if(action==='next-objects')location.hash='#objects?'+new URLSearchParams({bucket:state.bucket,prefix:state.prefix,continuationToken:target.dataset.token});
      else if(action==='add-node'){const list=$('#nodes-form');list.insertAdjacentHTML('beforeend',nodeFields({id:'node-'+(Date.now().toString(36)),label:'Новый узел',url:''},Date.now()));$('input',list.lastElementChild)?.focus();}
      else if(action==='remove-node'){if($$('[data-node]').length<=1)throw new Error('В конфигурации нужен хотя бы один узел.');target.closest('[data-node]').remove();}
      else if(action==='new-key')await newKey();
      else if(action==='revoke-key')confirmAction('Отозвать ключ доступа?',`Приложение «${target.dataset.label}» сразу потеряет доступ по этому ключу. Восстановить отозванный ключ нельзя.`, 'Отозвать ключ',async()=>{await api('/api/keys/'+encodeURIComponent(target.dataset.id),{method:'DELETE'});toast('Ключ отозван');loadPage();});
      else if(action==='scrub'){
        target.disabled=true;const original=target.innerHTML;target.textContent='Проверка выполняется…';
        try{const r=await api('/api/scrub',{method:'POST',body:{}});const failed=Number(r.unrecoverable||0)+Number(r.repairFailed||0)+Number(r.failed||0)+Number(r.garbage?.failed||0);const result=$('#scrub-result');if(result)result.innerHTML=`<div class="notice ${failed?'warn':''} section-gap" role="status">${icon('shield')}<div><strong>Проверка завершена</strong><p>Проверено: ${number(r.checked)} · Восстановлено: ${number(r.repaired)} · Ошибок: ${number(failed)}${r.garbage?` · Удалено устаревших копий: ${number(r.garbage.removed)}`:''}</p>${failed?'<p>Не все объекты удалось восстановить. Проверьте доступность узлов и внешние резервные копии.</p>':''}</div></div>`;toast(failed?'Проверка завершена с ошибками':'Проверка завершена',Boolean(failed));}finally{target.disabled=false;target.innerHTML=original;}
      }
      else if(action==='cancel-uploads')stopUploads();
      else if(action==='close-uploads'){state.uploads=[];renderQueue();}
      else if(action==='logout'){
        const leave=async()=>{await api('/api/logout',{method:'POST',body:{}});state.user=null;state.csrf=null;stopUploads();state.uploads=[];await init();};
        if(state.uploads.some(u=>['queued','uploading'].includes(u.status)))confirmAction('Выйти и остановить загрузки?','В очереди есть незавершённые загрузки. Выход остановит их. Уже сохранённые объекты останутся в хранилище.','Выйти',leave);else await leave();
      }
    }catch(error){toast(error.message,true);}
  });
  document.addEventListener('input',event=>{
    if(event.target.id==='overview-bucket-search'){const query=event.target.value.toLowerCase();const matches=state.data.filter(b=>b.name.toLowerCase().includes(query));$('#overview-bucket-results').innerHTML=matches.length?bucketTable(matches.slice(0,5),true):'<div class="empty"><h3>Бакеты не найдены</h3><p>Попробуйте другое название.</p></div>';}
    if(event.target.id==='bucket-search'){const query=event.target.value.toLowerCase();$('#bucket-results').innerHTML=bucketTable(state.data.filter(b=>b.name.toLowerCase().includes(query)));}
    if(event.target.id==='wiki-search'){const query=event.target.value.toLocaleLowerCase('ru');$('#wiki-results').innerHTML=wikiResults(wiki.filter(w=>`${w.title} ${w.body.replace(/<[^>]*>/g,' ')}`.toLocaleLowerCase('ru').includes(query)));}
  });
  document.addEventListener('change',event=>{if(event.target.id==='all-buckets')$('#key-bucket-list').classList.toggle('hidden',event.target.checked);});
  document.addEventListener('submit',async event=>{
    const form=event.target;
    if(form.id==='auth-form'){
      event.preventDefault();await submit(form,$('#auth-error'),async()=>{const fd=new FormData(form);const body={username:fd.get('username'),password:fd.get('password')};if(state.setupTokenRequired)body.setupToken=fd.get('setupToken');const result=await api('/api/login',{method:'POST',body});state.user=result.user||{username:body.username};state.csrf=result.csrf;state.defaultCredentials=Boolean(result.defaultCredentials);route();});
    }else if(form.id==='prefix-form'){event.preventDefault();location.hash='#objects?'+new URLSearchParams({bucket:state.bucket,prefix:new FormData(form).get('prefix')});}
    else if(form.id==='topology-form'){
      event.preventDefault();await submit(form,$('#topology-error'),async()=>{
        const mode=new FormData(form).get('mode');const nodes=$$('[data-node]',form).map(row=>{const node={id:$('[name=nodeId]',row).value.trim(),label:$('[name=nodeLabel]',row).value.trim(),url:$('[name=nodeUrl]',row).value.trim()};const token=$('[name=nodeToken]',row).value;if(token)node.token=token;return node;});
        if(new Set(nodes.map(n=>n.id)).size!==nodes.length)throw new Error('ID каждого узла должен быть уникальным.');
        if(mode==='raid1'&&nodes.length<2)throw new Error('Для RAID 1 нужно минимум 2 узла.');
        if(mode==='raid10'&&(nodes.length<4||nodes.length%2!==0))throw new Error('Для RAID 10 нужно чётное количество узлов, минимум 4.');
        const migrate=Number(state.status?.objectCount)>0;
        if(migrate&&!$('#migration-consent')?.checked)throw new Error('Подтвердите перенос существующих объектов.');
        const progress=$('#migration-progress');progress.textContent=migrate?'Перенос запущен. Не отключайте узлы.':'Проверяем и сохраняем конфигурацию…';
        let polling=false;
        const timer=setInterval(async()=>{if(polling)return;polling=true;try{const current=await api('/api/status');if(progress.isConnected&&current.migration?.active){progress.textContent='Перенос объектов: '+number(current.migration.completed)+' из '+number(current.migration.total)+'. Фиксация новых записей ожидает завершения.';}}catch{}finally{polling=false;}},2000);
        try{const result=await api('/api/topology',{method:'PUT',body:{mode,nodes,migrate}});toast(result.migrated?'Топология сохранена, объекты перенесены':'Топология сохранена');loadPage();}finally{clearInterval(timer);if(progress.isConnected)progress.textContent='';}
      });
    }else if(form.id==='settings-form'){
      event.preventDefault();await submit(form,$('#settings-error'),async()=>{const fd=new FormData(form);const interval=Number(fd.get('scrubIntervalSeconds'));if(interval!==0&&interval<60)throw new Error('Интервал проверки должен быть 0 или не меньше 60 секунд.');await api('/api/settings',{method:'PUT',body:{cacheBytes:Number(fd.get('cacheMB'))*1048576,concurrency:Number(fd.get('concurrency')),scrubIntervalSeconds:Number(fd.get('scrubIntervalSeconds'))}});toast('Настройки сохранены');});
    }else if(form.id==='password-form'){
      event.preventDefault();await submit(form,$('#password-error'),async()=>{const fd=new FormData(form);if(fd.get('password')!==fd.get('repeatPassword'))throw new Error('Новые пароли не совпадают.');const result=await api('/api/password',{method:'PUT',body:{currentPassword:fd.get('currentPassword'),password:fd.get('password')}});state.csrf=result.csrf;state.user=result.user;state.defaultCredentials=false;state.setupTokenRequired=false;form.reset();toast('Пароль администратора изменён');loadPage();});
    }
  });
  $('#dialog').addEventListener('close',()=>{if(!$('#dialog').open)$('#dialog').innerHTML='';});
  window.addEventListener('hashchange',route);
  window.addEventListener('beforeunload',event=>{if(state.uploads.some(u=>['queued','uploading'].includes(u.status))){event.preventDefault();event.returnValue='';}});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.menu){state.menu=false;$('.shell')?.classList.remove('menu-open');$('.mobile-toggle')?.setAttribute('aria-expanded','false');}});
  async function init(){
    try{const session=await api('/api/session');state.defaultCredentials=Boolean(session.defaultCredentials);state.setupTokenRequired=Boolean(session.setupTokenRequired);if(session.authenticated){state.user=session.user||{username:'Администратор'};state.csrf=session.csrf;route();}else renderAuth();}
    catch(error){$('#app').innerHTML=`<main id="main" class="initial-loader"><span class="brand-mark" aria-hidden="true"><img src="/console/storage-mark.svg" alt="" width="48" height="48"></span>${errorBlock(error,false)}<button class="button" id="retry-connection">Повторить подключение</button></main>`;$('#retry-connection').addEventListener('click',init);}
  }
  init();
})();

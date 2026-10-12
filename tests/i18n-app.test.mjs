import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { t, setLanguage, getLanguage, locale } from '../web/i18n.js';
import { appTranslations } from '../web/i18n-app.js';
import { serverText } from '../web/i18n-server.js';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');

function renderHarness() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', addEventListener() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({
    t, setLanguage, getLanguage, locale, serverText, Intl, URLSearchParams,
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {}, documentElement: {} },
    window: { addEventListener() {} },
    location: { origin: 'https://storage.example.test', protocol: 'https:', hostname: 'storage.example.test', hash: '#overview' },
  });
  const body = source.replace(/^import .*;\n/gm, '');
  const entry = body.lastIndexOf("  import('/console/features.js')");
  assert.ok(entry > 0, 'Find the application bootstrap without executing network requests');
  new vm.Script(body.slice(0, entry) + `
    globalThis.app = { state, shell, bytes, number, date, duration, renderOverview, renderBuckets,
      renderObjects, renderCluster, renderKeys, renderSettings, renderWiki, renderAuth, wiki };
  })();`).runInContext(context);
  return { ...context.app, elements };
}

test('every explicit application message has an English translation with the same placeholders', () => {
  const messages = [...source.matchAll(/\bt\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)]
    .map(match => vm.runInNewContext(match[1]));
  for (const message of messages) {
    assert.ok(Object.hasOwn(appTranslations, message), `Missing English translation: ${message}`);
    assert.doesNotMatch(appTranslations[message], /[А-Яа-яЁё]/, message);
    const parameters = text => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(parameters(appTranslations[message]), parameters(message), `Placeholder mismatch: ${message}`);
  }
  assert.ok(messages.length > 400, 'Cover full app and wiki, not only the main navigation');
});

test('all main screens and wiki render English and switch back to Russian at render time', testContext => {
  testContext.after(() => setLanguage('en'));
  const app = renderHarness();
  const status = { mode: 'raid0', nodes: [{ id: 'local', label: 'Coordinator storage', url: 'local', online: true, capacityBytes: 4096, freeBytes: 2048 }], objectCount: 1, totalBytes: 8,
    cache: { bytes: 0, limit: 1024, hits: 0, misses: 0 }, queue: { active: 0, pending: 0, concurrency: 4, limit: 32 }, version: '0.3.1', uptime: 3650, endpoint: 'https://storage.example.test', security: { secureCookies: true }, limitations: [] };
  const bucket = { name: 'demo', createdAt: '2026-10-12T10:00:00Z', objects: 1, bytes: 8 };
  Object.assign(app.state, { user: 'admin', role: 'admin', status, bucket: 'demo', data: { objects: [] } });
  const screens = () => [
    app.renderOverview(status, [bucket]), app.renderBuckets([bucket]), app.renderBuckets([]),
    app.renderObjects({ objects: [], commonPrefixes: [] }),
    app.renderCluster({ mode: 'raid0', nodes: status.nodes }, status), app.renderKeys([]),
    app.renderSettings({ cacheBytes: 1024, concurrency: 4, queueLimit: 32, maxObjectBytes: 4096 }, status, { events: [] }), app.renderWiki(),
  ];
  setLanguage('en');
  for (const html of screens()) assert.doesNotMatch(html, /[А-Яа-яЁё]/, 'English screens must not retain Russian UI text');
  app.shell(); assert.match(app.elements.get('#app').innerHTML, /Buckets and objects/);
  app.renderAuth(); assert.match(app.elements.get('#app').innerHTML, /Welcome back/);
  assert.match(app.renderWiki('recovery'), /Integrity checks and backups/);
  assert.equal(app.bytes(1024), '1 KiB'); assert.equal(app.number(1234), '1,234');
  const englishDate = app.date('2026-10-12T10:00:00Z');
  setLanguage('ru');
  assert.match(app.renderWiki(), /Проверка и резервные копии/);
  app.shell(); assert.match(app.elements.get('#app').innerHTML, /Бакеты и объекты/);
  app.renderAuth(); assert.match(app.elements.get('#app').innerHTML, /С возвращением/);
  assert.equal(app.bytes(1024), '1 КиБ'); assert.notEqual(app.number(1234), '1,234');
  assert.notEqual(app.date('2026-10-12T10:00:00Z'), englishDate);
  setLanguage('en'); assert.match(app.wiki[0].title, /First launch/);
});

test('translation never rewrites or executes bucket names, object keys, or interpolation values', testContext => {
  testContext.after(() => setLanguage('en'));
  const app = renderHarness();
  app.state.bucket = 'demo';
  const key = 'Обновить/{p1}/<script>".txt';
  setLanguage('en');
  const html = app.renderObjects({ objects: [{ key, size: 1, modifiedAt: '2026-10-12T10:00:00Z' }], commonPrefixes: [] });
  assert.match(html, /Обновить\/\{p1\}\/&lt;script&gt;&quot;\.txt/);
  assert.doesNotMatch(html, /Refresh\/|<script>/);
  assert.equal(t('Бакет {p0} создан', { p0: key }), `Bucket ${key} created`);
  setLanguage('ru'); assert.equal(t('Бакет {p0} создан', { p0: key }), `Бакет ${key} создан`);
});

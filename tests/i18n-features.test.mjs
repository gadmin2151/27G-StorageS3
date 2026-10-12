import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatures, settingsHaveDrafts } from '../web/features.js';
import { setLanguage, t } from '../web/i18n.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fixture(t, role = 'viewer') {
  const previousDocument = globalThis.document, previousStorage = globalThis.localStorage;
  const listeners = new Map(), fragments = [];
  globalThis.document = { documentElement: {}, addEventListener(type, handler) { listeners.set(type, handler); } };
  globalThis.localStorage = { getItem() { return '[]'; }, setItem() {} };
  t.after(() => { globalThis.document = previousDocument; globalThis.localStorage = previousStorage; setLanguage('en'); });
  const state = { user: 'operator', role, page: 'settings', uploads: [], bucket: 'demo', prefix: '', uploadConcurrency: 2 };
  const host = { isConnected: true, insertAdjacentHTML(_, value) { fragments.push(value); } };
  const context = {
    state, esc, $: selector => selector === '.settings-layout .stack' ? host : null, $$: () => [],
    icon: () => '', button: (label, action) => `<button data-action="${action}">${esc(label)}</button>`,
    bytes: value => `${value ?? 0} B`, number: value => String(value ?? 0), date: value => String(value), duration: String,
    heading: (title, description = '', actions = '') => `<h1>${esc(title)}</h1><p>${esc(description)}</p>${actions}`,
    toast() {}, openDialog() {}, confirmAction() {}, submit() {}, loadPage() {}, init() {}, wiki: [],
    async api(path) {
      if (path === '/api/mfa') return { enabled: false };
      if (path === '/api/settings') return { publicOrigin: '', corsOrigins: [] };
      if (path === '/api/users') return { users: [{ username: 'sample-user', role: 'viewer', enabled: true, quotaBytes: null, quotaObjects: null, usage: { bytes: 8, objects: 1 } }] };
      if (path === '/api/uploads') return { uploads: [{ uploadId: 'part-test', bucket: 'demo', key: 'Обновить/<private>.txt', owner: 'operator', size: 8 }] };
      if (path === '/api/monitor') return { metrics: {}, alerts: [], nodes: [], settings: {} };
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  return { features: createFeatures(context), state, fragments, listeners, context };
}

test('feature pages switch languages at render time for every role without changing uploaded names', async testContext => {
  const f = fixture(testContext);
  setLanguage('en');
  for (const page of ['users', 'monitoring', 'settings']) {
    const html = await f.features.page(page);
    assert.doesNotMatch(html.replace(/<option[^>]*lang="ru"[^>]*>Русский<\/option>/g, ''), /[А-Яа-яЁё]/, `${page} must render English labels`);
  }
  const englishSettings = await f.features.page('settings');
  assert.match(englishSettings, /Interface language/); assert.match(englishSettings, /name="language"/); assert.match(englishSettings, /value="en" selected/);
  f.state.page = 'uploads';
  const englishUploads = await f.features.page('uploads');
  assert.match(englishUploads, /Обновить\/&lt;private&gt;\.txt/); assert.doesNotMatch(englishUploads, /Refresh\/&lt;private&gt;/); assert.match(englishUploads, /Paused/);
  setLanguage('ru');
  const russianUploads = await f.features.page('uploads');
  assert.match(russianUploads, /Приостановлено/); assert.match(russianUploads, /Обновить\/&lt;private&gt;\.txt/);
  assert.match(await f.features.page('users'), /Наблюдатель/);
  assert.match(await f.features.page('settings'), /value="ru" selected/);
  setLanguage('en');
  assert.match(await f.features.page('users'), /Viewer/);
  assert.equal(t('УДАЛИТЬ'), 'DELETE'); setLanguage('ru'); assert.equal(t('УДАЛИТЬ'), 'УДАЛИТЬ');
});

test('administrator and operator settings both expose personal language preference', async testContext => {
  const f = fixture(testContext, 'admin'); setLanguage('en');
  await f.features.afterRender('settings');
  const adminHtml = f.fragments.join(''); assert.match(adminHtml, /id="language-settings"/); assert.match(adminHtml, /Interface language/); assert.doesNotMatch(adminHtml.replace(/<option[^>]*lang="ru"[^>]*>Русский<\/option>/g, ''), /[А-Яа-яЁё]/);
  f.state.role = 'operator'; assert.equal(f.features.hasPage('settings'), true);
  assert.match(await f.features.page('settings'), /id="language-settings"/);
  const injected = t('Файл «{p0}» сохранён', { p0: 'Обновить {p1} <script>' });
  assert.equal(injected, 'File “Обновить {p1} <script>” saved', 'Interpolation must preserve the original file name without translating it or recursively replacing placeholders');
});


test('language changes detect unsaved settings without modifying field values', () => {
  const input = { tagName: 'INPUT', type: 'number', value: '128', defaultValue: '64' };
  const form = { id: 'settings-form', dataset: {}, elements: [input] };
  assert.equal(settingsHaveDrafts([form]), true); assert.equal(input.value, '128');
  input.defaultValue = input.value; assert.equal(settingsHaveDrafts([form]), false);
  form.dataset.pending = 'true'; assert.equal(settingsHaveDrafts([form]), true);
  assert.equal(settingsHaveDrafts([{ ...form, id: 'language-settings' }]), false);
  const password = { tagName: 'INPUT', type: 'password', value: 'unsaved-password', defaultValue: '' };
  assert.equal(settingsHaveDrafts([{ id: 'password-form', dataset: {}, elements: [password] }]), true); assert.equal(password.value, 'unsaved-password');
});

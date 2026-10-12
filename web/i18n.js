// Only explicitly registered, static interface messages are translated.
// User content is never inspected or rewritten by this module.
const english = new Map();
let language = 'en';

export function registerTranslations(messages) {
  for (const [source, translation] of Object.entries(messages)) {
    if (typeof translation !== 'string') throw new TypeError('Translations must be strings');
    english.set(source, translation);
  }
}

export function getLanguage() { return language; }
export function locale() { return language === 'ru' ? 'ru-RU' : 'en-US'; }
export function setLanguage(value) {
  language = value === 'ru' ? 'ru' : 'en';
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = language;
  return language;
}

export function t(source, parameters = {}) {
  const message = language === 'en' ? english.get(source) ?? source : source;
  return String(message).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key) =>
    Object.hasOwn(parameters, key) ? String(parameters[key] ?? '') : placeholder);
}

#!/usr/bin/env node
// Generate two independent, pipe-safe installers from one implementation.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let check = false, ref;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') check = true;
  else if (args[i] === '--ref' && args[i + 1]) ref = args[++i];
  else throw new Error('Usage: generate-installers.mjs [--check [--ref GIT_REF]]');
}
if (ref && !check) throw new Error('--ref requires --check. Generated files always come from the working tree.');
const commit = ref && execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const read = path => commit ? Promise.resolve(execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })) : readFile(resolve(root, path), 'utf8');
const template = await read('scripts/installer.template');
const translations = JSON.parse(await read('scripts/installer-translations.json'));
const keys = Object.keys(translations).sort((a, b) => b.length - a.length);
for (const key of keys) {
  if (!template.includes(key) || typeof translations[key] !== 'string' || !translations[key]) throw new Error(`Unused or invalid installer translation: ${key}`);
}
const pattern = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
const notice = 'Generated from scripts/installer.template and installer-translations.json. Run node scripts/generate-installers.mjs after editing either source.';
const editions = [
  { file: 'install.sh', language: 'English', code: 'en', ok: 'Continue', cancel: 'Cancel', yes: 'Yes', no: 'No', affirmative: '$answer == yes || $answer == YES || $answer == y || $answer == Y' },
  { file: 'install-ru.sh', language: 'Русский', code: 'ru', ok: 'Продолжить', cancel: 'Отмена', yes: 'Да', no: 'Нет', affirmative: '$answer == да || $answer == ДА || $answer == yes || $answer == y' }
];
for (const edition of editions) {
  let body = edition.code === 'en' ? template.replace(pattern, match => translations[match]) : template;
  const markers = { GENERATED_NOTICE: notice, LANGUAGE: edition.language, INSTALLER_FILENAME: edition.file, OK_BUTTON: edition.ok, CANCEL_BUTTON: edition.cancel, YES_BUTTON: edition.yes, NO_BUTTON: edition.no, AFFIRMATIVE_EXPRESSION: edition.affirmative };
  body = body.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    if (!(key in markers)) throw new Error(`Unknown installer marker: ${key}`);
    return markers[key];
  });
  if (edition.code === 'en' && /[А-Яа-яЁё]/.test(body)) throw new Error('Untranslated Russian text remains in the English installer.');
  if (!body.endsWith('main "$@"\n')) throw new Error('The pipe-safe main invocation must remain the final line.');
  const path = `scripts/${edition.file}`;
  if (check) {
    if (await read(path) !== body) throw new Error(`${path} is stale. Run node scripts/generate-installers.mjs.`);
  } else {
    await writeFile(resolve(root, path), body);
    await chmod(resolve(root, path), 0o755);
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${path}`);
}

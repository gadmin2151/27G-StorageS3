#!/usr/bin/env node
// Format 1: metadata shape used since 0.3. No blob traversal, copy or migration.
// Run only after the coordinator stops, with its /data volume mounted read-only.
import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const schemas = {
  'catalog.sqlite': {
    settings: 'key value', buckets: 'name created_at',
    objects: 'bucket key blob_id size etag sha256 modified_at content_type replicas generation',
    garbage: 'blob_id nodes retired_at',
    object_versions: 'seq version_id bucket key blob_id size etag sha256 modified_at content_type replicas delete_marker owner',
    multipart_uploads: 'upload_id bucket key content_type initiated owner',
    multipart_parts: 'upload_id part_number blob_id size etag sha256 modified_at replicas',
    bucket_quotas: 'bucket max_bytes max_objects', upload_reservations: 'id bucket owner bytes objects',
  },
  'auth.sqlite': {
    users: 'username password role enabled quota_bytes quota_objects mfa_secret mfa_last_step recovery_hashes',
    access_keys: 'id access_key secret label role buckets created_at owner prefixes permissions expires_at',
    audit: 'id at action detail', preferences: 'key value',
  },
  'shares.sqlite': { shares: 'id token_hash bucket object_key blob_id created_at expires_at' },
};
const integers = new Set('size retired_at seq delete_marker part_number max_bytes max_objects bytes objects enabled quota_bytes quota_objects mfa_last_step'.split(' '));
async function info(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function reject(message) { throw new Error(message); }

export async function checkStorage(dataDir) {
  const root = resolve(dataDir);
  if (!(await info(root))?.isDirectory()) reject('Не найден обычный каталог данных.');
  if (await info(join(root, 'coordinator.lock'))) reject('Координатор не завершил штатную остановку: обнаружен coordinator.lock.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.storageFormatVersion !== 1 || pkg.storageUpgradeMode !== 'none') reject('Этот проверяющий модуль поддерживает только формат 1 без миграций.');
  for (const directory of ['blobs', 'tmp']) {
    if (!(await info(join(root, directory)))?.isDirectory()) reject(`Нет обычного каталога ${directory}; автоматическое обновление остановлено.`);
  }
  const master = await info(join(root, 'master.key')), token = await info(join(root, 'setup.token'));
  if (!master?.isFile() || master.size !== 32 || !token?.isFile() || token.size < 24 || token.size > 512) reject('Служебные ключи отсутствуют или имеют неподдерживаемый формат.');
  for (const [file, tables] of Object.entries(schemas)) {
    const path = join(root, file), stat = await info(path);
    if (!stat?.isFile() || stat.size === 0) reject(`Отсутствует обычный файл ${file}.`);
    const wal = await info(path + '-wal');
    // immutable=1 deliberately avoids journal/SHM creation. A pending WAL must
    // never be ignored: only a clean, checkpointed volume can be inspected.
    if (wal && (!wal.isFile() || wal.size !== 0)) reject(`${file}: незавершённый WAL; требуется штатная остановка, автоматическое обновление отменено.`);
    const uri = pathToFileURL(path); uri.searchParams.set('immutable', '1');
    const db = new DatabaseSync(uri.href, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const actualTables = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view')").all();
      if (actualTables.some(row => row.type !== 'table' || !Object.hasOwn(tables, row.name)) || actualTables.length !== Object.keys(tables).length) reject(`${file}: неподдерживаемый набор таблиц.`);
      for (const [table, names] of Object.entries(tables)) {
        const expected = names.split(' ').sort(), columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (columns.map(c => c.name).sort().join(' ') !== expected.join(' ')) reject(`${file}/${table}: несовместимая схема; миграция не выполняется.`);
        for (const column of columns) {
          const number = integers.has(column.name) || table === 'audit' && column.name === 'id' || file === 'shares.sqlite' && ['created_at', 'expires_at'].includes(column.name);
          if (column.type.toUpperCase() !== (number ? 'INTEGER' : 'TEXT')) reject(`${file}/${table}: несовместимый тип столбца.`);
        }
      }
    } finally { db.close(); }
  }
  return { ok: true, storageFormatVersion: 1, storageUpgradeMode: 'none', version: pkg.version, objectsScanned: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) reject('Использование: node scripts/check-storage.mjs /data');
    console.log(JSON.stringify(await checkStorage(process.argv[2])));
  } catch (error) { console.error(`Проверка совместимости: ${error.message}`); process.exitCode = 1; }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Storage } from '../src/storage.mjs';
import { Auth } from '../src/auth.mjs';
import { Shares } from '../src/shares.mjs';
import { checkStorage } from '../scripts/check-storage.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), '27g-upgrade-check-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = await new Storage({ dataDir }).init();
  const auth = new Auth({ dataDir }); await auth.initializeDefaults();
  const shares = new Shares({ dataDir });
  await storage.close(); auth.close(); shares.close();
  return dataDir;
}

test('upgrade preflight reads metadata only, leaving databases and a sparse TB blob untouched', async t => {
  const dir = await fixture(t), blob = join(dir, 'blobs', 'large-object');
  const fd = await open(blob, 'wx', 0o600); await fd.truncate(1024 ** 4); await fd.close();
  const beforeBlob = await stat(blob), beforeNames = await readdir(dir);
  const files = ['catalog.sqlite', 'auth.sqlite', 'shares.sqlite', 'master.key', 'setup.token'];
  const before = await Promise.all(files.map(file => readFile(join(dir, file))));
  const result = await checkStorage(dir);
  assert.equal(result.ok, true); assert.equal(result.objectsScanned, 0);
  assert.deepEqual(await readdir(dir), beforeNames); // No WAL/SHM or auxiliary copies.
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file)))), before);
  const afterBlob = await stat(blob);
  for (const key of ['ino', 'size', 'blocks', 'mtimeMs', 'atimeMs']) assert.equal(afterBlob[key], beforeBlob[key], key);
});

test('upgrade preflight rejects a running coordinator and an uncheckpointed WAL', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'coordinator.lock'), '{}');
  await assert.rejects(checkStorage(dir), /штатную остановку/);
  await unlink(join(dir, 'coordinator.lock'));
  await writeFile(join(dir, 'catalog.sqlite-wal'), 'pending transaction');
  await assert.rejects(checkStorage(dir), /WAL/);
});

test('upgrade preflight refuses incompatible schema without repairing it', async t => {
  const dir = await fixture(t), file = join(dir, 'catalog.sqlite');
  const db = new DatabaseSync(file); db.exec('ALTER TABLE objects ADD COLUMN future_format INTEGER'); db.close();
  const before = await readFile(file);
  await assert.rejects(checkStorage(dir), /несовместимая схема/);
  assert.deepEqual(await readFile(file), before);
});

test('upgrade preflight refuses missing database or encryption key instead of initializing data', async t => {
  const dir = await fixture(t);
  await unlink(join(dir, 'master.key'));
  await assert.rejects(checkStorage(dir), /Служебные ключи/);
  assert.equal((await readdir(dir)).includes('master.key'), false);
  const other = await fixture(t); await unlink(join(other, 'shares.sqlite'));
  await assert.rejects(checkStorage(other), /shares.sqlite/);
  assert.equal((await readdir(other)).includes('shares.sqlite'), false);
});

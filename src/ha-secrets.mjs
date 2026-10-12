import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

// Called before Auth opens SQLite. Never replace an installed encryption key:
// changing it would make existing encrypted credentials unreadable.
export async function prepareHaSecrets({ dataDir, masterKeyFile, setupTokenFile }) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  for (const [source, name, validate] of [
    [masterKeyFile, 'master.key', value => value.length === 32],
    [setupTokenFile, 'setup.token', value => value.toString().trim().length >= 24 && value.length <= 512],
  ]) {
    if (!source) throw new Error(`HA requires an explicit shared ${name} secret file`);
    const desired = await readFile(source);
    if (!validate(desired)) throw new Error(`Invalid HA ${name} secret`);
    const target = join(dataDir, name);
    try {
      const installed = await readFile(target);
      if (installed.length !== desired.length || !timingSafeEqual(installed, desired))
        throw new Error(`Existing ${name} differs from shared HA secret; perform a planned migration before enabling HA`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(target, desired, { flag: 'wx', mode: 0o600, flush: true });
    }
    await chmod(target, 0o600);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareHaSecrets({ dataDir: resolve(process.env.DATA_DIR || './data'),
    masterKeyFile: process.env.HA_MASTER_KEY_FILE, setupTokenFile: process.env.HA_SETUP_TOKEN_FILE });
}

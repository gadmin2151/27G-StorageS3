import http from 'node:http';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, rename, realpath, stat, unlink, open, chmod, readdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID, randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createNodeServer } from './node.mjs';
import { syncDirectory } from './storage.mjs';

const exec = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { status: 400 });
const idPattern = /^[a-f0-9-]{36}$/;
const checkedString = (value, name, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid(`Некорректное поле ${name}.`);
  return value.trim();
};
export function hostDeviceMounted(mountInfo,identity) {
  const lines=mountInfo.trim().split('\n');if(!lines.length||!lines.every(line=>/^\d+ \d+ \d+:\d+ /.test(line)))return true;return lines.some(line=>line.split(' ')[2]===identity);
}
export function normalizeDisk(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Нужны параметры диска.');
  const kind = input.kind;
  if (!['folder', 'device', 'smb', 'nfs'].includes(kind)) throw invalid('Выберите каталог, устройство, SMB/CIFS или NFS.');
  const source = checkedString(input.source, 'источник');
  const value = { id: randomUUID(), kind, label: checkedString(input.label || source, 'название', 100), source };
  if (kind === 'folder' && (!source.startsWith('/') || source === '/')) throw invalid('Нужен абсолютный путь к выделенному каталогу.');
  if (kind === 'device' && (!/^\/dev\/[a-zA-Z0-9/_:.+-]+$/.test(source) || source.split('/').includes('..'))) throw invalid('Укажите устройство /dev/...; рекомендуется /dev/disk/by-id/....');
  if (kind === 'smb') {
    if (!/^\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._$ -]+$/.test(source)) throw invalid('SMB: укажите //server/share, без дополнительных параметров.');
    value.username = checkedString(input.username, 'пользователь SMB', 256);
    if (typeof input.password !== 'string' || !input.password.length || input.password.length > 1024 || /[\r\n\0]/.test(input.password)) throw invalid('Укажите пароль SMB без переноса строк.');
    value.password = input.password;
    value.domain = input.domain ? checkedString(input.domain, 'домен SMB', 256) : '';
    value.smbVersion = input.smbVersion || '3.1.1';
    if (!['3.1.1', '3.0'].includes(value.smbVersion)) throw invalid('Поддерживается SMB 3.1.1 или 3.0.');
  }
  if (kind === 'nfs' && !/^[a-zA-Z0-9.-]+:\/[a-zA-Z0-9/_. -]*$/.test(source)) throw invalid('NFS: укажите server:/export/path.');
  return value;
}
export function mountArguments(disk, target, credentials) {
  const safe = 'rw,nosuid,nodev,noexec';
  if (disk.kind === 'smb') return ['-t', 'cifs', '-o', `${safe},vers=${disk.smbVersion},seal,cache=strict,credentials=${credentials}`, '--', disk.source, target];
  if (disk.kind === 'nfs') return ['-t', 'nfs4', '-o', `${safe},hard,timeo=150,retrans=2`, '--', disk.source, target];
  if (disk.kind === 'device') return ['-t', disk.filesystem, '-o', safe, '--', disk.source, target];
  throw invalid('Каталог не требует mount.');
}
const safeSummary = ({ password, username, domain, token, ...disk }) => disk;
export class DiskManager {
  constructor({ dataDir, token, allowedRoots = ['/mnt', '/media', '/srv'], allowDevices = false, hostMountInfoFile = process.env.DISK_HOST_MOUNTINFO_FILE, run = exec } = {}) {
    this.dataDir = resolve(dataDir); this.token = token; this.allowedRoots = allowedRoots; this.allowDevices = allowDevices; this.hostMountInfoFile = hostMountInfoFile; this.run = run; this.disks = []; this.servers = new Map(); this.handles = new Map(); this.activeRequests = new Map(); this.lock = Promise.resolve();
    if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new Error('Disk agent token must contain at least 32 characters');
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir,0o700);
    const hostFile=join(this.dataDir,'host.id');try{this.hostId=(await readFile(hostFile,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;this.hostId=randomUUID();await writeFile(hostFile,this.hostId,{mode:0o600,flag:'wx',flush:true});await syncDirectory(this.dataDir);}
    if(!idPattern.test(this.hostId))throw new Error('Invalid disk agent identity');
    const keyFile = join(this.dataDir, 'master.key');
    try { this.key = await readFile(keyFile); } catch (error) { if (error.code !== 'ENOENT') throw error; this.key = randomBytes(32); await writeFile(keyFile, this.key, { mode: 0o600, flag: 'wx', flush: true }); }
    if (this.key.length !== 32) throw new Error('Invalid disk agent key');
    for(const name of await readdir(this.dataDir))if(/^\.smb-[a-f0-9-]{36}$/.test(name))await unlink(join(this.dataDir,name));
    await syncDirectory(this.dataDir);
    try {
      const packed = JSON.parse(await readFile(join(this.dataDir, 'disks.json'), 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(packed.iv, 'base64')); decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
      this.disks = JSON.parse(Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const disk of this.disks) try { await this.activate(disk); } catch { disk.state = 'unavailable'; }
    return this;
  }
  async save() {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.disks)), cipher.final()]);
    const temporary = join(this.dataDir, `.config-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, join(this.dataDir, 'disks.json')); await syncDirectory(this.dataDir);
  }
  async serialized(work) { let release; const previous = this.lock; this.lock = new Promise(r => { release = r; }); await previous; try { return await work(); } finally { release(); } }
  nodeToken(id) { return createHmac('sha256', this.key).update(`volume:${id}`).digest('base64url'); }
  async command(name, args) { return this.run(name, args, { timeout: 30000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } }); }
  async inventory() {
    try { const { stdout } = await this.command('lsblk', ['--json', '--paths', '--output', 'NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,UUID,MODEL']); return { devices: JSON.parse(stdout).blockdevices, allowDevices: this.allowDevices, allowedRoots: this.allowedRoots, kinds: ['folder', 'device', 'smb', 'nfs'] }; }
    catch { return { devices: [], allowDevices: this.allowDevices, allowedRoots: this.allowedRoots, kinds: ['folder', 'device', 'smb', 'nfs'], warning: 'Список блочных устройств недоступен.' }; }
  }
  async prepare(input) {
    const disk = normalizeDisk(input);
    if (disk.kind === 'folder') {
      disk.source = await realpath(disk.source);
      const allowed = await Promise.all(this.allowedRoots.map(p => realpath(p).catch(() => null)));
      if (!allowed.some(root => root && (disk.source === root || disk.source.startsWith(root + sep)))) throw invalid('Каталог находится вне разрешённых корней дискового агента.');
      if (!(await stat(disk.source)).isDirectory()) throw invalid('Это не каталог.');
    }
    if (disk.kind === 'device') await this.checkDevice(disk);
    if (this.disks.some(d => d.kind === disk.kind && d.source === disk.source)) throw invalid('Этот источник уже добавлен.');
    return disk;
  }
  async checkDevice(disk) {
      if (!this.allowDevices) throw invalid('Подключение /dev отключено в конфигурации агента. Разрешите DISK_ALLOW_BLOCK_DEVICES на выбранном сервере.');
      disk.source = await realpath(disk.source);
      if (!disk.source.startsWith('/dev/') || !(await stat(disk.source)).isBlockDevice()) throw invalid('Источник не является блочным устройством.');
      await this.checkDeviceUsage(disk);
  }
  async checkDeviceUsage(disk) {
      const { stdout } = await this.command('lsblk', ['--json', '--paths', '--output', 'NAME,TYPE,FSTYPE,MOUNTPOINTS,MAJ:MIN', '--', disk.source]);
      const item = JSON.parse(stdout).blockdevices?.[0];
      if (!item || item.children?.length || item.mountpoints?.some(Boolean)) throw invalid('Выберите свободный раздел с существующей файловой системой; занятый диск или диск с разделами не подключается.');
      if(!this.hostMountInfoFile)throw invalid('Для /dev укажите DISK_HOST_MOUNTINFO_FILE с таблицей монтирования хоста.');
      let mountInfo;try{mountInfo=await readFile(this.hostMountInfoFile,'utf8');}catch{throw invalid('Таблица монтирования хоста недоступна; подключение /dev запрещено.');}
      if(!/^\d+:\d+$/.test(item['maj:min']||'')||hostDeviceMounted(mountInfo,item['maj:min']))throw invalid('Устройство используется хостом или его состояние не удалось проверить.');
      if (!['ext4', 'xfs', 'btrfs'].includes(item.fstype)) throw invalid('Нужна существующая ext4, XFS или Btrfs. Форматирование не выполняется.');
      disk.filesystem = item.fstype;
  }
  async mountInfo(disk) {
    try {const {stdout}=await this.command('findmnt',['--json','--mountpoint',disk.target,'--output','TARGET,SOURCE,FSTYPE,ID']);const parsed=JSON.parse(stdout);if(!Array.isArray(parsed.filesystems))throw new Error('Invalid mount status');return parsed.filesystems[0]||null;}
    catch(error){if(error.code===1&&!error.stdout&&!error.stderr)return null;throw invalid('Не удалось достоверно определить точку монтирования.');}
  }
  async mounted(disk) {
    try {
      const live=await stat(disk.target);
      if(disk.deviceIdentity!==undefined&&(live.dev!==disk.deviceIdentity||disk.inodeIdentity!==undefined&&live.ino!==disk.inodeIdentity))return false;
      if(disk.kind==='folder')return disk.deviceIdentity!==undefined;
      const mount=await this.mountInfo(disk);return mount?.target===disk.target&&mount.source===disk.source&&(!disk.mountIdentity||String(mount.id)===String(disk.mountIdentity));
    }catch{return false;}
  }
  async releaseVolume(id) {
    if(this.activeRequests.get(id))throw Object.assign(new Error('Диск занят активными запросами; повторите позже.'),{status:409});
    const server=this.servers.get(id);if(server){server.close();await server.closeStorage?.();this.servers.delete(id);}for(const fd of this.handles.get(id)||[])await fd.close();this.handles.delete(id);
  }
  async activate(disk) {
    await this.releaseVolume(disk.id);
    disk.state='unavailable';
    disk.target=disk.kind==='folder'?disk.source:join(this.dataDir,'mounts',disk.id);
    if(disk.kind!=='folder'){
      await mkdir(disk.target,{recursive:true,mode:0o700});
      let existing=await this.mountInfo(disk);
      if(existing&&(existing.target!==disk.target||existing.source!==disk.source))throw invalid('Точка монтирования уже занята другим источником.');
      if(!existing){let credentials;
        try{
          // Restart/retry must recheck host use, not trust the state saved at registration.
          if(disk.kind==='device')await this.checkDevice(disk);
          if(disk.kind==='smb'){credentials=join(this.dataDir,`.smb-${randomUUID()}`);await writeFile(credentials,`username=${disk.username}\npassword=${disk.password}\ndomain=${disk.domain}\n`,{mode:0o600,flag:'wx',flush:true});}
          await this.command('mount',mountArguments(disk,disk.target,credentials));
        }catch{throw invalid('Подключение не выполнено. Проверьте источник, доступ и поддержку файловой системы на сервере.');}
        finally{if(credentials)await unlink(credentials).catch(()=>{});}
        existing=await this.mountInfo(disk);if(!existing||existing.source!==disk.source||existing.target!==disk.target)throw invalid('Не удалось подтвердить подключение файловой системы.');
      }
      disk.mountIdentity=existing.id;
      // Device numbers can change after a fresh network mount; the volume marker remains authoritative.
      delete disk.deviceIdentity;delete disk.inodeIdentity;
    }
    const handles=[];
    try{
      const target=await open(disk.target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(target);const identity=await target.stat();
      if(disk.kind==='folder'&&disk.deviceIdentity!==undefined&&(disk.deviceIdentity!==identity.dev||disk.inodeIdentity!==undefined&&disk.inodeIdentity!==identity.ino))throw invalid('Каталог или его файловая система изменились; проверьте подключение.');
      disk.deviceIdentity=identity.dev;disk.inodeIdentity=identity.ino;
      if(!await this.mounted(disk))throw invalid('Диск исчез во время подключения.');
      // All I/O is anchored to open directory descriptors. A lazy unmount or rename cannot redirect it into the underlying host directory.
      const dataPath=join(`/proc/self/fd/${target.fd}`,'.27g-storeges3');await mkdir(dataPath,{recursive:true,mode:0o700});
      const data=await open(dataPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(data);const pinned=`/proc/self/fd/${data.fd}`,ownerPath=join(pinned,'volume.id');
      try{const owner=(await readFile(ownerPath,'utf8')).trim();if(owner!==disk.id)throw invalid('Источник уже принадлежит другому узлу. Данные не изменены.');}
      catch(error){if(error.code!=='ENOENT')throw error;await writeFile(ownerPath,disk.id,{flag:'wx',mode:0o600,flush:true});}
      const probe=join(pinned,`.probe-${randomUUID()}`),file=await open(probe,'wx',0o600);try{await file.writeFile('storage-probe');await file.sync();}finally{await file.close();await unlink(probe);}await syncDirectory(pinned);
      const assertAvailable=async()=>{if(!await this.mounted(disk))throw Object.assign(new Error('Storage volume unavailable'),{status:503});};await assertAvailable();
      const server=await createNodeServer({dataDir:pinned,token:this.nodeToken(disk.id),filesystemNamespace:process.env.DISK_HOST_ID||this.hostId,assertAvailable,pinDirectories:true});
      this.handles.set(disk.id,handles);this.servers.set(disk.id,server);disk.state='ready';
    }catch(error){await Promise.all(handles.map(fd=>fd.close()));disk.state='unavailable';throw error;}
  }
  async add(input) { return this.serialized(async () => {
    const disk = await this.prepare(input); disk.state = 'pending'; this.disks.push(disk); await this.save();
    try { await this.activate(disk); } catch { disk.state = 'unavailable'; }
    await this.save(); return { ...safeSummary(disk), token: this.nodeToken(disk.id) };
  }); }
  async retry(id) { return this.serialized(async () => { const disk = this.disks.find(d => d.id === id); if (!disk) throw invalid('Диск не найден.'); await this.activate(disk); await this.save(); return { ...safeSummary(disk), token: this.nodeToken(disk.id) }; }); }
  async list() { return Promise.all(this.disks.map(async disk => ({ ...safeSummary(disk), state: await this.mounted(disk).catch(() => false) ? disk.state : 'unavailable' }))); }
  async close() { for (const id of [...this.servers.keys()]) await this.releaseVolume(id); }
}
export async function createDiskAgent(options = {}) {
  const manager = await new DiskManager(options).init();
  const json = (res, status, data) => { const body = JSON.stringify(data); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); };
  const server = http.createServer(async (req, res) => {
    try {
      const volume = /^\/volumes\/([a-f0-9-]{36})(\/.*)$/.exec(req.url || '');
      if (volume) {
        const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${manager.nodeToken(volume[1])}`);
        if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.setHeader('connection','close');return json(res,401,{error:'Unauthorized'});}
        const disk = manager.disks.find(d => d.id === volume[1]);
        if (!disk || disk.state !== 'ready' || !await manager.mounted(disk)) return json(res, 503, { error: 'Диск отключён; запись в каталог под точкой монтирования запрещена.' });
        manager.activeRequests.set(disk.id,(manager.activeRequests.get(disk.id)||0)+1);
        try { req.url=volume[2]; return await manager.servers.get(disk.id).handleRequest(req,res); }
        finally { const remaining=(manager.activeRequests.get(disk.id)||1)-1;if(remaining)manager.activeRequests.set(disk.id,remaining);else manager.activeRequests.delete(disk.id); }
      }
      const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${options.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/disks') return json(res, 200, { disks: await manager.list(), ...await manager.inventory() });
      const readBody = async () => { const parts = []; let size = 0; for await (const p of req) { size += p.length; if (size > 8192) throw invalid('Слишком большой запрос.'); parts.push(p); } try { return JSON.parse(Buffer.concat(parts)); } catch { throw invalid('Некорректный JSON.'); } };
      if (req.method === 'POST' && req.url === '/disks') return json(res, 201, await manager.add(await readBody()));
      const retry = /^\/disks\/([a-f0-9-]{36})\/retry$/.exec(req.url || '');
      if (req.method === 'POST' && retry && idPattern.test(retry[1])) return json(res, 200, await manager.retry(retry[1]));
      json(res, 404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Ошибка дискового агента.' }); else res.destroy(); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 10000;
  return { server, manager, close: async () => { await new Promise(done => server.close(done)); await manager.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = (await readFile(process.env.DISK_TOKEN_FILE || '/run/secrets/disk_token', 'utf8')).trim();
  const agent = await createDiskAgent({ dataDir: process.env.DISK_STATE_DIR || '/var/lib/storeges3-disks', token, allowedRoots: (process.env.DISK_ALLOWED_ROOTS || '/mnt,/media,/srv').split(','), allowDevices: process.env.DISK_ALLOW_BLOCK_DEVICES === 'true' });
  agent.server.listen(Number(process.env.DISK_PORT || 9200), process.env.HOST || '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await agent.close(); process.exit(0); });
}

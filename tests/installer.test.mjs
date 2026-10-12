import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, stat, readdir, symlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
const script = resolve('scripts/install.sh');
const fakeDocker = `#!/usr/bin/env python3
import sys,os,json,pathlib,re
args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps(args)+'\\n')
def exit(code=0):sys.exit(code)
def manifest():return json.loads(pathlib.Path(os.environ['INSTALLDIR'],'INSTALLATION.json').read_text())
if args==['info']:exit()
if args[:2]==['context','inspect']:print(os.getenv('DOCKER_ENDPOINT','unix:///var/run/docker.sock'));exit()
if args[:2]==['image','tag']:exit()
if args[:2]==['compose','version']:print('2.30.0');exit()
if args[:2]==['ps','-aq']:exit()
if args[:2]==['volume','inspect']:
 if pathlib.Path(os.environ['INSTALLDIR'],'INSTALLATION.json').exists(): print('[{}]');exit()
 exit(1)
if args[:2]==['network','inspect']:exit(1)
if args[0]=='pull':exit(1 if os.getenv('FAIL_PULL') else 0)
if args[0]=='build':exit()
if args[:2]==['image','inspect']:
 print('sha256:'+'a'*64 if args[3]=='{{.Id}}' else 'ghcr.io/gadmin2151/27g-storage-s3@sha256:'+'b'*64);exit()
if args[0]=='inspect':
 if '--format' in args: print(os.getenv('PREFLIGHT_HEALTH','healthy'));exit()
 m=manifest();print(json.dumps([{'Image':'sha256:'+'a'*64,'Config':{'Image':m['image'],'Labels':{'com.docker.compose.project':m['project'],'com.docker.compose.service':'app'}},'Mounts':[{'Type':'volume','Name':m['volume'],'Destination':'/data','RW':True}]}]));exit()
if args[0]=='run':
 if '/app/scripts/check-storage.mjs' in args:exit(1 if os.getenv('FAIL_CHECK') else 0)
 if any('require("/app/package.json")' in arg for arg in args): print(json.dumps({'version':os.environ['RELEASE_VERSION'][1:],'storageFormatVersion':int(os.getenv('IMAGE_FORMAT','1')),'storageUpgradeMode':'none'}));exit()
 print('c'*64);exit()
if args[0] in ('stop','rm'):exit()
if args[0]=='compose':
 if args[-4:]==['ps','-a','-q','app']:print('c'*64);exit()
 if 'up' in args:
  if os.getenv('FAIL_ROLLBACK'):exit(1)
  # Failure only for the requested upgrade, so rollback of the saved version can succeed.
  if os.getenv('FAIL_UP') and pathlib.Path(os.environ['INSTALLDIR'],'INSTALLATION.json').exists() and manifest()['version']==os.environ['RELEASE_VERSION']:exit(1)
 exit()
print('Unexpected fake docker call: '+repr(args),file=sys.stderr);exit(2)
`;
const fakeCurl = `#!/usr/bin/env python3
import sys,os,pathlib,shutil,json
args=sys.argv[1:]
with open(os.environ['CURL_CALLS'],'a') as f:f.write(json.dumps(args)+'\\n')
u=next((a for a in args if a.startswith('https://')), '')
out=args[args.index('--output')+1]
if os.getenv('FAIL_DOWNLOAD'):sys.exit(22)
if u.endswith('/releases/latest'):
 pathlib.Path(out).write_text(json.dumps({'tag_name':os.environ['RELEASE_VERSION'],'draft':False,'prerelease':False}));sys.exit(0)
if '/releases/download/'+os.environ['RELEASE_VERSION']+'/' not in u:sys.exit(22)
name=u.rsplit('/',1)[-1]
if name not in ('SHA256SUMS','27g-storage-s3-'+os.environ['RELEASE_VERSION']+'.tar.gz'):sys.exit(22)
shutil.copyfile(pathlib.Path(os.environ['RELEASE_DIR'],name),out)
`;
async function fixture(t, version = 'v0.3.1', mode = '') {
  const dir = await mkdtemp(join(tmpdir(), '27g-installer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); await mkdir(bin);
  for (const [name, body] of Object.entries({docker: fakeDocker, curl: fakeCurl, id: '#!/bin/sh\nprintf "0\\n"\n'})) {
    const file = join(bin, name); await writeFile(file, body); await chmod(file, 0o755);
  }
  const install = join(dir, 'installed');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALLDIR: install, CALLS: join(dir, 'calls'), CURL_CALLS: join(dir, 'curl-calls'), RELEASE_DIR: dir, RELEASE_VERSION: version, TERM: 'dumb' };
  await writeFile(env.CALLS, ''); await writeFile(env.CURL_CALLS, '');
  async function release(next = version, variant = mode) {
    env.RELEASE_VERSION = next;
    await exec('python3', ['-c', `import io,json,tarfile,hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]);version=sys.argv[2];mode=sys.argv[3];prefix='27g-storage-s3-'+version
name=prefix+'.tar.gz';archive=root/name
files={'package.json':json.dumps({'version':version[1:],'storageFormatVersion':2 if mode=='incompatible' else 1,'storageUpgradeMode':'none'}),'Dockerfile':'FROM scratch','Dockerfile.disk-agent':'FROM scratch','src/server.mjs':'// fixture','web/index.html':'fixture','scripts/install-agent.sh':'#!/bin/sh','scripts/check-storage.mjs':'// readonly fixture'}
if mode=='traversal':files['../outside']='danger'
with tarfile.open(archive,'w:gz') as tar:
 for path,body in files.items():
  data=body.encode();info=tarfile.TarInfo(prefix+'/'+path);info.size=len(data);tar.addfile(info,io.BytesIO(data))
 if mode=='symlink':
  info=tarfile.TarInfo(prefix+'/src/link');info.type=tarfile.SYMTYPE;info.linkname='/etc';tar.addfile(info)
 if mode=='duplicate':
  info=tarfile.TarInfo(prefix+'/package.json');data=b'{}';info.size=len(data);tar.addfile(info,io.BytesIO(data))
digest='0'*64 if mode=='checksum' else hashlib.sha256(archive.read_bytes()).hexdigest()
(root/'SHA256SUMS').write_text(digest+'  '+name+'\\n')
`, dir, next, variant]);
  }
  await release();
  async function run(args = [], extra = {}) {
    try { const result = await exec('bash', [script, '--yes', '--version', env.RELEASE_VERSION, '--directory', install, ...args], {env: {...env, ...extra}}); return {...result, code: 0}; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  }
  async function calls() { return (await readFile(env.CALLS, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  return { dir, env, install, release, run, calls };
}

test('installer verifies release, pins GHCR digest and renders an isolated persistent Compose', async t => {
  const f = await fixture(t);
  const result = await f.run(['--port','9234','--bind','0.0.0.0','--public-origin','https://storage.example.com']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(f.install, 'INSTALLATION.json')));
  assert.equal(manifest.version,'v0.3.1'); assert.equal(manifest.port,9234); assert.equal(manifest.storageFormatVersion,1);
  assert.equal(manifest.image, 'ghcr.io/gadmin2151/27g-storage-s3@sha256:'+'b'.repeat(64));
  const compose = await readFile(join(f.install,'compose.yaml'),'utf8');
  assert.match(compose,/0\.0\.0\.0:9234:9000/); assert.match(compose,/read_only: true/); assert.match(compose,/no-new-privileges:true/);
  assert.match(compose,new RegExp(`name: ${manifest.volume}`)); assert.match(compose,/pull_policy: never/);
  assert.equal((await stat(join(f.install,'INSTALLATION.json'))).mode & 0o777, 0o640);
  const calls = await f.calls();
  assert.equal(calls.some(a=>a.includes('exec') || a.includes('logs')),false,'initial setup token is not fetched or logged');
  assert.equal(calls.some(a=>a.includes('--name') && a.includes('--tmpfs') && !a.includes('--publish')),true);
  assert.match(result.stderr,/cat \/data\/setup.token/);
});

test('unsafe archives, checksum mismatches and failed downloads never call Docker or create installation', async t => {
  for (const variant of ['checksum','traversal','symlink','duplicate','incompatible','download']) {
    const f = await fixture(t,'v0.3.1',variant);
    const result = await f.run([], variant==='download' ? {FAIL_DOWNLOAD:'1'} : {});
    assert.notEqual(result.code,0,variant);
    assert.deepEqual(await f.calls(),[],variant);
    await assert.rejects(stat(f.install),{code:'ENOENT'});
  }
});

test('new install requires explicit local-build choice after GHCR failure and validates actual image metadata', async t => {
  const f = await fixture(t);
  assert.notEqual((await f.run([],{FAIL_PULL:'1'})).code,0);
  await assert.rejects(stat(f.install),{code:'ENOENT'});
  assert.notEqual((await f.run(['--build'],{IMAGE_FORMAT:'2'})).code,0);
  await assert.rejects(stat(f.install),{code:'ENOENT'});
  assert.equal((await f.run(['--build'])).code,0);
  assert.equal((await f.calls()).some(a=>a[0]==='build'),true);
});

test('installer rejects unmanaged directories, symlink ancestors and unsafe options', async t => {
  const f = await fixture(t);
  await mkdir(f.install); await writeFile(join(f.install,'keep'),'unchanged');
  assert.notEqual((await f.run()).code,0);
  assert.equal(await readFile(join(f.install,'keep'),'utf8'),'unchanged');
  assert.deepEqual(await f.calls(),[]);
  await rm(f.install,{recursive:true});
  for (const args of [['--directory','/etc/27g'],['--port','123;touch'],['--public-origin','https://host/path'],['--bind','$(id)'],['--update']]) {
    assert.notEqual((await f.run(args)).code,0,args.join(' '));
  }
  assert.deepEqual(await f.calls(),[]);
});

test('compatible update keeps exact volume and settings, saves configuration only, and checks data read-only', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['--build','--port','9228','--public-origin','https://s3.example.com'])).code,0);
  const before = JSON.parse(await readFile(join(f.install,'INSTALLATION.json')));
  const beforeCompose = await readFile(join(f.install,'compose.yaml'),'utf8');
  await f.release('v0.3.2'); await writeFile(f.env.CALLS,'');
  const result = await f.run(['--build','--update']);
  assert.equal(result.code,0,result.stderr);
  const after = JSON.parse(await readFile(join(f.install,'INSTALLATION.json')));
  for (const key of ['volume','project','port','bind','publicOrigin']) assert.equal(after[key],before[key],key);
  assert.equal(after.version,'v0.3.2');
  assert.equal((await readFile(join(f.install,'compose.yaml'),'utf8')).replace(after.image,before.image),beforeCompose,'only image changes');
  const calls=await f.calls();
  assert.ok(calls.find(a=>a.includes('/app/scripts/check-storage.mjs') && a.includes(`type=volume,source=${before.volume},target=/data,readonly`)));
  assert.equal(calls.some(a=>a.includes('volume') && ['create','rm','prune'].includes(a[1])),false);
  assert.equal(calls.some(a=>a.includes('down')||a.includes('cp')||a.some(v=>v.includes('cpSync'))),false);
  const backups=await readdir(join(f.install,'backups')); assert.equal(backups.length,1);
  assert.deepEqual((await readdir(join(f.install,'backups',backups[0]))).sort(),['INSTALLATION.json','compose.yaml','old-image-id']);
  await assert.rejects(stat(join(f.install,'update-state.json')),{code:'ENOENT'});
});

test('updates reject incompatible versions and edited configurations before stopping; same version is a no-op', async t => {
  const f=await fixture(t); assert.equal((await f.run(['--build'])).code,0);
  await writeFile(f.env.CALLS,'');
  assert.equal((await f.run(['--update'])).code,0);
  assert.deepEqual(await f.calls(),[]);
  for (const [version,variant] of [['v0.3.0',''],['v0.3.2','incompatible']]) {
    await f.release(version,variant); assert.notEqual((await f.run(['--update'])).code,0);
    assert.deepEqual(await f.calls(),[]);
  }
  await f.release('v0.3.2');
  assert.notEqual((await f.run()).code,0,'--yes update needs --update');
  assert.notEqual((await f.run(['--update','--port','9333'])).code,0);
  await writeFile(join(f.install,'compose.yaml'),'modified');
  assert.notEqual((await f.run(['--update'])).code,0);
  assert.deepEqual(await f.calls(),[]);
});

test('failed read-only upgrade check or new health check restores old image/config with unchanged volume', async t => {
  for (const extra of [{FAIL_CHECK:'1'},{FAIL_UP:'1'}]) {
    const f=await fixture(t); assert.equal((await f.run(['--build'])).code,0);
    const before=await readFile(join(f.install,'INSTALLATION.json'),'utf8');
    const compose=await readFile(join(f.install,'compose.yaml'),'utf8');
    await f.release('v0.3.2');
    const result=await f.run(['--update','--build'],extra);
    assert.notEqual(result.code,0); assert.match(result.stderr,/Прежний образ запущен/);
    assert.equal(await readFile(join(f.install,'INSTALLATION.json'),'utf8'),before);
    assert.equal(await readFile(join(f.install,'compose.yaml'),'utf8'),compose);
    await assert.rejects(stat(join(f.install,'update-state.json')),{code:'ENOENT'});
    assert.equal((await f.calls()).some(a=>a.includes('down') || a.includes('-v') || a.includes('cp')),false);
  }
});

test('remote Docker contexts and new-image preflight failures never stop the old server', async t => {
  const f=await fixture(t); assert.equal((await f.run(['--build'])).code,0);
  await f.release('v0.3.2');
  for (const extra of [{DOCKER_ENDPOINT:'tcp://remote:2375'},{DOCKER_HOST:'ssh://remote'},{PREFLIGHT_HEALTH:'unhealthy'}]) {
    await writeFile(f.env.CALLS,'');
    const result=await f.run(['--update','--build'],extra); assert.notEqual(result.code,0);
    assert.equal((await f.calls()).some(a=>a[0]==='compose' && a.includes('stop')),false);
    assert.equal(JSON.parse(await readFile(join(f.install,'INSTALLATION.json'))).version,'v0.3.1');
  }
});

test('exclusive lock and interrupted-update marker prevent concurrent changes', async t => {
  const f=await fixture(t); assert.equal((await f.run(['--build'])).code,0);
  await f.release('v0.3.2'); await writeFile(f.env.CALLS,'');
  const lock=f.install+'.installer-lock'; await mkdir(lock);
  assert.notEqual((await f.run(['--update'])).code,0);
  assert.equal((await stat(lock)).isDirectory(),true,'foreign lock is never removed');
  assert.deepEqual(await f.calls(),[]); await rm(lock,{recursive:true});
  await writeFile(join(f.install,'update-state.json'),'{}');
  assert.notEqual((await f.run(['--update'])).code,0);
  assert.deepEqual(await f.calls(),[]);
});

test('failed rollback retains recoverable state and never removes volume', async t => {
  const f=await fixture(t); assert.equal((await f.run(['--build'])).code,0);
  await f.release('v0.3.2');
  const result=await f.run(['--update','--build'],{FAIL_ROLLBACK:'1'});
  assert.notEqual(result.code,0); assert.match(result.stderr,/Автоматический запуск прежнего образа не удался/);
  const marker=JSON.parse(await readFile(join(f.install,'update-state.json')));
  assert.equal(marker.newVersion,'v0.3.2'); assert.equal(marker.oldVersion,'v0.3.1');
  assert.equal((await f.calls()).some(a=>a[0]==='volume' && a[1]==='rm'),false);
  assert.equal(JSON.parse(await readFile(join(f.install,'INSTALLATION.json'))).version,'v0.3.1');
});

test('symlink paths are rejected and latest release is resolved to a fixed version', async t => {
  const f=await fixture(t); const link=join(f.dir,'alias'); await symlink(f.dir,link);
  assert.notEqual((await f.run(['--directory',join(link,'installed')])).code,0);
  assert.deepEqual(await f.calls(),[]);
  const result=await f.run(['--version','latest','--build']); assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(await readFile(join(f.install,'INSTALLATION.json'))).version,'v0.3.1');
});

test('truncated curl pipe cannot perform a partial installation', async t => {
  const f=await fixture(t); const body=await readFile(script,'utf8');
  const child=spawn('bash',['-s','--','--yes','--version','v0.3.1','--directory',f.install],{env:f.env,stdio:['pipe','ignore','ignore']});
  child.stdin.end(body.slice(0,body.indexOf('finished=true\nif $updating')));
  await new Promise(resolve=>child.on('exit',resolve));
  assert.deepEqual(await f.calls(),[]);
  await assert.rejects(stat(f.install),{code:'ENOENT'});
});

test('curl-pipe text dialog reads from controlling TTY and leaves script stdin untouched', async t => {
  const f=await fixture(t);
  const program = `import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
def session():
 os.setsid()
 import fcntl,termios
 fcntl.ioctl(slave,termios.TIOCSCTTY,0)
p=subprocess.Popen(['bash','-c','cat "$1" | bash -s -- --version v0.3.1 --directory "$2"','installer-pipe',sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,preexec_fn=session,close_fds=True)
os.close(slave);output=b'';answers=[b'\\n',b'\\n',b'\\n',b'\\n',b'yes\\n'];sent=0;deadline=time.monotonic()+20
while time.monotonic()<deadline:
 ready,_,_=select.select([master],[],[],.1)
 if ready:
  try:chunk=os.read(master,65536)
  except OSError:break
  output+=chunk
  if (b']: ' in chunk or b'[yes' in chunk or 'Продолжить?'.encode() in chunk) and sent<len(answers):os.write(master,answers[sent]);sent+=1
 if p.poll() is not None:break
if p.poll() is None:p.kill();p.wait();print(output.decode(errors='replace'));raise SystemExit('TTY timeout')
print(output.decode(errors='replace'));raise SystemExit(p.returncode)
`;
  const result=await exec('python3',['-c',program,script,f.install],{env:f.env,timeout:25000,maxBuffer:1024*1024});
  assert.match(result.stdout,/Продолжить/);
  assert.equal(JSON.parse(await readFile(join(f.install,'INSTALLATION.json'))).version,'v0.3.1');
});

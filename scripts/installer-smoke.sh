#!/usr/bin/env bash
# CI-only fixture transport. Docker, Compose, installed app and update logic are real.
# Run as root on a disposable runner; the published installer has no test bypasses.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run installer-smoke.sh as root on a disposable CI runner.' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
chmod 700 "$work"
installation="$work/installation"
project="27g-storage-s3-$(printf '%s' "$installation" | sha256sum | cut -c1-12)"
volume="${project}_data"
cleanup() {
  status=$?
  if [[ -f $installation/compose.yaml ]]; then docker compose -f "$installation/compose.yaml" down --timeout 40 >/dev/null 2>&1 || true; fi
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
current="v$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$root/package.json")"
next=$(python3 - "$current" <<'PY'
import sys
major,minor,patch=map(int,sys.argv[1][1:].split('.'))
print(f'v{major}.{minor}.{patch+1}')
PY
)
incompatible=$(python3 - "$current" <<'PY'
import sys
major,minor,patch=map(int,sys.argv[1][1:].split('.'))
print(f'v{major}.{minor}.{patch+2}')
PY
)
mkdir -p "$work/releases/$current" "$work/bin" "$work/source"
bash "$root/scripts/build-release.sh" "$current" "$work/releases/$current"
tar -xzf "$work/releases/$current/27g-storage-s3-$current.tar.gz" -C "$work/source" --strip-components=1
python3 - "$work" "$current" "$next" "$incompatible" <<'PY'
import hashlib,json,pathlib,sys,tarfile
base=pathlib.Path(sys.argv[1]); source=base/'source'; current,next_,bad=sys.argv[2:]
package=source/'package.json'; original=json.loads(package.read_text())
for version,incompatible in [(next_,False),(bad,True)]:
    data=dict(original,version=version[1:])
    if incompatible: data['storageFormatVersion']=original['storageFormatVersion']+1
    package.write_text(json.dumps(data,indent=2)+'\n')
    destination=base/'releases'/version; destination.mkdir()
    archive=destination/f'27g-storage-s3-{version}.tar.gz'
    with tarfile.open(archive,'w:gz') as tar: tar.add(source,arcname=f'27g-storage-s3-{version}')
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination/'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
PY
# Only the two release downloads are stubbed, with the same archive/SHA-256 checks
# as production. Any unexpected URL fails. No network or archive-validation bypass.
cat > "$work/bin/curl" <<'PY'
#!/usr/bin/env python3
import os,pathlib,re,shutil,sys
args=sys.argv[1:]; urls=[a for a in args if a.startswith('https://')]
if len(urls)!=1 or '--output' not in args: raise SystemExit('Unexpected CI curl invocation')
m=re.fullmatch(r'https://github.com/gadmin2151/27G-StorageS3/releases/download/(v[0-9]+\.[0-9]+\.[0-9]+)/(SHA256SUMS|27g-storage-s3-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz)',urls[0])
if not m: raise SystemExit('Unexpected CI fixture URL')
source=pathlib.Path(os.environ['INSTALLER_FIXTURES'],m[1],m[2]); output=pathlib.Path(args[args.index('--output')+1])
shutil.copyfile(source,output)
PY
chmod 755 "$work/bin/curl"
export INSTALLER_FIXTURES="$work/releases"
export PATH="$work/bin:$PATH"
port=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1',0));print(s.getsockname()[1])
PY
)
started=$(date +%s)
bash "$root/scripts/install.sh" --yes --build --version "$current" --directory "$installation" --port "$port"
assert_manifest() {
  python3 - "$installation/INSTALLATION.json" "$1" "$volume" <<'PY'
import json,sys
with open(sys.argv[1]) as f: data=json.load(f)
assert data['version']==sys.argv[2],data['version']
assert data['volume']==sys.argv[3], 'Update changed the data volume'
assert data['storageFormatVersion']==1
assert data['storageUpgradeMode']=='none'
PY
}
assert_manifest "$current"
app_check() {
  container=$(docker compose -f "$installation/compose.yaml" ps -q app)
  [[ -n $container ]]
  # Check the mount identity as well as the manifest, so a switched/cloned volume fails.
  [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container") == "$volume" ]]
  docker exec -i -e "SMOKE_PHASE=$1" -e "EXPECTED_VERSION=${2#v}" "$container" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base='http://127.0.0.1:9000',first=process.env.SMOKE_PHASE==='first';
const password='installer-ci-persistent-password',payload='persistent object during in-place upgrade\n'.repeat(4096);
let cookie='',csrf='';
async function api(path,method='GET',body){return fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
let response=await api('/login','POST',{username:'admin',password:first?'admin!123':password,...(first?{setupToken:(await readFile('/data/setup.token','utf8')).trim()}:{})});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
if(first){
 response=await api('/password','PUT',{currentPassword:'admin!123',password});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
 response=await api('/buckets','POST',{name:'upgrade-persistence'});assert.equal(response.status,201);await response.arrayBuffer();
 response=await fetch(base+'/api/object?bucket=upgrade-persistence&key=persistent.txt',{method:'PUT',headers:{cookie,'x-csrf-token':csrf,'content-type':'text/plain'},body:payload});assert.equal(response.status,200);await response.arrayBuffer();
 response=await api('/settings','PUT',{cacheBytes:1048576,concurrency:2});assert.equal(response.status,200);await response.arrayBuffer();
}
response=await api('/object?bucket=upgrade-persistence&key=persistent.txt');assert.equal(response.status,200);const actual=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(payload).digest('hex'));
response=await api('/settings');assert.equal(response.status,200);const settings=await response.json();assert.equal(settings.cacheBytes,1048576);assert.equal(settings.concurrency,2);
response=await api('/status');assert.equal(response.status,200);const status=await response.json();const installedPackage=JSON.parse(await readFile('/app/package.json','utf8'));assert.equal(status.version,installedPackage.version,'Running server version must match the installed image');assert.equal(installedPackage.version,process.env.EXPECTED_VERSION,'Container must use the requested release image');
console.log(`Installer ${first?'initial':'updated'} state: object hash, custom credentials and settings preserved.`);
JS
}
app_check first "$current"
before_volume=$(docker volume inspect --format '{{.CreatedAt}}' "$volume")
bash "$root/scripts/install.sh" --yes --update --build --version "$next" --directory "$installation"
assert_manifest "$next"
[[ $(docker volume inspect --format '{{.CreatedAt}}' "$volume") == "$before_volume" ]]
app_check updated "$next"
container=$(docker compose -f "$installation/compose.yaml" ps -q app)
before_started=$(docker inspect --format '{{.State.StartedAt}}' "$container")
if bash "$root/scripts/install.sh" --yes --update --build --version "$incompatible" --directory "$installation" > "$work/incompatible.log" 2>&1; then
  echo 'Incompatible storage format was incorrectly accepted.' >&2
  exit 1
fi
[[ $(docker compose -f "$installation/compose.yaml" ps -q app) == "$container" ]]
[[ $(docker inspect --format '{{.State.StartedAt}}' "$container") == "$before_started" ]]
assert_manifest "$next"
app_check updated "$next"
# No copied data volume may have been created, even transiently, during the update.
finished=$(( $(date +%s) + 1 ))
docker events --since "$started" --until "$finished" --filter type=volume --filter event=create --format '{{.Actor.ID}}' > "$work/created-volumes"
python3 - "$work/created-volumes" "$volume" <<'PY'
import sys
created=open(sys.argv[1]).read().splitlines()
assert created==[sys.argv[2]], f'Unexpected created volumes: {created!r}'
PY
printf 'Installer E2E passed: initial install, in-place update, same volume, persistent data/auth/settings, incompatible update rejected before stop.\n'

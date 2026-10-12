#!/usr/bin/env bash
# Destructive cleanup is restricted to the fresh containers/volumes created here.
set -euo pipefail
app_image=${1:-27g-storage-s3:ci}
agent_image=${2:-27g-storage-s3-disk-agent:ci}
work=$(mktemp -d)
chmod 700 "$work"
nonce="27g-ci-$(date +%s)-$$-$RANDOM"
app="$nonce-app"
agent="$nonce-agent"
app_data="$nonce-data"
agent_data="$nonce-agent-data"
agent_disk="$nonce-agent-disk"
cleanup() {
  status=$?
  if (( status != 0 )); then
    # Server logs contain a setup token: print only runtime state, never full logs.
    docker inspect --format '{{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' "$app" "$agent" 2>/dev/null || true
  fi
  docker rm -f "$app" "$agent" >/dev/null 2>&1 || true
  docker volume rm "$app_data" "$agent_data" "$agent_disk" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
for volume in "$app_data" "$agent_data" "$agent_disk"; do docker volume create "$volume" >/dev/null; done
node --input-type=module -e 'import{randomBytes}from"node:crypto";process.stdout.write(randomBytes(32).toString("hex"))' > "$work/disk-token"
chmod 600 "$work/disk-token"
docker run -d --name "$app" --init --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --tmpfs /tmp:size=64m,mode=1777 --mount "type=volume,src=$app_data,dst=/data" "$app_image" >/dev/null
docker run -d --name "$agent" --init --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --tmpfs /tmp:size=32m,mode=1777 --tmpfs /run:size=16m,mode=0755 --mount "type=volume,src=$agent_data,dst=/var/lib/storeges3-disks" --mount "type=volume,src=$agent_disk,dst=/external" --mount "type=bind,src=$work/disk-token,dst=/run/secrets/disk_token,readonly" -e DISK_ALLOWED_ROOTS=/external "$agent_image" >/dev/null
wait_ready() {
  local container=$1 port=$2 path=$3 expected=$4
  for ((i=0;i<40;i++)); do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:$port$path').then(r=>process.exit(r.status===$expected?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Container did not become ready: $container" >&2
  return 1
}
app_check() {
  docker exec -i -e "SMOKE_PHASE=$1" "$app" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base='http://127.0.0.1:9000', first=process.env.SMOKE_PHASE==='first';
const payload='27G-StorageS3 container persistence smoke test\n';
const password='container-smoke-only-password';
let cookie='',csrf='';
async function api(path,method='GET',value,extra={}) {
  return fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(value===undefined?{}:{'content-type':'application/json'}),...extra},...(value===undefined?{}:{body:JSON.stringify(value)})});
}
let response=await fetch(base+'/console/');assert.equal(response.status,200);assert.match(await response.text(),/27G-StorageS3/);
response=await api('/status');assert.equal(response.status,401);await response.arrayBuffer();
response=await api('/session');const session=await response.json();assert.equal(session.authenticated,false);assert.equal(session.defaultCredentials,first);assert.equal(session.setupTokenRequired,first);
if(first){response=await api('/login','POST',{username:'admin',password:'admin!123'});assert.equal(response.status,403);await response.arrayBuffer();}
response=await api('/login','POST',{username:'admin',password:first?'admin!123':password,...(first?{setupToken:(await readFile('/data/setup.token','utf8')).trim()}:{})});
assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
if(first){
  response=await api('/password','PUT',{currentPassword:'admin!123',password});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
  response=await api('/buckets','POST',{name:'ci-persistence'},{'x-csrf-token':'invalid'});assert.equal(response.status,403);await response.arrayBuffer();
  response=await api('/buckets','POST',{name:'ci-persistence'});assert.equal(response.status,201);await response.arrayBuffer();
  response=await fetch(base+'/api/object?bucket=ci-persistence&key=readme.txt',{method:'PUT',headers:{cookie,'x-csrf-token':csrf,'content-type':'text/plain'},body:payload});assert.equal(response.status,200);await response.arrayBuffer();
}
response=await api('/object?bucket=ci-persistence&key=readme.txt');assert.equal(response.status,200);assert.equal(await response.text(),payload);
response=await api('/buckets');assert.ok((await response.json()).buckets.some(b=>b.name==='ci-persistence'&&b.accessMode==='private'));
response=await api('/status');assert.equal(response.status,200);assert.equal((await response.json()).security.defaultCredentials,false);
console.log(`Coordinator ${first?'write':'restart/read'} check passed.`);
JS
}
agent_check() {
  docker exec -i -e "SMOKE_PHASE=$1" "$agent" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:9200',first=process.env.SMOKE_PHASE==='first';
const authorization='Bearer '+(await readFile('/run/secrets/disk_token','utf8')).trim();
let response=await fetch(base+'/disks');assert.equal(response.status,401);await response.arrayBuffer();
let disk;
if(first){
  await mkdir('/external/smoke',{recursive:true});
  response=await fetch(base+'/disks',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({kind:'folder',source:'/external/smoke',label:'CI disk'})});assert.equal(response.status,201);disk=await response.json();assert.equal(disk.state,'ready');
  await writeFile('/var/lib/storeges3-disks/ci-identity.json',JSON.stringify({id:disk.id,token:disk.token}),{mode:0o600});
}else disk=JSON.parse(await readFile('/var/lib/storeges3-disks/ci-identity.json','utf8'));
response=await fetch(base+'/disks',{headers:{authorization}});assert.equal(response.status,200);assert.ok((await response.json()).disks.some(d=>d.id===disk.id&&d.state==='ready'));
const url=base+'/volumes/'+disk.id+'/blobs/00000000-0000-4000-8000-000000000001';
const volumeAuth={authorization:'Bearer '+disk.token};
if(first){response=await fetch(url,{method:'PUT',headers:volumeAuth,body:'disk-agent-persistence'});assert.equal(response.status,201);await response.arrayBuffer();}
response=await fetch(url,{headers:volumeAuth});assert.equal(response.status,200);assert.equal(await response.text(),'disk-agent-persistence');
console.log(`Disk agent ${first?'write':'restart/read'} check passed.`);
JS
}
wait_ready "$app" 9000 /healthz 200
wait_ready "$agent" 9200 /disks 401
app_check first
agent_check first
docker restart -t 40 "$app" "$agent" >/dev/null
wait_ready "$app" 9000 /healthz 200
wait_ready "$agent" 9200 /disks 401
app_check restart
agent_check restart
printf 'Container smoke checks passed (coordinator and folder agent, with persistent volumes).\n'

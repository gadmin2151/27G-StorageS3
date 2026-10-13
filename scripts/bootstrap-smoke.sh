#!/usr/bin/env bash
# CI-only real-container initialization check. Cleanup owns only fresh resources.
set -euo pipefail
image=${1:-27g-storage-s3:ci}
work=$(mktemp -d)
chmod 700 "$work"
nonce="27g-init-ci-$(date +%s)-$$-$RANDOM"
initializer="$nonce-init"
app="$nonce-app"
volume="$nonce-data"
cleanup() {
  status=$?
  if (( status != 0 )); then
    # Do not publish container logs or the protected credentials file.
    docker inspect --format '{{.Name}} status={{.State.Status}} exit={{.State.ExitCode}}' "$initializer" "$app" 2>/dev/null || true
  fi
  docker rm -f "$initializer" "$app" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
runtime=(--init --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --tmpfs /tmp:size=64m,mode=1777 --mount "type=volume,source=$volume,target=/data")
if ! docker run --rm --name "$initializer" "${runtime[@]}" \
  -e INIT_ENABLED=true -e INIT_ADMIN_USERNAME=ci-admin -e INIT_BUCKET=bootstrap-ci \
  -e INIT_BUCKET_ACCESS=public-read -e 'INIT_BUCKET_READ_PREFIXES=["public/"]' \
  -e INIT_BUCKET_QUOTA_BYTES=1048576 -e INIT_BUCKET_QUOTA_OBJECTS=10 \
  "$image" node src/server.mjs --init-only > "$work/init-output" 2>&1; then
  echo 'One-shot initialization failed; output withheld because it may contain credentials.' >&2
  exit 1
fi
# Conflicting/changed inputs and absent secret files must be ignored after init.
docker run -d --name "$app" "${runtime[@]}" \
  -e INIT_ENABLED=true -e INIT_ADMIN_USERNAME=must-not-exist -e INIT_BUCKET=must-not-exist \
  -e INIT_CONFIG_FILE=/missing/config.json -e INIT_ADMIN_PASSWORD_FILE=/missing/password \
  "$image" >/dev/null
wait_ready() {
  for ((attempt=0;attempt<40;attempt++)); do
    if docker exec "$app" node -e "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Initialized coordinator did not become ready.' >&2
  return 1
}
check_app() {
  docker exec -i -e "SMOKE_PHASE=$1" "$app" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const first=process.env.SMOKE_PHASE==='first',base='http://127.0.0.1:9000',bucket='bootstrap-ci';
const payload='bootstrap container persistence check\n',changedPassword='bootstrap-ci-updated-password';
const bytes=await readFile('/data/init-credentials.json'),file=await stat('/data/init-credentials.json');
const credentials=JSON.parse(bytes),user=credentials.users.find(u=>u.username==='ci-admin'),key=credentials.keys[0];
assert.equal(process.getuid(),1000);assert.equal(file.uid,1000);assert.equal(file.mode&0o777,0o600);
assert.equal(credentials.users.length,1);assert.equal(credentials.keys.length,1);
assert.ok(user?.generated===true&&typeof user.password==='string'&&user.password.length>=32,'Generated administrator password is missing');
assert.ok(key?.generated?.accessKey===true&&key?.generated?.secretKey===true,'Generated S3 key pair is missing');
const identity={ino:file.ino,mtimeMs:file.mtimeMs,sha256:createHash('sha256').update(bytes).digest('hex')};
if(first) await writeFile('/data/bootstrap-ci-identity.json',JSON.stringify(identity),{mode:0o600});
else assert.deepEqual(identity,JSON.parse(await readFile('/data/bootstrap-ci-identity.json','utf8')),'Initialization credentials were replaced on restart');
let cookie='',csrf='';
async function api(path,method='GET',body){return fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
let response=await api('/login','POST',{username:user.username,password:first?user.password:changedPassword});
assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
response=await api('/users');assert.equal(response.status,200);const users=await response.json();
assert.equal(users.users.length,1);assert.equal(users.users[0].username,'ci-admin');
response=await api('/buckets');assert.equal(response.status,200);const buckets=(await response.json()).buckets;
assert.equal(buckets.length,first?1:4);const originalBucket=buckets.find(item=>item.name===bucket);assert.ok(originalBucket);
assert.equal(originalBucket.quotaBytes,first?1048576:2097152);assert.equal(originalBucket.quotaObjects,first?10:20);
if(!first) for(const name of ['cli-bucket','cli-bucket-2','cli-bucket-3']) assert.ok(buckets.some(item=>item.name===name));
response=await api('/bucket-access?bucket='+bucket);assert.equal(response.status,200);const access=await response.json();
assert.equal(access.mode,first?'public-read':'private');assert.deepEqual(access.readPrefixes,first?['public/']:[]);assert.equal(access.anonymousList,false);
const hash=value=>createHash('sha256').update(value).digest('hex'),hmac=(secret,value)=>createHmac('sha256',secret).update(value).digest();
function signed(method,path,body=''){
 const date=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),digest=hash(body),host=new URL(base).host;
 const names='host;x-amz-content-sha256;x-amz-date',scope=date.slice(0,8)+'/us-east-1/s3/aws4_request';
 const canonical=`${method}\n${path}\n\nhost:${host}\nx-amz-content-sha256:${digest}\nx-amz-date:${date}\n\n${names}\n${digest}`;
 const signing=hmac(hmac(hmac(hmac('AWS4'+key.secretKey,date.slice(0,8)),'us-east-1'),'s3'),'aws4_request');
 const signature=hmac(signing,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
 return {'x-amz-date':date,'x-amz-content-sha256':digest,authorization:`AWS4-HMAC-SHA256 Credential=${key.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}`};
}
const objectPath='/'+bucket+'/public/readme.txt';
if(first){response=await fetch(base+objectPath,{method:'PUT',headers:signed('PUT',objectPath,payload),body:payload});assert.equal(response.status,200);await response.arrayBuffer();}
response=await fetch(base+objectPath,{headers:signed('GET',objectPath)});assert.equal(response.status,200);assert.equal(await response.text(),payload);
response=await fetch(base+objectPath);assert.equal(response.status,first?200:403);await response.arrayBuffer();
response=await fetch(base+'/'+bucket);assert.equal(response.status,403);await response.arrayBuffer();
// The packaged executable uses S3 even when run beside the coordinator. No
// second SQLite process is allowed on the active data volume.
const cliEnv={PATH:process.env.PATH,S3_ENDPOINT:base,AWS_ACCESS_KEY_ID:key.accessKey,AWS_SECRET_ACCESS_KEY:key.secretKey};
let cli=await exec('27g',['create-bucket',bucket,'--if-no-exists'],{env:cliEnv});
assert.match(cli.stdout,/already exists/i);
assert.ok(!cli.stdout.includes(key.secretKey)&&!cli.stderr.includes(key.secretKey));
if(first){
 response=await api('/keys','POST',{label:'CI bucket initialization',role:'readwrite',buckets:['cli-bucket','cli-bucket-2','cli-bucket-3'],permissions:['createBucket']});
 assert.equal(response.status,201);const initKey=await response.json();
 const initEnv={...cliEnv,AWS_ACCESS_KEY_ID:initKey.accessKey,AWS_SECRET_ACCESS_KEY:initKey.secretKey};
 const script='set -eu\n27g create-bucket "cli-bucket" --if-not-exists\n27g create-bucket "cli-bucket-2" --if-not-exists\n27g create-bucket "cli-bucket-3" --if-not-exists';
 for(let attempt=0;attempt<2;attempt++){
  cli=await exec('sh',['-c',script],{env:initEnv});
  assert.ok(!cli.stdout.includes(initKey.secretKey)&&!cli.stderr.includes(initKey.secretKey));
 }
 await assert.rejects(exec('27g',['create-bucket','cli-bucket'],{env:initEnv}),error=>error.code===1);
 await assert.rejects(exec('27g',['create-bucket',bucket,'--if-not-exists'],{env:initEnv}),error=>error.code===1);
 for(const name of ['cli-bucket','cli-bucket-2','cli-bucket-3']){
  response=await api('/bucket-access?bucket='+name);assert.equal(response.status,200);assert.equal((await response.json()).mode,'private');
 }
 response=await api('/bucket-access?bucket='+bucket,'PUT',{mode:'private',readPrefixes:[]});assert.equal(response.status,200);await response.arrayBuffer();
 response=await api('/bucket-quota?bucket='+bucket,'PUT',{maxBytes:2097152,maxObjects:20});assert.equal(response.status,200);await response.arrayBuffer();
 response=await api('/password','PUT',{currentPassword:user.password,password:changedPassword});assert.equal(response.status,200);await response.arrayBuffer();
}
console.log(`Bootstrap ${first?'initial':'restart'} check passed: login, S3, bucket policy, quotas and credential identity.`);
JS
}
check_no_secrets() {
  # Inspect output inside the container, where the credential file is readable.
  # No credential value or unfiltered log line is returned to the runner output.
  { cat "$work/init-output"; docker logs "$app" 2>&1; } | docker exec -i "$app" node --input-type=module -e '
    import {readFile} from "node:fs/promises";
    const credentials=JSON.parse(await readFile("/data/init-credentials.json","utf8"));
    let logs="";for await(const chunk of process.stdin) logs+=chunk;
    const secrets=[...credentials.users.map(u=>u.password),...credentials.keys.map(k=>k.secretKey)];
    if(secrets.some(value=>typeof value==="string"&&value&&logs.includes(value))){console.error("A generated secret appeared in container output.");process.exit(1);}
  '
}
wait_ready
check_app first
check_no_secrets
docker restart -t 40 "$app" >/dev/null
wait_ready
check_app restart
check_no_secrets
printf 'Bootstrap container smoke passed: one-shot initialization, repeatable CLI bucket commands and persistent credentials on restart.\n'

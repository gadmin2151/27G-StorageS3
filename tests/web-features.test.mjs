import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFeatures } from '../web/features.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n=0;n<200;n++) { if(predicate())return; await tick(); } assert.fail('UI task did not settle'); }
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

function harness(t) {
  const savedGlobals = Object.fromEntries(['document','localStorage','XMLHttpRequest'].map(name=>[name,globalThis[name]]));
  t.after(()=>{for(const [key,value] of Object.entries(savedGlobals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  globalThis.document={addEventListener(){}};
  const local = new Map();globalThis.localStorage={getItem:key=>local.get(key),setItem:(key,value)=>local.set(key,value)};
  const state={user:'alice',role:'operator',page:'overview',bucket:'photos',prefix:'',uploads:[],uploadConcurrency:3,csrf:'session-only'};
  const calls=[], parts=new Map();let serverUploads=[];
  globalThis.XMLHttpRequest=class {
    upload={};open(method,url){this.url=url;}setRequestHeader(){}
    async send(blob){await tick();if(this.aborted)return;const n=Number(/\/parts\/(\d+)/.exec(this.url)[1]),sha256=createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');const result={partNumber:n,etag:'"part'+n+'"',sha256,size:blob.size};parts.set(n,result);calls.push({part:n});this.status=200;this.responseText=JSON.stringify(result);this.onload();}
    abort(){this.aborted=true;this.onabort?.();}
  };
  const api=async(path,options={})=>{calls.push({path,...options});if(path==='/api/uploads'&&!options.method)return {uploads:serverUploads};if(path==='/api/uploads')return {uploadId:'upload-1',initiated:new Date().toISOString()};if(path.includes('/complete'))return {};return {parts:[...parts.values()],isTruncated:false};};
  const no=()=>{};
  const features=createFeatures({state,api,$:()=>null,$$:()=>[],toast:no,esc:String,icon:no,button:no,bytes:String,number:String,date:String,duration:String,heading:no,openDialog:no,confirmAction:no,submit:no,loadPage:no,init:no,wiki:[]});
  return {features,state,calls,parts,local,setServerUploads:value=>serverUploads=value};
}

test('multipart immediate resume waits for cancelled hash runner and starts only one upload',async t=>{
  const {features,state,calls,local}=harness(t);await features.restoreUploads();
  const gate=deferred(),entered=deferred(),data=new Blob(['same file']);let blocked=true;
  const file={name:'photo.txt',size:data.size,lastModified:1,type:'text/plain',slice(from,to){const blob=data.slice(from,to);return {size:blob.size,arrayBuffer:async()=>{if(blocked){blocked=false;entered.resolve();await gate.promise;}return blob.arrayBuffer();}};}};
  await features.enqueueFiles([file]);await entered.promise;
  const item=state.uploads[0];features.pauseAll();await features.click('upload-resume',{dataset:{upload:item.clientId}});
  assert.equal(calls.filter(call=>call.path==='/api/uploads'&&call.method==='POST').length,0);
  gate.resolve();await until(()=>item.status==='done');
  assert.equal(calls.filter(call=>call.path==='/api/uploads'&&call.method==='POST').length,1);
  assert.equal(calls.filter(call=>call.part).length,1);
  assert.equal(calls.filter(call=>call.path?.includes('/complete')).length,1);
  assert.ok(![...local.values()].some(value=>value.includes('session-only')));
});

test('multipart verifies stored part hashes and skips matching parts on resume',async t=>{
  const {features,state,calls,parts,setServerUploads}=harness(t);
  setServerUploads([{bucket:'photos',key:'file.txt',uploadId:'saved-upload',owner:'alice'}]);await features.restoreUploads();
  const file=new File(['trusted content'],'file.txt',{type:'text/plain'});
  parts.set(1,{partNumber:1,etag:'"existing"',sha256:createHash('sha256').update('trusted content').digest('hex'),size:file.size});
  const item=state.uploads[0];item.file=file;
  await features.click('upload-resume',{dataset:{upload:item.id}});await until(()=>item.status==='done');
  assert.equal(calls.filter(call=>call.part).length,0);
  assert.deepEqual(calls.find(call=>call.path?.includes('/complete')).body.parts,[{partNumber:1,etag:'"existing"'}]);
});

test('multipart rejects a changed source before upload and clears prior user queue on login',async t=>{
  const {features,state,calls,parts,setServerUploads}=harness(t);
  setServerUploads([{bucket:'photos',key:'file.txt',uploadId:'saved-upload',owner:'alice'}]);await features.restoreUploads();
  parts.set(1,{partNumber:1,etag:'"existing"',sha256:'0'.repeat(64),size:5});
  const item=state.uploads[0];item.file=new File(['other'],'file.txt');
  await features.click('upload-resume',{dataset:{upload:item.id}});await until(()=>item.status==='error');
  assert.match(item.error,/не совпадает/);assert.equal(calls.filter(call=>call.part||call.path?.includes('/complete')).length,0);
  state.uploads.push({id:'completed',key:'private-name',status:'done'});state.user='bob';setServerUploads([]);await features.restoreUploads();assert.deepEqual(state.uploads,[]);
});

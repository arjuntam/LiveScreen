'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {Readable}=require('node:stream');
const {Store}=require('../src/core/store.cjs');const {createPresentationImporter}=require('../src/core/presentation-import.cjs');
const {Auth}=require('../src/core/auth.cjs');const {Controller}=require('../src/core/controller.cjs');const {createControlServer}=require('../src/core/server.cjs');
const root=path.resolve(__dirname,'..');
function setup(t, render) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-import-')),store=new Store(dir,path.join(root,'examples'));
  const image=fs.readFileSync(store.assetPath('welcome'));
  const importer=createPresentationImporter({store,adapter:{capabilities:async()=>({pdf:true,ppt:false}),renderPDF:render||(async(_file,{onTotal,onPage})=>{onTotal(3);for(let i=0;i<3;i++)onPage(i,image);})}});
  t.after(async()=>{await importer.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,importer};
}
function request(name='test.pdf',bytes=Buffer.from('%PDF-1.7\ntest')) {const r=Readable.from([bytes]);r.headers={'x-filename':encodeURIComponent(name),'content-length':String(bytes.length)};return r;}
async function ready(f) {const j=await f.importer.upload(request());for(let i=0;i<20;i++){const state=f.importer.get(j.id);if(state.state==='ready'||state.state==='failed')return state;await new Promise(r=>setTimeout(r,5));}throw Error('job did not finish');}
test('confirmation imports only chosen pages, leaves live/draft/publication unchanged, and can retry safely',async t=>{
  const f=setup(t),before=structuredClone(f.store.data),j=await ready(f);assert.equal(j.state,'ready');
  assert.deepEqual(f.store.data,before);assert.equal(j.pages.length,3);assert.ok(fs.existsSync(f.importer.page(j.id,2)));
  assert.throws(()=>f.importer.commit(j.id,{pages:[0,0],name:'Deck'}));assert.throws(()=>f.importer.commit(j.id,{pages:[3],name:'Deck'}));assert.throws(()=>f.importer.commit(j.id,{pages:[],name:'Deck'}));
  // A concurrent draft save must not be overwritten by import confirmation.
  f.store.save({...f.store.data,draftRevision:9});
  const result=f.importer.commit(j.id,{pages:[2,0],name:' Deck '});assert.equal(result.scene.slideshowMode,'manual');assert.equal(result.scene.transform.fit,'contain');
  assert.deepEqual(result.assets.map(a=>a.name),['Deck · 第 1 页','Deck · 第 3 页']);assert.equal(f.store.data.draftRevision,9);
  assert.deepEqual(f.store.data.draft,before.draft);assert.deepEqual(f.store.data.published,before.published);
  for(const a of result.assets)assert.ok(fs.existsSync(f.store.assetPath(a.id)));
  assert.deepEqual(f.importer.commit(j.id,{pages:[1],name:'Retry'}),result);assert.equal(Object.keys(f.store.data.assets).length,Object.keys(before.assets).length+2);
});
test('failed conversion and invalid uploads leave no library changes or stranded active job',async t=>{
  const f=setup(t,async()=>{throw Error('bad PDF');}),before=structuredClone(f.store.data);
  await assert.rejects(f.importer.upload(request('fake.pptx')),/文件内容/);
  await assert.rejects(f.importer.upload(request('macro.pptm')),/请选择/);
  const job=await ready(f);assert.equal(job.state,'failed');assert.deepEqual(f.store.data,before);
  assert.equal((await f.importer.capabilities()).activeJob,null);assert.throws(()=>f.importer.page(job.id,0));
});
test('fragmented upload headers are accepted without trusting the filename alone',async t=>{
  const f=setup(t),bytes=Buffer.from('%PDF-1.7\ntest'),req=Readable.from([...bytes].map(b=>Buffer.from([b])));
  req.headers={'x-filename':'fragmented.pdf','content-length':String(bytes.length)};
  const j=await f.importer.upload(req);assert.equal(f.importer.get(j.id).state,'ready');
});
test('cancelling a converter interrupts the owned job, cleans staging and permits the next import',async t=>{
  let stopped=false;const f=setup(t,async(_file,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{stopped=true;reject(Error('cancelled'));},{once:true});}));
  const j=await f.importer.upload(request());await assert.rejects(f.importer.upload(request()),/已有文稿/);
  await f.importer.cancel(j.id);assert.equal(stopped,true);assert.equal((await f.importer.capabilities()).activeJob,null);assert.throws(()=>f.importer.get(j.id));
  const next=await f.importer.upload(request());await f.importer.cancel(next.id);
});
test('import HTTP routes protect uploads and previews from phones and anonymous browsers',async t=>{
  const f=setup(t),auth=new Auth(f.store.root),controller=new Controller(f.store,{play:async()=>{}});
  const api=createControlServer({store:f.store,auth,controller,webRoot:path.join(root,'web'),presentationImporter:f.importer});const port=await api.listen(0),base=`http://127.0.0.1:${port}`;
  t.after(()=>api.close());const login=await fetch(base+'/api/login',{method:'POST',headers:{'X-LiveScreen':'1'},body:JSON.stringify({role:'admin',secret:auth.initial.admin})});const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/admin/imports/capabilities')).status,401);
  const pair=await fetch(base+'/api/pair',{method:'POST',headers:{'X-LiveScreen':'1'},body:JSON.stringify({pin:auth.pairingInfo().pin})});const phone=pair.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/admin/imports/upload',{method:'POST',headers:{Cookie:phone,'X-LiveScreen':'1'},body:'%PDF-1.7'})).status,401);
  const upload=await fetch(base+'/api/admin/imports/upload',{method:'POST',headers:{Cookie:cookie,'X-LiveScreen':'1','X-Filename':'deck.pdf'},body:'%PDF-1.7\ntest'});assert.equal(upload.status,202);const j=await upload.json();
  await new Promise(r=>setTimeout(r,10));const state=await(await fetch(base+`/api/admin/imports/${j.id}`,{headers:{Cookie:cookie}})).json();assert.equal(state.state,'ready');
  const url=base+state.pages[0].url;assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{Cookie:phone}})).status,401);assert.equal((await fetch(url,{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(base+`/api/admin/imports/${j.id}/commit`,{method:'POST',headers:{Cookie:cookie,'X-LiveScreen':'1'},body:JSON.stringify({pages:[0,2],name:'Imported'})})).status,200);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../src/core/store.cjs');
const {Controller}=require('../src/core/controller.cjs');
const {validateProjects}=require('../src/core/library.cjs');
const {resolveDisplay}=require('../src/desktop/displays.cjs');
const {createEmergencyAccess}=require('../src/desktop/emergency-access.cjs');
const {createMediaLocation}=require('../src/core/media-location.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-phase1-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const canonical=fs.realpathSync(root);return {root:canonical,store:new Store(path.join(canonical,'host'),path.resolve(__dirname,'../examples')),target:path.join(canonical,'target')};}
test('legacy video scenes remain silent, audio is per video scene and rejects invalid values',t=>{
 const {store}=fixture(t); const p=structuredClone(store.data.draft);let result=validateProjects(p,store);assert.equal(result[0].scenes.find(s=>s.type==='video').audioEnabled,false);
 p[0].scenes.find(s=>s.type==='video').audioEnabled=true;p[0].scenes[0].audioEnabled=true;
 result=validateProjects(p,store);assert.equal(result[0].scenes.find(s=>s.type==='video').audioEnabled,true);assert.equal(result[0].scenes[0].audioEnabled,false);
 p[0].scenes.find(s=>s.type==='video').audioEnabled='yes';assert.throws(()=>validateProjects(p,store),/声音/);
});
test('single mode retains the same external screen when it becomes primary and never follows an unfamiliar screen',()=>{
 const external={id:2,label:'LED',internal:false},binding={id:'2',label:'LED'};
 assert.equal(resolveDisplay([external],2,binding,'dual'),null);assert.equal(resolveDisplay([external],2,binding,'single'),external);
 assert.equal(resolveDisplay([{...external,id:3}],3,binding,'single'),null);
 assert.equal(resolveDisplay([{...external,internal:true}],2,binding,'single'),null);
});
test('emergency shortcut reports registration fallback and releases only its own key',()=>{
 const attempted=[],removed=[];let callback,takeovers=0;
 const access=createEmergencyAccess({register:(key,fn)=>{attempted.push(key);callback=fn;return attempted.length===2;},unregister:key=>removed.push(key)},()=>takeovers++);
 assert.equal(access.register().registered,true);assert.equal(attempted.length,2);callback();assert.equal(takeovers,1);access.close();assert.deepEqual(removed,[attempted[1]]);
 const unavailable=createEmergencyAccess({register:()=>false},()=>{});assert.equal(unavailable.register().registered,false);assert.match(unavailable.status().message,/再次打开/);
});
test('startup choice persists across restart, supports unattended default and last scene, and defaults to pairing guide',async t=>{
 const {store}=fixture(t);assert.equal(store.settings.startupView,'pairing-guide');assert.equal(store.settings.outputMode,'dual');
 store.saveSettings({startupView:'project-default',defaultProjectId:'topic'});
 const disk=new Store(store.root,path.resolve(__dirname,'../examples'));assert.equal(disk.settings.startupView,'project-default');
 const c=new Controller(disk,{play:async()=>{},guide:async()=>{}});c.setOutput({connected:true});await c.startup();assert.equal(c.current.projectId,'topic');
 await c.switchTo('home','product','local');disk.saveSettings({startupView:'last-scene'});
 const restart=new Controller(new Store(store.root,path.resolve(__dirname,'../examples')),{play:async()=>{},guide:async()=>{}});await restart.startup();assert.equal(restart.current.sceneId,'product');
});
test('manager preempts a pending phone command; local operator preempts manager and blocks stale phone takeover',async t=>{
 const {store}=fixture(t);let rejectPlay,resolvePlay;
 const c=new Controller(store,{play:()=>new Promise((resolve,reject)=>{resolvePlay=resolve;rejectPlay=reject;}),cancel:()=>rejectPlay(new Error('cancelled'))});
 const phone=c.switchTo('home','welcome','remote');const phoneRejected=assert.rejects(phone,e=>e.status===409);
 const manager=c.switchTo('home','product','manager');await phoneRejected;
 const managerRejected=assert.rejects(manager,e=>e.status===409);const local=c.switchTo('home','loop','local');await managerRejected;resolvePlay();await local;
 assert.equal(c.current.sceneId,'loop');await assert.rejects(c.switchTo('home','welcome','manager'),/电脑正在操作/);await assert.rejects(c.switchTo('home','welcome','remote'),/电脑正在操作/);
});
test('migration copies and hashes all media, retains originals and survives restart without changing library references',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const original=store.mediaDir,library=structuredClone(store.data);const media=createMediaLocation(store);
 const info=await media.check(target);assert.ok(info.count>=3);await media.start(target);await media.wait();assert.equal(media.status().job.state,'completed');assert.equal(store.mediaDir,target);assert.deepEqual(store.data,library);
 for(const a of Object.values(library.assets))assert.deepEqual(fs.readFileSync(path.join(target,a.file)),fs.readFileSync(path.join(original,a.file)));
 const restart=new Store(store.root,path.resolve(__dirname,'../examples'));assert.equal(restart.mediaDir,target);assert.equal(restart.assetPath('motion'),path.join(target,library.assets.motion.file));
 fs.renameSync(target,target+'-offline');const missing=new Store(store.root,path.resolve(__dirname,'../examples'));assert.equal(missing.mediaDir,target);assert.equal(fs.existsSync(target),false);assert.equal(createMediaLocation(missing).status().available,false);assert.throws(()=>missing.beginMediaWrite(),/不可用/);
});
test('migration locks uploads/imports before copying and blocks migration while an upload or import is active',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const release=store.beginMediaWrite();const media=createMediaLocation(store);
 await assert.rejects(media.start(target),/完成上传/);release();await assert.rejects(createMediaLocation(store,{importBusy:()=>true}).start(target),/完成上传/);
 let resume,reached;const held=new Promise(r=>reached=r),gate=new Promise(r=>resume=r);
 const migration=createMediaLocation(store,{checkpoint:async()=>{reached();await gate;}});await migration.start(target);await held;
 assert.throws(()=>store.beginMediaWrite(),/迁移/);assert.equal(store.mediaMigrating,true);resume();await migration.wait();assert.equal(store.mediaMigrating,false);
});
test('copy/verification/settings failure rolls back without removing original media or switching settings',async t=>{
 for(const point of ['verified','before-switch']){
  const {store,target}=fixture(t);fs.mkdirSync(target);const original=store.mediaDir;
  const media=createMediaLocation(store,{checkpoint:async(stage)=>{if(stage===point)throw new Error('simulated failure');}});
  await media.start(target);await media.wait();assert.equal(media.status().job.state,'failed');assert.equal(store.mediaDir,original);assert.equal(store.settings.mediaDirectory,undefined);assert.deepEqual(fs.readdirSync(target),[]);assert.ok(fs.existsSync(store.assetPath('welcome')));
 }
});
test('settings write failure leaves original settings and media active',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const original=store.mediaDir;store.saveSettings=()=>{throw new Error('read-only settings');};
 const media=createMediaLocation(store);await media.start(target);await media.wait();assert.equal(media.status().job.state,'failed');assert.equal(store.mediaDir,original);assert.deepEqual(fs.readdirSync(target),[]);
});
test('migration rejects relative paths, source overlap, nonempty folders, missing paths and missing source',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const media=createMediaLocation(store);
 for(const candidate of ['relative',store.mediaDir,store.root,path.join(target,'missing')])await assert.rejects(media.check(candidate));
 fs.writeFileSync(path.join(target,'keep.txt'),'untouched');await assert.rejects(media.start(target),/空文件夹/);assert.equal(store.mediaMigrating,false);assert.equal(fs.readFileSync(path.join(target,'keep.txt'),'utf8'),'untouched');
});
test('exit during migration leaves persisted settings pointing to originals and removes staging copies',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const original=store.mediaDir;let release,reached;const gate=new Promise(r=>release=r),held=new Promise(r=>reached=r);
 const media=createMediaLocation(store,{checkpoint:async()=>{reached();await gate;}});await media.start(target);await held;const stop=media.close();release();await stop;
 assert.equal(store.mediaDir,original);assert.equal(media.status().job.state,'failed');assert.deepEqual(fs.readdirSync(target),[]);assert.equal(JSON.parse(fs.readFileSync(store.settingsFile)).mediaDirectory,undefined);
});
test('preflight rejects insufficient space and unwritable target while preserving the current location',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);const media=createMediaLocation(store),original=store.mediaDir;
 const disk=t.mock.method(fs.promises,'statfs',async()=>({bavail:0,bsize:4096}));await assert.rejects(media.start(target),e=>e.status===507);disk.mock.restore();
 const write=fs.promises.writeFile.bind(fs.promises);t.mock.method(fs.promises,'writeFile',async(file,...rest)=>{if(String(file).includes('.livescreen-check-'))throw Object.assign(new Error('denied'),{code:'EACCES'});return write(file,...rest);});
 await assert.rejects(media.start(target),/不可写/);assert.equal(store.mediaDir,original);assert.equal(store.mediaMigrating,false);assert.deepEqual(fs.readdirSync(target),[]);
});
test('a replaced or unreadable source directory reports a recoverable host-directory error',async t=>{
 const {store,target}=fixture(t);fs.mkdirSync(target);fs.renameSync(store.mediaDir,store.mediaDir+'-retained');fs.writeFileSync(store.mediaDir,'not a directory');
 const media=createMediaLocation(store);assert.equal(media.status().available,false);await assert.rejects(media.start(target),e=>e.status===503&&e.message.includes('原素材目录不可用'));assert.equal(store.mediaMigrating,false);assert.equal(store.settings.mediaDirectory,undefined);
});

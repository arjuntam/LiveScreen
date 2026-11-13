'use strict';
const {test,expect,_electron:electron,chromium}=require('@playwright/test');
const {electronEnvironment}=require('./electron-env.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../..');
async function launch(data){const app=await electron.launch({args:[root,'--smoke-test','--port=0',`--data-dir=${data}`],env:electronEnvironment()});const admin=await app.firstWindow();await admin.waitForURL('**/admin');await expect(admin.locator('#admin')).toBeVisible();await expect.poll(()=>app.windows().some(p=>p.url().includes('/src/player/index.html'))).toBe(true);return {app,admin};}
async function api(page,route,body,method='POST'){return page.evaluate(async({route,body,method})=>{const res=await fetch(route,{method,headers:{'X-LiveScreen':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};},{route,body,method});}
async function close(app){if(app){const done=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await done;}}
test('scene sound is opt-in, editor stays silent, commit switches audio and failure retains the old audible scene',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-sound-'));let app;
 try{
  const result=await launch(data);app=result.app;const admin=result.admin;
  async function play(name) { const response=admin.waitForResponse(r=>r.url().endsWith('/api/switch')&&r.request().method()==='POST'); await admin.getByRole('button',{name:'播放 '+name,exact:true}).click(); expect((await response).status()).toBe(200); }
  await expect.poll(async()=> (await api(admin,'/api/state',undefined,'GET')).data.current?.isGuide).toBe(true);
  await admin.getByRole('button',{name:'静音视频演示',exact:true}).click();await expect(admin.locator('#videoAudio')).not.toBeChecked();
  await admin.locator('#upload').setInputFiles(path.join(root,'tests/fixtures/audible-video.mp4'));await expect(admin.locator('#uploadStatus')).toContainText('上传完成');
  await admin.locator('#videoAudio').check();await expect(admin.locator('#preview video')).toHaveJSProperty('muted',true);
  await admin.locator('#saveScene').click();await expect(admin.locator('#draftState')).toHaveText('已保存，待发布');await admin.locator('#publish').click();await expect(admin.locator('#draftState')).toHaveText('已发布');
  await admin.locator('#tabPlayback').click();await play('静音视频演示');await expect(admin.locator('#localPlaybackFeedback')).toHaveText('大屏已完成切换');
  const led=app.windows().find(p=>p.url().includes('/src/player/index.html'));
  await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',false);await expect(led.locator('.scene.live video')).toHaveJSProperty('paused',false);
  const audible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/src/player/index.html')).webContents.isCurrentlyAudible());
  await expect.poll(audible).toBe(true);
  await led.evaluate(()=>{
    window.maximumAudibleVideos=0;
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
    Object.defineProperty(HTMLMediaElement.prototype,'muted',{...descriptor,set(value){descriptor.set.call(this,value);window.maximumAudibleVideos=Math.max(window.maximumAudibleVideos,Array.from(document.querySelectorAll('video')).filter(v=>!v.muted&&!v.paused).length);}});
  });
  const videoSource=await led.locator('.scene.live video').getAttribute('src');
  await app.evaluate(({BrowserWindow},src)=>{
    const output=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/src/player/index.html'));
    output.webContents.send('prepare',{id:'cancel-audio-probe',scene:{type:'video',audioEnabled:true,transform:{fit:'contain',x:0,y:0,scale:1}},sources:[src],transition:{enabled:true,durationMs:600}});
  },videoSource);
  await expect(led.locator('.scene.live')).toHaveCount(2);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/src/player/index.html')).webContents.send('cancel','cancel-audio-probe'));
  await expect(led.locator('.scene.live')).toHaveCount(1);await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',false);await expect.poll(audible).toBe(true);expect(await led.evaluate(()=>window.maximumAudibleVideos)).toBeLessThanOrEqual(1);
  // Save/publish silence without switching: the committed video keeps playing.
  await admin.locator('#tabLibrary').click();await admin.locator('#videoAudio').uncheck();await admin.locator('#saveScene').click();await expect(admin.locator('#draftState')).toHaveText('已保存，待发布');await admin.locator('#publish').click();await expect(admin.locator('#draftState')).toHaveText('已发布');await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',false);
  // Invalid new video passes file presence checks but fails decoding. Old audio survives.
  const library=(await api(admin,'/api/admin/library',undefined,'GET')).data;const bad=structuredClone(library.draft[0].scenes.find(s=>s.type==='video'));bad.assetIds=['motion'];
  fs.writeFileSync(path.join(data,'media',library.assets.motion.file),'invalid mp4');
  expect((await api(admin,'/api/admin/test-scene',{projectId:'broken',projectName:'Broken',scene:bad})).status).toBe(503);
  await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',false);await expect.poll(audible).toBe(true);
  await admin.locator('#tabPlayback').click();await play('静音视频演示');await expect(led.locator('.scene.live video')).toHaveCount(1);await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',true);
  await expect.poll(audible,{timeout:5000}).toBe(false);
  await play('开播背景');await expect(led.locator('video')).toHaveCount(0);await expect.poll(audible).toBe(false);
  await admin.locator('#tabLibrary').click();await admin.getByRole('button',{name:'静音视频演示',exact:true}).click();await admin.locator('#videoAudio').check();await admin.locator('#saveScene').click();await expect(admin.locator('#draftState')).toHaveText('已保存，待发布');await admin.locator('#publish').click();await expect(admin.locator('#draftState')).toHaveText('已发布');
  await admin.locator('#tabPlayback').click();await play('静音视频演示');await expect.poll(audible).toBe(true);
  await admin.locator('#toggleOutput').click();await expect.poll(()=>app.windows().filter(p=>p.url().includes('/src/player/index.html')).length).toBe(0);
 }finally{await close(app);fs.rmSync(data,{recursive:true,force:true});}
});
test('remote manager can migrate media, pause/resume, set unattended startup and explicitly exit without reconnect spinner',async()=>{
 const data=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-headless-'))),target=path.join(data,'new-media');fs.mkdirSync(target);let app,browser;
 try{
  const result=await launch(path.join(data,'host'));app=result.app;const admin=result.admin;const base=new URL(admin.url()).origin;
  browser=await chromium.launch({channel:'msedge',headless:true});const remote=await browser.newPage({viewport:{width:1440,height:900}});await remote.goto(base+'/admin');
  const secret=fs.readFileSync(path.join(data,'host','首次安装口令.txt'),'utf8').split('\n')[0].split('：')[1];await remote.getByLabel('远程管理口令',{exact:true}).fill(secret);await remote.getByRole('button',{name:'进入管理',exact:true}).click();await expect(remote.locator('#admin')).toBeVisible();
  await remote.locator('#toggleOutput').click();await expect(remote.locator('#toggleOutput')).toHaveText('恢复大屏输出');expect((await fetch(base+'/api/health')).status).toBe(200);await expect.poll(()=>app.windows().filter(p=>p.url().includes('/src/player/index.html')).length).toBe(0);
  await remote.locator('#toggleOutput').click();await expect(remote.locator('#toggleOutput')).toHaveText('暂停大屏输出');
  await remote.locator('#tabSystem').click();await expect(remote.locator('#chooseMedia')).toBeHidden();await expect(remote.locator('#outputMode')).toBeVisible();
  await remote.locator('#mediaDirectory').fill(target);await remote.locator('#checkMedia').click();await expect(remote.locator('#mediaFeedback')).toContainText('目录可用');
  remote.once('dialog',d=>d.accept());await remote.locator('#migrateMedia').click();await expect(remote.locator('#mediaFeedback')).toContainText('迁移完成');await expect(remote.locator('#mediaCurrent')).toHaveText('当前目录：'+target);
  const media=(await api(remote,'/api/admin/media',undefined,'GET')).data;expect(media.available).toBe(true);expect(fs.existsSync(path.join(target,'welcome.png'))).toBe(true);expect(fs.existsSync(path.join(data,'host','media','welcome.png'))).toBe(true);
  // New uploads and rendered PDF pages use the migrated directory, not the admin browser's computer.
  await remote.locator('#tabLibrary').click();await remote.locator('#upload').setInputFiles(path.join(root,'examples/product.png'));await expect(remote.locator('#uploadStatus')).toContainText('上传完成');
  await remote.locator('#importPresentation').click();await expect(remote.locator('#presentationEnvironment')).not.toHaveText(/正在检查/);await remote.locator('#presentationFile').setInputFiles(path.join(root,'tests/fixtures/three-pages.pdf'));await expect(remote.locator('#presentationSelection')).toBeVisible({timeout:30000});await remote.locator('#presentationName').fill('迁移后文稿');await remote.locator('#confirmPresentation').click();await expect(remote.locator('#presentationDialog')).not.toBeVisible();
  const updated=(await api(remote,'/api/admin/library',undefined,'GET')).data;const added=Object.values(updated.assets).filter(a=>!['welcome','product','motion'].includes(a.id));expect(added.length).toBe(4);for(const a of added){expect(fs.existsSync(path.join(target,a.file))).toBe(true);expect(fs.existsSync(path.join(data,'host','media',a.file))).toBe(false);}
  await remote.locator('#saveScene').click();await expect(remote.locator('#draftState')).toHaveText('已保存，待发布');await remote.locator('#publish').click();await expect(remote.locator('#draftState')).toHaveText('已发布');await remote.locator('#tabSystem').click();
  await remote.locator('#startupView').selectOption('last-scene');await remote.getByRole('button',{name:'保存开屏设置',exact:true}).click();await expect(remote.locator('#startupFeedback')).toContainText('已保存');expect((await api(remote,'/api/admin/system',undefined,'GET')).data.settings.startupView).toBe('last-scene');
  fs.mkdirSync(path.join(root,'test-results/evidence'),{recursive:true});await remote.screenshot({path:path.join(root,'test-results/evidence/phase1-remote-settings.png')});
  remote.once('dialog',d=>d.dismiss());await remote.locator('#quit').click();expect((await fetch(base+'/api/health')).status).toBe(200);
  const closed=app.waitForEvent('close');remote.once('dialog',d=>d.accept());await remote.locator('#quit').click();await expect(remote.locator('#connection')).toHaveText('退出请求已受理');await closed;app=null;await expect.poll(async()=>{try{await fetch(base+'/api/health');return false;}catch{return true;}}).toBe(true);
 }finally{await browser?.close();await close(app);fs.rmSync(data,{recursive:true,force:true});}
});
test('single-screen binding supports local takeover; window X preserves output, relaunch releases it, and emergency key status is truthful',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-single-'));let app;
 try{
  const result=await launch(data);app=result.app;const admin=result.admin;
  await app.evaluate(({screen})=>{const original=screen.getPrimaryDisplay();screen.getAllDisplays=()=>[{...original,id:8102,label:'Simulated external LED',internal:false}];screen.getPrimaryDisplay=()=>({...original,id:8102,internal:false});});
  await admin.locator('#tabSystem').click();await admin.locator('#refreshSystem').click();await expect(admin.locator('#displaySelect option')).toHaveCount(1);await expect(admin.locator('#bindDisplay')).toBeDisabled();
  await admin.locator('#outputMode').selectOption('single');await expect(admin.locator('#bindDisplay')).toBeEnabled();await admin.locator('#bindDisplay').click();await expect(admin.locator('#message')).toContainText('绑定已保存');
  const info=(await api(admin,'/api/admin/system',undefined,'GET')).data;expect(info.settings.outputMode).toBe('single');expect(info.settings.display.id).toBe('8102');
  if(info.emergency.registered)expect(await app.evaluate(({globalShortcut},key)=>globalShortcut.isRegistered(key),info.emergency.accelerator)).toBe(true);else await expect(admin.locator('#emergencyStatus')).toContainText('注册失败');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/admin')).close());
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/admin')).isVisible())).toBe(false);
  expect((await api(admin,'/api/state',undefined,'GET')).data.output.connected).toBe(true);
  // second-instance is the exact application event used by relaunch; no second process or data directory is created.
  await app.evaluate(({app})=>app.emit('second-instance',{},[],''));
  await expect(admin.locator('#toggleOutput')).toHaveText('恢复大屏输出');await expect.poll(()=>app.windows().filter(p=>p.url().includes('/src/player/index.html')).length).toBe(0);
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/admin')).isVisible())).toBe(true);
  await admin.locator('#toggleOutput').click();await expect.poll(()=>app.windows().filter(p=>p.url().includes('/src/player/index.html')).length).toBe(1);
  const base=new URL(admin.url()).origin;await close(app);app=null;await expect.poll(async()=>{try{await fetch(base+'/api/health');return false;}catch{return true;}}).toBe(true);
  // No restart is scheduled after an explicit close; data, binding and chosen mode remain.
  expect(JSON.parse(fs.readFileSync(path.join(data,'settings.json'))).outputMode).toBe('single');expect(fs.existsSync(path.join(data,'library.json'))).toBe(true);
 }finally{await close(app);fs.rmSync(data,{recursive:true,force:true});}
});

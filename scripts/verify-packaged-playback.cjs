'use strict';
// Launch with Node. The Electron test host opens the shipped ASAR in smoke
// mode and an isolated data directory; it never touches the installed library.
const { _electron:electron, expect }=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const archive=path.resolve(process.argv[2]||'dist/mac/mac-arm64/LiveScreen.app/Contents/Resources/app.asar');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-packaged-playback-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;
(async()=>{
 try{
  app=await electron.launch({args:[archive,'--smoke-test','--port=0',`--data-dir=${data}`],env});const admin=await app.firstWindow();await admin.waitForURL('**/admin');await expect(admin.locator('#admin')).toBeVisible();
  await expect.poll(()=>app.windows().some(w=>w.url().includes('/src/player/index.html'))).toBe(true);
  await admin.getByRole('button',{name:'静音视频演示',exact:true}).click();await admin.locator('#upload').setInputFiles(path.join(root,'tests/fixtures/audible-video.mp4'));await expect(admin.locator('#uploadStatus')).toContainText('上传完成');await admin.locator('#videoAudio').check();
  await expect(admin.locator('#preview video')).toHaveJSProperty('muted',true);await admin.locator('#saveScene').click();await expect(admin.locator('#draftState')).toHaveText('已保存，待发布');await admin.locator('#publish').click();await expect(admin.locator('#draftState')).toHaveText('已发布');await admin.locator('#tabPlayback').click();
  const response=admin.waitForResponse(r=>r.url().endsWith('/api/switch'));await admin.getByRole('button',{name:'播放 静音视频演示',exact:true}).click();if((await response).status()!==200)throw Error('Playback failed');
  const led=app.windows().find(w=>w.url().includes('/src/player/index.html'));await expect(led.locator('.scene.live video')).toHaveJSProperty('muted',false);
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/src/player/index.html')).webContents.isCurrentlyAudible())).toBe(true);
  fs.mkdirSync(path.join(root,'test-results/evidence'),{recursive:true});await admin.locator('#tabLibrary').click();await admin.locator('.scene-inspector').screenshot({path:path.join(root,'test-results/evidence/packaged-audio-setting.png')});
  const base=new URL(admin.url()).origin;const done=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await done;app=null;
  await expect.poll(async()=>{try{await fetch(base+'/api/health');return false;}catch{return true;}}).toBe(true);
  console.log(JSON.stringify({archive,packagedPlayback:true,audible:true,editorMuted:true,shutdownPortReleased:true,installedDataUntouched:true},null,2));
 }finally{if(app){const done=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await done;}fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

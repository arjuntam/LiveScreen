const { electronEnvironment } = require('./electron-env.cjs');
'use strict';
const { test,expect,_electron:electron,chromium }=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../..');
test('remote management has its own labels/logout, native-only controls are denied, and draft status stays understandable',async()=>{
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-remote-manager-'));let app,browser;
  try{
    app=await electron.launch({args:[root,'--smoke-test','--port=0',`--data-dir=${dataRoot}`],env:electronEnvironment()});
    const admin=await app.firstWindow();await admin.waitForURL('**/admin');await expect(admin.locator('#admin')).toBeVisible();
    await expect.poll(()=>app.windows().some(w=>w.url().includes('/src/player/index.html'))).toBe(true);
    const led=app.windows().find(w=>w.url().includes('/src/player/index.html'));await expect(led.locator('.pairing-guide')).toBeVisible();
    const base=new URL(admin.url()).origin;
    browser=await chromium.launch({channel:'msedge',headless:true});
    const secret=fs.readFileSync(path.join(dataRoot,'首次安装口令.txt'),'utf8').split('\n')[0].split('：')[1];
    async function manager(){const ctx=await browser.newContext({viewport:{width:1440,height:900}}),page=await ctx.newPage();await page.goto(base+'/admin');await page.getByLabel('远程管理口令',{exact:true}).fill(secret);await page.getByRole('button',{name:'进入管理',exact:true}).click();await expect(page.locator('#admin')).toBeVisible();return page;}
    const remote=await manager(),other=await manager();
    await expect(remote.getByRole('button',{name:'退出软件',exact:true})).toHaveCount(0);
    await expect(remote.getByRole('button',{name:'退出管理登录',exact:true})).toBeVisible();
    await expect(remote.locator('#tabPlayback')).toHaveText('大屏控制');await expect(admin.locator('#tabPlayback')).toHaveText('本地播放');
    await expect(remote.locator('#toggleOutput')).toBeHidden();await expect(admin.locator('#toggleOutput')).toBeVisible();
    await remote.locator('#tabSystem').click();await expect(remote.locator('#bindDisplay')).toBeHidden();await expect(remote.locator('#autoStart')).toBeHidden();await expect(remote.locator('#dataRoot')).toBeHidden();
    const status=await remote.evaluate(async()=>{
      const info=await(await fetch('/api/admin/system')).json();const results=[];
      for(const route of ['quit','display','autostart','output'])results.push((await fetch('/api/admin/'+route,{method:'POST',headers:{'X-LiveScreen':'1','Content-Type':'application/json'},body:'{}'})).status);
      return {results,path:info.dataRoot,local:info.localControls};
    });expect(status.results).toEqual([403,403,403,403]);expect(status.path).toBeNull();expect(status.local).toBe(false);
    await remote.locator('#tabLibrary').click();await expect(remote.locator('#draftState')).toHaveText('已发布');
    await remote.locator('#sceneName').fill('远程编辑背景');await expect(remote.locator('#draftState')).toHaveText('有未保存修改');
    await remote.locator('#saveScene').click();await expect(remote.locator('#draftState')).toHaveText('已保存，待发布');
    await other.locator('#sceneName').fill('过期页面的修改');await other.locator('#saveScene').click();await expect(other.locator('#message')).toContainText('草稿已被另一管理端更新');
    await remote.locator('#publish').click();await expect(remote.locator('#draftState')).toHaveText('已发布');await expect(remote.locator('#draftState')).not.toContainText('版本');
    await remote.locator('#tabPlayback').click();await expect(remote.locator('#playbackHeading')).toHaveText('远程大屏控制');
    await remote.getByRole('button',{name:'播放 远程编辑背景',exact:true}).click();await expect(remote.locator('#localPlaybackFeedback')).toHaveText('大屏已完成切换');
    const scene=(await(await fetch(base+'/api/health')).json()).app;expect(scene).toBe('LiveScreen');
    await remote.locator('#tabSystem').click();
    fs.mkdirSync(path.join(root,'test-results/evidence'),{recursive:true});await remote.screenshot({path:path.join(root,'test-results/evidence/remote-manager.png')});
    await expect(remote.locator('link[rel="icon"]')).toHaveCount(2);await expect(remote.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    expect(await remote.evaluate(async()=>{const icon=new Image();icon.src='/icon.svg';await icon.decode();return icon.naturalWidth>0;})).toBe(true);
    const phone=await browser.newPage();await phone.goto(base);await expect(phone.locator('link[rel="icon"]')).toHaveCount(2);await expect(phone.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await remote.getByRole('button',{name:'退出管理登录',exact:true}).click();await expect(remote.locator('#login')).toBeVisible();await expect(remote.locator('#loginFeedback')).toHaveText('已退出管理登录，大屏继续播放。');
    await expect(admin.locator('#admin')).toBeVisible();expect((await fetch(base+'/api/health')).status).toBe(200);await expect(led.locator('.scene.live img')).toHaveCount(1);
    await admin.context().clearCookies();await admin.reload();await expect(admin.locator('#login')).toBeVisible();
    await expect(admin.locator('#nativeExit [data-quit]')).toBeVisible();
    const exited=app.waitForEvent('close');await admin.locator('#nativeExit [data-quit]').click();await exited;app=null;
    await expect.poll(async()=>{try{await fetch(base+'/api/health');return false;}catch{return true;}}).toBe(true);
  }finally{
    await browser?.close();if(app){const closed=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await closed;}fs.rmSync(dataRoot,{recursive:true,force:true});
  }
});

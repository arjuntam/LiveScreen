const { electronEnvironment } = require('./electron-env.cjs');
'use strict';
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..'), evidence = path.join(root, 'test-results/evidence');
let app, admin, browser, base, dataRoot;
test.describe.configure({ mode: 'serial' });
async function launch() {
  app = await electron.launch({ args: [root, '--dev-preview', '--autostart', '--port=0', `--data-dir=${dataRoot}`], env: electronEnvironment() });
  admin = await app.firstWindow(); await admin.waitForURL('**/admin'); base = new URL(admin.url()).origin;
  await expect(admin.locator('#admin')).toBeVisible();
}
test.beforeAll(async () => { dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-workbench-')); fs.mkdirSync(evidence, { recursive: true }); await launch(); browser = await chromium.launch({ channel: 'msedge', headless: true }); });
test.afterAll(async () => { await browser?.close(); if (app) { const done = app.waitForEvent('close'); await app.evaluate(({app}) => app.quit()); await done; } if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true }); });
async function visible() { return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/admin')).isVisible()); }
test('landscape editor keeps save, scene navigation and canvas visible without scrolling the page', async () => {
  expect(await visible()).toBe(false);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === '打开大屏管理').click());
  for (const [width, height] of [[1280,720],[1366,768],[1440,900],[1920,1080]]) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/admin')).setContentSize(width,height), {width,height});
    await expect.poll(() => admin.evaluate(() => Math.round(document.body.getBoundingClientRect().height) === innerHeight)).toBe(true);
    await expect(admin.locator('#sceneEditor')).toBeVisible();
    const geometry = await admin.evaluate(() => {
      const r = selector => { const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom}; };
      return { width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollHeight,bodyWidth:document.documentElement.scrollWidth,save:r('#saveScene'),preview:r('#preview'),upload:r('.upload-toolbar'),scenes:r('#scenes'),inspector:r('.scene-inspector') };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.height+1); expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.save.bottom).toBeLessThan(geometry.height); expect(geometry.preview.bottom).toBeLessThan(geometry.height);expect(geometry.upload.bottom).toBeLessThan(geometry.height);
    expect(geometry.scenes.right).toBeLessThan(geometry.preview.x); expect(geometry.preview.right).toBeLessThan(geometry.inspector.x);
    await admin.screenshot({ path: path.join(evidence,`editor-${width}x${height}.png`) });
  }
});
test('management remains usable on narrow widths and mobile preview cannot inherit native admin authority', async () => {
  const cookies = await admin.context().cookies(base);
  for (const width of [320,375,414,768]) {
    const context = await browser.newContext({viewport:{width,height:900}});await context.addCookies(cookies);
    const page=await context.newPage();await page.goto(base+'/admin');await expect(page.locator('#sceneEditor')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:path.join(evidence,`manager-responsive-${width}.png`),fullPage:true});await context.close();
  }
  const opened=app.waitForEvent('window');await admin.locator('#previewPhone').click();
  const phone=await opened;await phone.waitForURL(base+'/');await expect(phone.locator('#login')).toBeVisible();
  expect(await phone.evaluate(async()=>(await fetch('/api/admin/library')).status)).toBe(401);
  const pin=await admin.evaluate(async()=>(await(await fetch('/api/admin/pairing')).json()).pin);
  await phone.getByLabel('配对码',{exact:true}).fill(pin);await phone.getByRole('button',{name:'配对并连接',exact:true}).click();await expect(phone.locator('#remote')).toBeVisible();
  expect(await phone.evaluate(async()=>(await fetch('/api/admin/system')).status)).toBe(401);
});
test('local playback shows actual image/video thumbnails and reuses them across state updates', async () => {
  await admin.locator('#tabPlayback').click();
  await expect(admin.locator('#localScenes .local-thumb')).toHaveCount(4);
  await expect.poll(()=>admin.locator('#localScenes img').evaluateAll(nodes=>nodes.every(n=>n.complete && n.naturalWidth>0))).toBe(true);
  const video=admin.locator('#localScenes video');await expect.poll(()=>video.evaluate(v=>v.readyState>=2)).toBe(true);expect(await video.evaluate(v=>v.paused && v.muted && !v.autoplay)).toBe(true);
  await admin.locator('#localScenes .scene-card').first().evaluate(b=>{b.querySelector('img').dataset.retained='yes';});
  await admin.getByRole('button',{name:'播放 开播背景',exact:true}).click();await expect(admin.locator('#localPlaybackFeedback')).toHaveText('大屏已完成切换');
  await expect(admin.locator('#localScenes .scene-card').first().locator('img')).toHaveAttribute('data-retained','yes');
  await admin.screenshot({path:path.join(evidence,'computer-thumbnail-playback.png')});
  await admin.locator('#tabLibrary').click();
});
test('disconnect reveals hidden management and pauses output persistently; connecting another screen never resumes it', async () => {
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/admin')).close());expect(await visible()).toBe(false);
  await app.evaluate(({screen})=>screen.emit('display-removed',{}, {id:'simulated-unplug'}));
  await expect.poll(visible).toBe(true);await expect(admin.locator('#outputNoticeText')).toHaveText('大屏连接已断开，LiveScreen 已暂停输出。');
  expect(app.windows().filter(w=>w.url().includes('/src/player/index.html')).length).toBe(0);
  await app.evaluate(({screen})=>screen.emit('display-added',{}, {id:'meeting-screen',label:'LED'}));
  await expect.poll(async()=>admin.evaluate(async()=>(await(await fetch('/api/state')).json()).output.paused)).toBe(true);
  const exited=app.waitForEvent('close');await admin.locator('#exitApp').click();await exited;app=null;
  await launch();await expect.poll(visible).toBe(true);await expect(admin.locator('#toggleOutput')).toHaveText('恢复大屏输出');
  expect(app.windows().filter(w=>w.url().includes('/src/player/index.html')).length).toBe(0);
  await admin.locator('#toggleOutput').click();await expect.poll(async()=>admin.evaluate(async()=>(await(await fetch('/api/state')).json()).output.connected)).toBe(true);
  await expect(admin.locator('#outputNotice')).toBeHidden();
});
test('manual pause preserves the library and blocks phone controls until explicit resume; quit releases the port', async () => {
  const before=fs.readFileSync(path.join(dataRoot,'library.json'),'utf8');await admin.locator('#toggleOutput').click();await expect(admin.locator('#outputNotice')).toBeVisible();
  expect(fs.readFileSync(path.join(dataRoot,'library.json'),'utf8')).toBe(before);
  const state=await admin.evaluate(async()=>(await(await fetch('/api/state')).json()));expect(state.output.connected).toBe(false);expect(state.output.paused).toBe(true);
  await admin.locator('#toggleOutput').click();await expect.poll(async()=>admin.evaluate(async()=>(await(await fetch('/api/state')).json()).output.connected)).toBe(true);
  const exited=app.waitForEvent('close');await admin.locator('#exitApp').click();await exited;app=null;
  await expect.poll(async()=>{try{await fetch(base);return false;}catch{return true;}}).toBe(true);
});

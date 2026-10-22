'use strict';
const {test,expect,_electron:electron,chromium}=require('@playwright/test');
const {electronEnvironment}=require('./electron-env.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(root,'tests/fixtures');
let app,admin,dataRoot,base,browser;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{
  dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-presentation-ui-'));
  app=await electron.launch({args:[root,'--dev-preview','--port=0',`--data-dir=${dataRoot}`],env:electronEnvironment()});
  app.on('window',page=>{page.on('console',m=>console.log('[converter]',m.type(),m.text()));page.on('pageerror',e=>console.log('[converter error]',e.message));});
  admin=await app.firstWindow();await admin.waitForURL('**/admin');base=new URL(admin.url()).origin;
  await expect(admin.locator('#admin')).toBeVisible();
  browser=await chromium.launch({channel:'msedge',headless:true});
});
test.afterAll(async()=>{await browser?.close();if(app){const done=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await done;}if(dataRoot)fs.rmSync(dataRoot,{recursive:true,force:true});});
async function state(page=admin){return page.evaluate(async()=>await(await fetch('/api/state')).json());}
async function importFile(name,page=admin){await page.locator('#importPresentation').click();await expect(page.locator('#presentationEnvironment')).not.toHaveText(/正在检查/);await page.locator('#presentationFile').setInputFiles(path.join(fixtures,name));await page.waitForFunction(()=>!document.querySelector('#presentationSelection').hidden||document.querySelector('#presentationStatus').classList.contains('error'),null,{timeout:90000});if(await page.locator('#presentationStatus').evaluate(n=>n.classList.contains('error')))throw Error(await page.locator('#presentationStatus').textContent());await expect(page.locator('#presentationSelection')).toBeVisible();}
test('PDF import previews pages, keeps live output unchanged and creates a selected manual scene only after confirmation',async()=>{
  const before=await state();await importFile('three-pages.pdf');
  await expect(admin.locator('#presentationPages .import-page')).toHaveCount(3);
  await expect.poll(()=>admin.locator('#presentationPages img').evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0))).toBe(true);
  await admin.locator('#presentationPages [data-page="1"]').click();await admin.locator('#presentationName').fill('静态演示导入');
  await expect(admin.locator('#presentationCount')).toHaveText('已选 2 / 50 页');
  await admin.screenshot({path:path.join(root,'test-results/evidence/presentation-page-selection.png')});
  await admin.locator('#confirmPresentation').click();await expect(admin.locator('#presentationDialog')).not.toBeVisible();
  await expect(admin.locator('#sceneName')).toHaveValue('静态演示导入');await expect(admin.locator('#sceneType')).toHaveValue('slideshow');
  await expect(admin.locator('#fit')).toHaveValue('contain');await expect(admin.locator('#slideshowMode')).toHaveValue('manual');
  await expect(admin.locator('#assets .scene-asset')).toHaveCount(2);expect((await state()).current).toEqual(before.current);
  const stored=JSON.parse(fs.readFileSync(path.join(dataRoot,'library.json'),'utf8'));expect(stored.draft[0].scenes.some(s=>s.name==='静态演示导入')).toBe(false);
  await admin.locator('#saveScene').click();await expect(admin.locator('#saveScene')).toBeDisabled();
  await admin.locator('#publish').click();await expect(admin.locator('#draftState')).toHaveText('已发布');
  await admin.locator('#tabPlayback').click();await admin.getByRole('button',{name:'播放 静态演示导入',exact:true}).click();
  await expect(admin.locator('#localPlaybackFeedback')).toHaveText('大屏已完成切换');await expect(admin.locator('#localPageControls .page-thumbnail')).toHaveCount(2);
  const gallery=admin.locator('#localPageControls .page-thumbnail');await gallery.nth(1).click();
  await expect.poll(async()=>(await state()).current.pageIndex).toBe(1);
  await admin.locator('#tabLibrary').click();
});
test('PPTX is converted by the installed host engine without changing playback',async()=>{
  test.setTimeout(120000);
  const caps=await admin.evaluate(async()=>await(await fetch('/api/admin/imports/capabilities')).json());test.skip(!caps.ppt,'This host has no PowerPoint or LibreOffice; PDF remains supported.');
  const before=await state();await importFile('three-pages.pptx');
  await expect(admin.locator('#presentationPages .import-page')).toHaveCount(3);
  await expect.poll(()=>admin.locator('#presentationPages img').evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0))).toBe(true);
  expect((await state()).current).toEqual(before.current);await admin.locator('#cancelPresentation').click();await expect(admin.locator('#presentationDialog')).not.toBeVisible();
  expect((await admin.evaluate(async()=>await(await fetch('/api/admin/imports/capabilities')).json())).activeJob).toBe(null);
});
test('portrait PDF preserves page proportions and an ordinary remote admin can upload',async()=>{
  // Obtain an ordinary admin session through the documented login endpoint.
  const credentials=fs.readFileSync(path.join(dataRoot,'首次安装口令.txt'),'utf8');
  const password=credentials.split('\n').find(l=>l.includes('远程管理'))?.split('：').slice(1).join('：').trim();
  expect(password).toBeTruthy();
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();await page.goto(base+'/admin');
  await page.getByLabel('远程管理口令',{exact:true}).fill(password);await page.getByRole('button',{name:'进入管理',exact:true}).click();await expect(page.locator('#admin')).toBeVisible();
  await importFile('portrait.pdf',page);await expect(page.locator('#presentationPages img')).toHaveCount(1);
  const size=await page.locator('#presentationPages img').evaluate(i=>({width:i.naturalWidth,height:i.naturalHeight}));expect(size.height).toBeGreaterThan(size.width);
  await page.locator('#presentationName').fill('竖版演示');await page.locator('#confirmPresentation').click();await expect(page.locator('#presentationDialog')).not.toBeVisible();
  await page.locator('#saveScene').click();await expect(page.locator('#saveScene')).toBeDisabled();await context.close();
  await admin.reload();await expect(admin.locator('#admin')).toBeVisible();
  expect((JSON.parse(fs.readFileSync(path.join(dataRoot,'library.json'),'utf8'))).draft[0].scenes.some(s=>s.name==='竖版演示')).toBe(true);
});
test('preview follows wide and portrait output proportions instead of a fixed 16:9 canvas',async()=>{
  for(const [width,height] of [[2560,1080],[1080,1920],[3840,720]]){
    await admin.route('**/api/admin/system',async route=>{const response=await route.fetch();const data=await response.json();data.outputSize={width,height};await route.fulfill({response,json:data});});
    await admin.reload();await expect(admin.locator('#admin')).toBeVisible();await expect(admin.locator('#previewCaption')).toContainText(`${width} × ${height}`);
    const ratio=await admin.locator('#preview').evaluate(n=>{const r=n.getBoundingClientRect();return r.width/r.height;});expect(ratio).toBeCloseTo(width/height,1);
    await admin.unroute('**/api/admin/system');
  }
});

test('non-16:9 outputs keep the full pairing guide and decodable QR inside the screen',async()=>{
  await admin.evaluate(async()=>{const r=await fetch('/api/admin/guide',{method:'POST',headers:{'X-LiveScreen':'1'}});if(!r.ok)throw Error(await r.text());});
  const led=app.windows().find(w=>w.url().includes('/src/player/index.html'));
  const {PNG}=require('pngjs'),jsQR=require('jsqr');
  for(const [width,height] of [[2560,1080],[1080,1920],[3840,720]]){
    await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/src/player/index.html')).setContentSize(width,height),{width,height});
    await expect.poll(()=>led.evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width,height});
    const rect=await led.locator('.pairing-guide').evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
    expect(rect.x).toBeGreaterThanOrEqual(-1);expect(rect.y).toBeGreaterThanOrEqual(-1);expect(rect.right).toBeLessThanOrEqual(width+1);expect(rect.bottom).toBeLessThanOrEqual(height+1);
    const qr=led.locator('.guide-qr').first();await expect(qr).toBeVisible();const b=await qr.boundingBox();expect(b.y+b.height).toBeLessThan(height);expect(b.x+b.width).toBeLessThan(width);
    const image=PNG.sync.read(await qr.screenshot());expect(jsQR(new Uint8ClampedArray(image.data),image.width,image.height)).not.toBe(null);
    await led.screenshot({path:path.join(root,`test-results/evidence/guide-${width}x${height}.png`),scale:'css'});
  }
});

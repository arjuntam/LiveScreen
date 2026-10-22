const { electronEnvironment } = require('./electron-env.cjs');
'use strict';
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const projectRoot = path.resolve(__dirname, '../..'); const evidence = path.join(projectRoot, 'test-results/evidence');
let app, browser, admin, base, dataRoot, a, b;
test.describe.configure({ mode: 'serial' });
async function launch() {
  app = await electron.launch({ args: [projectRoot, '--smoke-test', '--port=0', `--data-dir=${dataRoot}`], timeout: 45000, env: electronEnvironment() });
  admin = await app.firstWindow(); await admin.waitForURL('**/admin'); base = new URL(admin.url()).origin;
  await expect(admin.locator('#admin')).toBeVisible();
  await expect.poll(async () => (await admin.evaluate(async () => (await (await fetch('/api/state')).json()).current))?.isGuide).toBe(true);
}
async function api(route, body, method = 'POST') {
  return admin.evaluate(async ({ route, body, method }) => {
    const r = await fetch(route, { method, headers: { 'Content-Type': 'application/json', 'X-LiveScreen': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() };
  }, { route, body, method });
}
async function pair() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const page = await context.newPage(); await page.goto(base);
  const pin = (await api('/api/admin/pairing', undefined, 'GET')).data.pin;
  await page.getByLabel('配对码', { exact: true }).fill(pin); await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.locator('#remote')).toBeVisible(); return { page, context };
}
async function local(sceneName, projectId = 'home') {
  await admin.locator('#tabPlayback').click(); await admin.locator('#playbackProject').selectOption(projectId);
  await admin.getByRole('button', { name: '播放 ' + sceneName, exact: true }).click();
  await expect(admin.locator('#localPlaybackFeedback')).toHaveText('大屏已完成切换', { timeout: 20000 });
}
async function publishSlides(mode, interval = 1) {
  const library = (await api('/api/admin/library', undefined, 'GET')).data;
  const scene = library.draft[0].scenes.find(s => s.id === 'slides'); scene.slideshowMode = mode; scene.interval = interval;
  const saved = await api('/api/admin/draft', { projects: library.draft, revision: library.draftRevision }, 'PUT'); expect(saved.status).toBe(200);
  expect((await api('/api/admin/publish', { revision: saved.data.draftRevision })).status).toBe(200);
}
test.beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-connection-ui-')); fs.mkdirSync(evidence, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true }); await launch();
});
test.afterAll(async () => { await browser?.close(); if (app) { const done = app.waitForEvent('close'); await app.evaluate(({app}) => app.quit()); await done; } if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true }); });
test('first pairing automatically enters the configured default; a second phone never resets the scene', async () => {
  await admin.locator('#tabSystem').click(); await admin.locator('#afterPairingView').selectOption('project-default'); await admin.locator('#defaultProject').selectOption('topic');
  await admin.getByRole('button', { name: '保存开屏设置', exact: true }).click(); await expect(admin.locator('#startupFeedback')).toContainText('已保存');
  expect((await api('/api/admin/system', undefined, 'GET')).data.settings.defaultProjectId).toBe('topic');
  a = await pair(); await expect(a.page.locator('#now')).toHaveText('专题背景');
  await local('产品介绍'); await expect(a.page.locator('#now')).toHaveText('产品介绍');
  b = await pair(); await expect(b.page.locator('#now')).toHaveText('产品介绍');
});
test('phone and computer turn manual pages without reloading the scene; published edits leave the active page count intact', async () => {
  await publishSlides('manual'); await local('图片轮播演示');
  const led = app.windows().find(w => w.url().includes('/src/player/index.html'));
  const first = await led.locator('.scene.live img:not(.off)').getAttribute('src');
  const preview = admin.locator('#localPageControls .page-thumbnail[aria-pressed="true"] img');
  await expect(preview).toBeVisible();await expect(preview).toHaveAttribute('src','/media/welcome');
  await expect(a.page.locator('#pageControls img')).toHaveCount(0);await expect(b.page.locator('#pageControls img')).toHaveCount(0);
  await expect(a.page.locator('#pageControls strong')).toHaveText('第 1 / 2 张');
  await expect(a.page.locator('#pageControls').getByRole('button', { name: '← 上一张' })).toBeDisabled();
  await a.page.locator('#pageControls').getByRole('button', { name: '下一张 →' }).click();
  await expect(a.page.locator('#pageControls strong')).toHaveText('第 2 / 2 张');
  await expect(b.page.locator('#pageControls strong')).toHaveText('第 2 / 2 张');
  await expect(admin.locator('#localPageControls strong')).toHaveText('第 2 / 2 张');
  await expect(preview).toHaveAttribute('src','/media/product');await expect(preview).toBeVisible();
  expect(await led.locator('.scene.live img:not(.off)').getAttribute('src')).not.toBe(first);
  await admin.locator('#localPageControls').getByRole('button', { name: '← 上一张' }).click();
  await expect(a.page.locator('#pageControls strong')).toHaveText('第 1 / 2 张');
  await new Promise(resolve => setTimeout(resolve, 1300));
  await expect(a.page.locator('#pageControls strong')).toHaveText('第 1 / 2 张');
  expect(await led.locator('.scene.live img:not(.off)').getAttribute('src')).toBe(first);
  await expect(preview).toHaveAttribute('src','/media/welcome');
  await preview.evaluate(node => { node.dataset.retained = 'yes'; });
  const before = (await api('/api/state', undefined, 'GET')).data.current;
  await publishSlides('auto', 2);
  expect((await api('/api/state', undefined, 'GET')).data.current.playbackId).toBe(before.playbackId);
  await expect(preview).toHaveAttribute('data-retained','yes');await expect(preview).toHaveAttribute('src','/media/welcome');
  await a.page.screenshot({ path: path.join(evidence, 'phone-manual-pages.png'), fullPage: true });
  await admin.screenshot({ path: path.join(evidence, 'computer-current-page-preview.png'), fullPage: true });
  await local('开播背景');
  expect((await api('/api/page', { playbackId: before.playbackId, direction: 'next' })).status).toBe(409);
});
test('automatic page changes also synchronize actual page numbers to both phones', async () => {
  await local('图片轮播演示'); await expect(a.page.locator('#pageControls strong')).toHaveText('第 1 / 2 张');
  await expect(a.page.locator('#pageControls strong')).toHaveText('第 2 / 2 张', { timeout: 5000 });
  await expect(b.page.locator('#pageControls strong')).toHaveText('第 2 / 2 张');
  await expect(admin.locator('#localPageControls .page-thumbnail[aria-pressed="true"] img')).toHaveAttribute('src','/media/product');
  await expect(admin.locator('#localPageControls .page-thumbnail[aria-pressed="true"] img')).toBeVisible();
  await expect(a.page.locator('#pageControls img')).toHaveCount(0);
});
test('configured hand paging pauses auto rotation until a phone or desktop explicitly resumes it', async () => {
  await admin.locator('#tabLibrary').click();await admin.locator('#reload').click();
  await admin.locator('#scenes .scene-select').filter({hasText:'图片轮播演示'}).click();
  await admin.locator('#slideshowMode').selectOption('auto');await admin.locator('#interval').fill('1');await admin.locator('#pauseOnManual').selectOption('pause');
  await admin.locator('#saveScene').click();await expect(admin.locator('#sceneSaveFeedback')).toContainText('已保存到大屏电脑');
  await admin.locator('#publish').click();await expect(admin.locator('#message')).toContainText('项目已发布');
  expect((await api('/api/admin/library',undefined,'GET')).data.published[0].scenes.find(s=>s.id==='slides').pauseOnManual).toBe(true);
  await local('图片轮播演示');await admin.locator('#localPageControls').getByRole('button',{name:'下一张 →'}).click();
  await expect(admin.locator('#localPageControls .page-info small')).toContainText('已暂停');await expect(a.page.locator('#pageControls small')).toContainText('已暂停');
  const led=app.windows().find(w=>w.url().includes('/src/player/index.html'));const frame=await led.locator('.scene.live img:not(.off)').getAttribute('src');
  await new Promise(resolve=>setTimeout(resolve,2300));expect(await led.locator('.scene.live img:not(.off)').getAttribute('src')).toBe(frame);
  await expect(admin.locator('#localPageControls strong')).toHaveText('第 2 / 2 张');
  await a.page.setViewportSize({width:320,height:900});expect(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(a.page.locator('#pageControls img')).toHaveCount(0);
  await a.page.getByRole('button',{name:'继续轮播',exact:true}).click();await expect(admin.locator('#localPageControls strong')).toHaveText('第 1 / 2 张',{timeout:5000});
  await expect(admin.locator('#localPageControls .page-thumbnail[aria-pressed="true"] img')).toHaveAttribute('src','/media/welcome');
  await admin.getByRole('button',{name:'暂停自动轮播',exact:true}).click();await expect(b.page.locator('#pageControls small')).toContainText('已暂停');
  await admin.screenshot({path:path.join(evidence,'computer-paused-page-preview.png')});
  await admin.getByRole('button',{name:'继续自动轮播',exact:true}).click();await expect(admin.locator('#localPageControls .page-info small')).not.toContainText('已暂停');
  await a.page.setViewportSize({width:390,height:844});
});
test('desktop lays out every image and jumps directly to any page using the active snapshot', async () => {
  let library=(await api('/api/admin/library',undefined,'GET')).data;
  let slides=library.draft[0].scenes.find(s=>s.id==='slides');slides.assetIds=['welcome','product','product'];slides.slideshowMode='auto';slides.interval=10;slides.pauseOnManual=true;
  let saved=await api('/api/admin/draft',{projects:library.draft,revision:library.draftRevision},'PUT');expect(saved.status).toBe(200);expect((await api('/api/admin/publish',{revision:saved.data.draftRevision})).status).toBe(200);
  await local('图片轮播演示');const gallery=admin.locator('#localPageControls .page-thumbnails');
  await expect(gallery.locator('.page-thumbnail')).toHaveCount(3);await expect.poll(()=>gallery.locator('img').evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth>0))).toBe(true);
  const aligned=await gallery.locator('.page-thumbnail').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));expect(new Set(aligned).size).toBe(1);
  await gallery.getByRole('button',{name:'跳到第 3 张',exact:true}).click();
  await expect(admin.locator('#localPageControls strong')).toHaveText('第 3 / 3 张');await expect(a.page.locator('#pageControls strong')).toHaveText('第 3 / 3 张');await expect(b.page.locator('#pageControls strong')).toHaveText('第 3 / 3 张');
  await expect(gallery.getByRole('button',{name:'跳到第 3 张',exact:true})).toHaveAttribute('aria-pressed','true');await expect(gallery.locator('[aria-pressed=true]')).toHaveCount(1);
  const led=app.windows().find(w=>w.url().includes('/src/player/index.html'));await expect(led.locator('.scene.live img').nth(2)).not.toHaveClass(/off/);await expect(admin.locator('#localPageControls .page-info small')).toContainText('已暂停');
  await gallery.getByRole('button',{name:'跳到第 1 张',exact:true}).click();await expect(led.locator('.scene.live img').first()).not.toHaveClass(/off/);await expect(a.page.locator('#pageControls strong')).toHaveText('第 1 / 3 张');
  await gallery.locator('img').first().evaluate(node=>{node.dataset.retained='yes';});
  library=(await api('/api/admin/library',undefined,'GET')).data;slides=library.draft[0].scenes.find(s=>s.id==='slides');slides.assetIds=['product'];slides.transform.x=25;
  saved=await api('/api/admin/draft',{projects:library.draft,revision:library.draftRevision},'PUT');expect((await api('/api/admin/publish',{revision:saved.data.draftRevision})).status).toBe(200);
  await expect(gallery.locator('.page-thumbnail')).toHaveCount(3);await expect(gallery.locator('img').first()).toHaveAttribute('src','/media/welcome');await expect(gallery.locator('img').first()).toHaveAttribute('data-retained','yes');
  await gallery.getByRole('button',{name:'跳到第 3 张',exact:true}).click();await expect(admin.locator('#localPageControls strong')).toHaveText('第 3 / 3 张');await expect(a.page.locator('#pageControls img')).toHaveCount(0);
  await admin.screenshot({path:path.join(evidence,'computer-gallery-jump.png')});
  library=(await api('/api/admin/library',undefined,'GET')).data;slides=library.draft[0].scenes.find(s=>s.id==='slides');slides.assetIds=['welcome','product'];slides.transform.x=0;
  saved=await api('/api/admin/draft',{projects:library.draft,revision:library.draftRevision},'PUT');expect((await api('/api/admin/publish',{revision:saved.data.draftRevision})).status).toBe(200);
});
test('native playback takes over a phone switch in progress and rejects spoofed local requests during its priority window', async () => {
  await local('开播背景'); await expect(a.page.locator('#controlPriority')).toBeHidden({ timeout: 5000 });
  const led = app.windows().find(w => w.url().includes('/src/player/index.html'));
  await led.evaluate(() => {
    window.originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function() { await window.originalDecode.call(this); await new Promise(resolve => setTimeout(resolve, 1500)); };
  });
  await a.page.evaluate(() => {
    window.conflictResult = fetch('/api/state').then(r => r.json()).then(state => {
      window.beforeLocalGeneration = state.control.generation;
      return fetch('/api/switch', { method: 'POST', headers: { 'X-LiveScreen': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'home', sceneId: 'product', controlGeneration: state.control.generation }) });
    }).then(async r => ({ status: r.status, body: await r.json() }));
  });
  await expect.poll(async () => (await api('/api/state', undefined, 'GET')).data.control.busySource).toBe('remote');
  await local('静音视频演示');
  expect((await a.page.evaluate(() => window.conflictResult)).status).toBe(409);
  await expect(a.page.locator('#controlPriority')).toBeVisible();
  const spoofed = await a.page.evaluate(async () => (await fetch('/api/switch', { method: 'POST', headers: { 'X-LiveScreen': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'home', sceneId: 'welcome', source: 'local' }) })).status);
  expect(spoofed).toBe(409);
  await new Promise(resolve => setTimeout(resolve, 1600));
  expect((await api('/api/state', undefined, 'GET')).data.current.sceneId).toBe('loop');
  await led.evaluate(() => { HTMLImageElement.prototype.decode = window.originalDecode; });
  await expect(a.page.locator('#controlPriority')).toBeHidden({ timeout: 5000 });
  const late = await a.page.evaluate(async () => (await fetch('/api/switch', { method: 'POST', headers: { 'X-LiveScreen': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'home', sceneId: 'welcome', controlGeneration: window.beforeLocalGeneration }) })).status);
  expect(late).toBe(409);
});
test('local scene also cancels a phone page before its renderer acknowledgement', async () => {
  await publishSlides('manual'); await local('图片轮播演示'); await expect(a.page.locator('#controlPriority')).toBeHidden({ timeout: 5000 });
  const id = (await api('/api/state', undefined, 'GET')).data.current.playbackId;
  const led = app.windows().find(w => w.url().includes('/src/player/index.html'));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const player = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/src/player/index.html'));
    const gate = globalThis.pageAckGate = { id: null, held: [], listeners: ipcMain.listeners('result'), send: player.webContents.send.bind(player.webContents) };
    player.webContents.send = (channel, ...args) => { if (channel === 'page') gate.id = args[0].id; return gate.send(channel, ...args); };
    ipcMain.removeAllListeners('result');
    ipcMain.on('result', (event, result) => {
      if (result.id === gate.id) { gate.held.push({ event, result }); return; }
      for (const listener of gate.listeners) listener.call(ipcMain, event, result);
    });
  });
  await a.page.evaluate(playbackId => {
    window.pageConflict = fetch('/api/state').then(r => r.json()).then(state => fetch('/api/page', { method: 'POST', headers: { 'X-LiveScreen': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackId, direction: 'next', controlGeneration: state.control.generation }) })).then(r => r.status);
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.pageAckGate.held.length)).toBe(1);
  // Send the native request immediately while the phone acknowledgement is held.
  expect((await api('/api/switch', { projectId: 'home', sceneId: 'welcome' })).status).toBe(200);
  expect(await a.page.evaluate(() => window.pageConflict)).toBe(409);
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const gate = globalThis.pageAckGate;
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/src/player/index.html')).webContents.send = gate.send;
    ipcMain.removeAllListeners('result');
    for (const listener of gate.listeners) ipcMain.on('result', listener);
    for (const held of gate.held) for (const listener of gate.listeners) listener.call(ipcMain, held.event, held.result);
    delete globalThis.pageAckGate;
  });
  const current = (await api('/api/state', undefined, 'GET')).data.current;
  expect(current.sceneId).toBe('welcome'); expect(current.pageIndex).toBe(0);
  await expect(led.locator('.scene.live img:not(.off)')).toHaveAttribute('src', /welcome.png/);
});
test('restart shows the guide, trusted reconnect restores last scene; computer-only playback needs no phone', async () => {
  await local('产品介绍');
  expect((await api('/api/admin/startup', { afterPairingView: 'last-scene', defaultProjectId: 'topic' })).status).toBe(200);
  await a.page.goto('about:blank'); await b.page.goto('about:blank'); { const done = app.waitForEvent('close'); await app.evaluate(({app}) => app.quit()); await done; } app = null;
  await launch(); await a.page.goto(base); await expect(a.page.locator('#login')).toBeHidden();
  await expect(a.page.locator('#now')).toHaveText('产品介绍');
  await a.page.goto('about:blank'); { const done = app.waitForEvent('close'); await app.evaluate(({app}) => app.quit()); await done; } app = null; await launch();
  await local('开播背景');
  await a.page.goto(base); await expect(a.page.locator('#now')).toHaveText('开播背景');
});

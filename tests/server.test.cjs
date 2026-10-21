'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Auth } = require('../src/core/auth.cjs');
const { Controller } = require('../src/core/controller.cjs');
const { createControlServer } = require('../src/core/server.cjs');
async function setup(t, desktop = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-http-'));
  const store = new Store(root, path.resolve(__dirname, '../examples')); const auth = new Auth(root);
  store.saveSettings({ startupView: 'project-default' });
  let plays = 0; const c = new Controller(store, { play: async () => { plays++; }, guide: async () => { plays++; } });
  const api = createControlServer({ store, auth, controller: c, webRoot: path.resolve(__dirname, '../web'), desktop });
  const port = await api.listen(0); const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await api.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(url, method = 'GET', body, cookie = '', headers = {}) {
    if (body && ['/api/switch', '/api/page'].includes(url)) body = { controlGeneration: c.controlGeneration, ...body };
    return fetch(base + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'X-LiveScreen': '1', Cookie: cookie, ...headers } });
  }
  async function login(role) {
    const r = role === 'control' ? await request('/api/pair', 'POST', { pin: auth.pairingInfo().pin })
      : await request('/api/login', 'POST', { role, secret: auth.initial[role] });
    assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
  }
  function native() { const token = require('node:crypto').randomBytes(32).toString('hex'); auth.sessions.set(token, { role: 'admin', native: true, expires: Number.MAX_SAFE_INTEGER }); return 'livescreen=' + token; }
  return { store, auth, c, api, base, request, login, native, plays: () => plays };
}
test('anonymous and control clients cannot mutate library or read protected media', async t => {
  const f = await setup(t); assert.equal((await f.request('/api/state')).status, 401);
  const control = await f.login('control'); assert.equal((await f.request('/api/state', 'GET', null, control)).status, 200);
  for (const route of ['/api/admin/library', '/api/admin/system']) assert.equal((await f.request(route, 'GET', null, control)).status, 401);
  for (const route of ['/api/admin/upload', '/api/admin/publish', '/api/admin/quit', '/api/admin/password']) assert.equal((await f.request(route, 'POST', {}, control)).status, 401);
  assert.equal((await f.request('/media/welcome')).status, 401);
});
test('draft save/publish isolates live frame and has revision conflict protection', async t => {
  const f = await setup(t); const admin = await f.login('admin'); await f.c.startup(); const before = structuredClone(f.c.current);
  const projects = structuredClone(f.store.data.draft); projects[0].name = '已修改项目';
  let r = await f.request('/api/admin/draft', 'PUT', { projects, revision: 1 }, admin); assert.equal(r.status, 200);
  assert.notEqual(f.store.data.published[0].name, '已修改项目'); assert.equal(f.plays(), 1);
  assert.equal((await f.request('/api/admin/draft', 'PUT', { projects, revision: 1 }, admin)).status, 409);
  assert.equal((await f.request('/api/admin/publish', 'POST', { revision: 2 }, admin)).status, 200);
  assert.equal(f.store.data.published[0].name, '已修改项目'); assert.deepEqual(f.c.current, before); assert.equal(f.plays(), 1);
});
test('scene labels persist independently through save and publish; old scenes and empty drafts remain usable', async t => {
  const f = await setup(t); const admin = await f.login('admin'); await f.c.startup(); const before = structuredClone(f.c.current);
  const projects = structuredClone(f.store.data.draft);
  projects[0].scenes[0].label = ' 展厅实拍 ';
  projects[0].scenes[1].label = '<b>新品 & 重点</b>';
  let r = await f.request('/api/admin/draft', 'PUT', { projects, revision: 1 }, admin); assert.equal(r.status, 200);
  assert.equal(f.store.data.draft[0].scenes[0].label, '展厅实拍');
  assert.equal(f.store.data.published[0].scenes[0].label, undefined);
  assert.equal((await f.request('/api/admin/publish', 'POST', { revision: 2 }, admin)).status, 200);
  const restarted = new Store(f.store.root, path.resolve(__dirname, '../examples'));
  assert.equal(restarted.data.published[0].scenes[1].label, '<b>新品 & 重点</b>');
  assert.equal(restarted.data.published[0].scenes[2].label, ''); assert.deepEqual(f.c.current, before);
  for (const bad of ['x'.repeat(41), null, 7, []]) {
    const invalid = structuredClone(projects); invalid[0].scenes[0].label = bad;
    assert.equal((await f.request('/api/admin/draft', 'PUT', { projects: invalid, revision: 2 }, admin)).status, 400);
  }
  const empty = structuredClone(f.store.data.draft); empty[0].scenes[0].label = ''; empty[0].scenes[0].assetIds = [];
  assert.equal((await f.request('/api/admin/draft', 'PUT', { projects: empty, revision: 2 }, admin)).status, 200);
  assert.equal((await f.request('/api/admin/publish', 'POST', { revision: 3 }, admin)).status, 400);
  assert.equal(f.store.data.published[0].scenes[0].label, '展厅实拍');
});
test('SSE delivers committed real state to multiple clients', async t => {
  const f = await setup(t); const cookie = await f.login('control');
  const requests = await Promise.all([1, 2].map(() => fetch(f.base + '/api/events', { headers: { Cookie: cookie } })));
  const readers = requests.map(r => r.body.getReader());
  for (const reader of readers) await reader.read();
  const result = await f.request('/api/switch', 'POST', { projectId: 'home', sceneId: 'product' }, cookie); assert.equal(result.status, 200);
  for (const reader of readers) {
    let text = ''; while (!text.includes('"sceneId":"product"')) text += Buffer.from((await reader.read()).value).toString();
    assert.match(text, /产品介绍/); await reader.cancel();
  }
});
test('upload is local, bounded and rejects forged file types', async t => {
  const f = await setup(t); const cookie = await f.login('admin');
  const png = fs.readFileSync(path.resolve(__dirname, '../examples/welcome.png'));
  let r = await fetch(f.base + '/api/admin/upload', { method: 'POST', headers: { Cookie: cookie, 'X-LiveScreen': '1', 'X-Filename': encodeURIComponent('本地图.png') }, body: png });
  assert.equal(r.status, 201); const a = await r.json(); assert.deepEqual(fs.readFileSync(f.store.assetPath(a.id)), png);
  r = await fetch(f.base + '/api/admin/upload', { method: 'POST', headers: { Cookie: cookie, 'X-LiveScreen': '1', 'X-Filename': 'fake.png' }, body: 'bad file' }); assert.equal(r.status, 400);
  assert.ok(!fs.readdirSync(f.store.mediaDir).some(x => x.endsWith('.part')));
});
test('media range supports video seek and rejects out of bounds', async t => {
  const f = await setup(t); const cookie = await f.login('control');
  let r = await f.request('/media/motion', 'GET', null, cookie, { Range: 'bytes=0-15' }); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 16);
  r = await f.request('/media/motion', 'GET', null, cookie, { Range: 'bytes=999999999-' }); assert.equal(r.status, 416);
});
test('cross-origin/CSRF and DNS rebinding requests are denied', async t => {
  const f = await setup(t); const cookie = await f.login('admin');
  assert.equal((await f.request('/api/admin/publish', 'POST', {}, cookie, { Origin: 'http://evil.example' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    // fetch normalizes Host. Use an actual raw Host header to exercise DNS rebinding protection.
    const req = require('node:http').get(f.base + '/api/state', { headers: { Host: 'evil.example', Cookie: cookie } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(f.base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
});
test('admin password rotation revokes remote sessions, preserves paired phones; login attempts are limited', async t => {
  const f = await setup(t); const cookie = await f.login('admin'); const phone = await f.login('control'); f.auth.set('admin', 'new-admin-password');
  assert.equal((await f.request('/api/state', 'GET', null, cookie)).status, 401);
  assert.equal((await f.request('/api/state', 'GET', null, phone)).status, 200);
  for (let i = 0; i < 8; i++) assert.equal((await f.request('/api/login', 'POST', { role: 'admin', secret: 'bad' })).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { role: 'admin', secret: 'bad' })).status, 429);
});
test('pairing endpoint remembers devices, rotates PIN and limits their permissions', async t => {
  const f = await setup(t); const old = f.auth.pairingInfo().pin; const phone = await f.login('control');
  assert.notEqual(f.auth.pairingInfo().pin, old);
  assert.equal((await f.request('/api/pair', 'POST', { pin: old })).status, 401);
  assert.equal((await f.request('/api/admin/pairing', 'GET', null, phone)).status, 401);
  assert.equal((await f.request('/api/admin/devices/revoke', 'POST', {}, phone)).status, 401);
  const admin = await f.login('admin');
  const pairing = await (await f.request('/api/admin/pairing', 'GET', null, admin)).json();
  assert.equal(pairing.devices.length, 1); assert.equal('tokenHash' in pairing.devices[0], false);
  assert.equal((await f.request('/api/admin/devices/revoke', 'POST', { id: pairing.devices[0].id }, admin)).status, 200);
  assert.equal((await f.request('/api/state', 'GET', null, phone)).status, 401);
});
test('global transition setting persists, validates input and cannot be changed by a phone', async t => {
  const f = await setup(t); const admin = await f.login('admin'); const phone = await f.login('control');
  assert.deepEqual(f.store.settings.transition, { enabled: true, durationMs: 300 });
  assert.equal((await f.request('/api/admin/playback', 'POST', { enabled: false, durationMs: 600 }, phone)).status, 401);
  assert.equal((await f.request('/api/admin/playback', 'POST', { enabled: true, durationMs: 0 }, admin)).status, 400);
  assert.equal((await f.request('/api/admin/playback', 'POST', { enabled: false, durationMs: 600 }, admin)).status, 200);
  const disk = JSON.parse(fs.readFileSync(f.store.settingsFile)); assert.deepEqual(disk.transition, { enabled: false, durationMs: 600 });
});
test('computer draft test is explicit, visible in phone state and never publishes or changes reboot project', async t => {
  const f = await setup(t); const admin = await f.login('admin'); const phone = await f.login('control');
  await f.c.switchTo('home', 'product');
  const scene = structuredClone(f.store.data.draft[0].scenes[0]); scene.name = '未发布的电脑测试'; scene.transform.scale = 1.2;
  const body = { projectId: 'draft-project', projectName: '新项目草稿', scene };
  assert.equal((await f.request('/api/admin/test-scene', 'POST', body, phone)).status, 401);
  assert.equal((await f.request('/api/admin/test-scene', 'POST', body, admin)).status, 200);
  assert.equal(f.c.current.isTest, true); assert.equal(f.c.current.sceneName, scene.name);
  assert.equal(f.store.data.revision, 1); assert.equal(f.store.settings.lastProjectId, 'home');
  assert.equal((await f.request('/api/admin/test/restore', 'POST', {}, admin)).status, 200);
  assert.equal(f.c.current.sceneId, 'product'); assert.equal(f.c.current.isTest, false);
});
test('shutdown closes listening socket and existing connections', async t => {
  const f = await setup(t); await f.api.close(); await assert.rejects(fetch(f.base + '/'));
});
test('shutdown releases authenticated SSE and incomplete HTTP header connections', { timeout: 3000 }, async t => {
  const f = await setup(t); const cookie = await f.login('control');
  const stream = await fetch(f.base + '/api/events', { headers: { Cookie: cookie } });
  const reader = stream.body.getReader(); await reader.read();
  const net = require('node:net'); const url = new URL(f.base);
  const socket = net.connect(Number(url.port), url.hostname); t.after(() => socket.destroy());
  socket.on('error', error => assert.equal(error.code, 'ECONNRESET'));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\nHost: ');
  const disconnected = new Promise(resolve => socket.once('close', resolve));
  const first = f.api.close(); const second = f.api.close(); assert.equal(first, second); await first;
  await disconnected;
  try { while (!(await reader.read()).done) { /* Drain the ended stream. */ } } catch { /* A forced socket close can reject the reader. */ }
  await assert.rejects(fetch(f.base));
});
test('startup guide can be configured and shown only by operators', async t => {
  const f = await setup(t); const admin = await f.login('admin'); const phone = await f.login('control');
  assert.equal((await f.request('/api/admin/guide', 'POST', {}, phone)).status, 401);
  assert.equal((await f.request('/api/admin/startup', 'POST', { view: 'bad' }, admin)).status, 400);
  assert.equal((await f.request('/api/admin/startup', 'POST', { afterPairingView: 'last-scene', defaultProjectId: 'topic' }, admin)).status, 200);
  assert.equal((await f.request('/api/admin/startup', 'POST', { afterPairingView: 'last-scene', defaultProjectId: 'gone' }, admin)).status, 400);
  await f.c.startup(); assert.equal(f.c.current.isGuide, true);
  await f.c.switchTo('home', 'product');
  assert.equal((await f.request('/api/admin/guide', 'POST', {}, admin)).status, 200);
  assert.equal(f.c.current.isGuide, true); assert.equal(f.store.settings.lastProjectId, 'home');
});
test('a valid paired phone activates the guide, while admin reads do not; page API enforces identity', async t => {
  const f = await setup(t); const admin = await f.login('admin'); f.c.setOutput({ connected: true }); await f.c.startup();
  await f.request('/api/state', 'GET', null, admin); assert.equal(f.c.current.isGuide, true);
  const phone = await f.login('control'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.c.current.sceneId, 'welcome');
  let pageCalls = 0; f.c.player.page = async () => { pageCalls++; };
  await f.c.switchTo('home', 'slides'); const playbackId = f.c.current.playbackId;
  assert.equal((await f.request('/api/page', 'POST', { playbackId, direction: 'next' })).status, 401);
  assert.equal((await f.request('/api/page', 'POST', { playbackId: 'old', direction: 'next' }, phone)).status, 409);
  assert.equal((await f.request('/api/page', 'POST', { playbackId, direction: 'next' }, phone)).status, 200);
  assert.equal(f.c.current.pageIndex, 1); assert.equal(pageCalls, 1);
});
test('only a native operator session receives local priority; a phone cannot claim it in the request body', async t => {
  const f = await setup(t); const token = 'a'.repeat(64);
  f.auth.sessions.set(token, { role: 'admin', native: true, expires: Number.MAX_SAFE_INTEGER });
  const phone = await f.login('control');
  assert.equal((await f.request('/api/switch', 'POST', { projectId: 'home', sceneId: 'welcome' }, 'livescreen=' + token)).status, 200);
  const response = await f.request('/api/switch', 'POST', { projectId: 'home', sceneId: 'product', source: 'local' }, phone);
  assert.equal(response.status, 409); assert.match((await response.json()).error, /电脑正在操作/);
  assert.equal(f.c.current.sceneId, 'welcome');
});

test('autostart validates silent mode, persists the choice and denies paired phones', async t => {
  let f;
  f = await setup(t, { autoStartSupported: true, setAutoStart: async (enabled, silent) => f.store.saveSettings({ autoStart: enabled, silentAutoStart: silent }) });
  const admin = f.native(), control = await f.login('control');
  assert.equal(f.store.settings.silentAutoStart, true);
  assert.equal((await f.request('/api/admin/autostart', 'POST', { enabled: true, silent: true }, control)).status, 401);
  assert.equal((await f.request('/api/admin/autostart', 'POST', { enabled: true, silent: 'yes' }, admin)).status, 400);
  assert.equal((await f.request('/api/admin/autostart', 'POST', { enabled: true, silent: false }, admin)).status, 200);
  const saved = new Store(f.store.root, path.resolve(__dirname, '../examples'));
  assert.equal(saved.settings.autoStart, true); assert.equal(saved.settings.silentAutoStart, false);
});
test('output pause requires native operator, validates input and preserves project/media data', async t => {
  let f;
  f = await setup(t, { setOutputPaused: async paused => { f.store.saveSettings({outputPaused:paused});f.c.setOutput({connected:!paused,paused}); } });
  const admin=f.native(),control=await f.login('control'), before=structuredClone(f.store.data);
  assert.equal((await f.request('/api/admin/output','POST',{paused:true},control)).status,401);
  assert.equal((await f.request('/api/admin/output','POST',{paused:'yes'},admin)).status,400);
  assert.equal((await f.request('/api/admin/output','POST',{paused:true},admin)).status,200);
  assert.equal(f.c.snapshot().output.paused,true); assert.deepEqual(f.store.data,before);
  assert.equal((await f.request('/api/switch','POST',{projectId:'home',sceneId:'welcome'},control)).status,409);
  assert.equal((await f.request('/api/admin/output','POST',{paused:false},admin)).status,200);assert.equal(f.c.snapshot().output.connected,true);
});

test('page API accepts an explicit index, rejects ambiguous selectors and validates bounds', async t=>{
  const f=await setup(t),admin=await f.login('admin');f.c.setOutput({connected:true});f.c.player.page=async()=>{};await f.c.switchTo('home','slides');const id=f.c.current.playbackId;
  assert.equal((await f.request('/api/page','POST',{playbackId:id,index:1},admin)).status,200);assert.equal(f.c.current.pageIndex,1);
  assert.equal((await f.request('/api/page','POST',{playbackId:id,index:0,direction:'next'},admin)).status,400);
  assert.equal((await f.request('/api/page','POST',{playbackId:id,index:99},admin)).status,400);
  assert.equal((await f.request('/api/page','POST',{playbackId:'old',index:0},admin)).status,409);
});

test('generic guide network hint is optional, validated, persistent and restricted to administrators', async t => {
  const f = await setup(t), admin = await f.login('admin'), phone = await f.login('control');
  assert.equal((await f.request('/api/admin/network/hint', 'POST', { name: 'Studio' }, phone)).status, 401);
  assert.equal((await f.request('/api/admin/network/hint', 'POST', { name: 'x'.repeat(65) }, admin)).status, 400);
  assert.equal((await f.request('/api/admin/network/hint', 'POST', { name: 'a\nb' }, admin)).status, 400);
  assert.equal((await f.request('/api/admin/network/hint', 'POST', { name: ' 演示厅 Wi-Fi ' }, admin)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f.store.settingsFile)).phoneNetworkName, '演示厅 Wi-Fi');
  let info = await (await f.request('/api/admin/system', 'GET', null, admin)).json(); assert.equal(info.phoneNetworkName, '演示厅 Wi-Fi');
  assert.equal((await f.request('/api/admin/network/hint', 'POST', { name: '' }, admin)).status, 200);
  info = await (await f.request('/api/admin/system', 'GET', null, admin)).json(); assert.equal(info.phoneNetworkName, '');
  assert.equal((await f.request('/api/admin/guide-reference/enterprise', 'GET', null, admin)).status, 404);
});

test('remote managers cannot operate native-only lifecycle/settings or read the host data path', async t => {
  const calls = [];
  const f = await setup(t, { autoStartSupported: true, displays: () => [{ id:'led' }], bindDisplay: async () => calls.push('display'), setAutoStart: async () => calls.push('autostart'), setOutputPaused: async () => calls.push('output'), quit: () => calls.push('quit') });
  const remote = await f.login('admin');
  for (const [route, body] of [['display',{id:'led'}],['autostart',{enabled:true}],['output',{paused:false}],['quit',{}]]) {
    assert.equal((await f.request('/api/admin/'+route,'POST',body,remote)).status,403);
  }
  assert.deepEqual(calls,[]);
  const remoteInfo = await (await f.request('/api/admin/system','GET',null,remote)).json();
  assert.equal(remoteInfo.localControls,false); assert.equal(remoteInfo.dataRoot,null); assert.deepEqual(remoteInfo.displays,[]);
  const native=f.native(); const localInfo=await (await f.request('/api/admin/system','GET',null,native)).json();
  assert.equal(localInfo.localControls,true); assert.equal(localInfo.dataRoot,f.store.root);
  for(const [route,body] of [['display',{id:'led'}],['autostart',{enabled:true}],['output',{paused:false}]]) assert.equal((await f.request('/api/admin/'+route,'POST',body,native)).status,200);
  assert.deepEqual(calls,['display','autostart','output']);
});
test('admin logout invalidates only the remote management session and keeps independent phone trust and playback', async t => {
  const f=await setup(t); const admin=await f.login('admin'),phone=await f.login('control'),native=f.native();
  await f.c.switchTo('home','welcome'); const current=structuredClone(f.c.current);
  assert.equal((await f.request('/api/admin/logout','POST',{},native)).status,403);
  const result=await f.request('/api/admin/logout','POST',{},admin+'; '+phone);assert.equal(result.status,200);
  assert.ok(!result.headers.get('set-cookie').includes('livescreen_device'));
  assert.equal((await f.request('/api/admin/library','GET',null,admin)).status,401);
  assert.equal((await f.request('/api/state','GET',null,phone)).status,200);
  assert.equal((await f.request('/api/admin/library','GET',null,native)).status,200);
  assert.deepEqual(f.c.current,current);
});
test('publish status describes saved content, preserves revision conflict checks and never changes live output', async t => {
  const f=await setup(t),admin=await f.login('admin');
  let library=await (await f.request('/api/admin/library','GET',null,admin)).json();assert.equal(library.hasUnpublishedChanges,false);
  const current=structuredClone(f.c.current);library.draft[0].name='Changed';
  const saved=await (await f.request('/api/admin/draft','PUT',{revision:library.draftRevision,projects:library.draft},admin)).json();assert.equal(saved.hasUnpublishedChanges,true);
  assert.equal((await f.request('/api/admin/draft','PUT',{revision:library.draftRevision,projects:library.draft},admin)).status,409);
  const published=await (await f.request('/api/admin/publish','POST',{revision:saved.draftRevision},admin)).json();assert.equal(published.hasUnpublishedChanges,false);
  library=await (await f.request('/api/admin/library','GET',null,admin)).json();assert.equal(library.hasUnpublishedChanges,false);assert.deepEqual(f.c.current,current);
});
test('both browser entry points have public branded favicons and mobile home-screen icons without exposing media', async t => {
  const f=await setup(t);
  for(const page of ['/','/admin']){
    const html=await(await fetch(f.base+page)).text();assert.match(html,/rel="icon"[^>]+favicon\.ico/);assert.match(html,/rel="apple-touch-icon"/);
  }
  for(const [url,mime] of [['/favicon.ico?v=0.3.5','image/vnd.microsoft.icon'],['/icon.svg','image/svg+xml'],['/apple-touch-icon.png','image/png']]){
    const response=await fetch(f.base+url);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp(mime.replace('+','\\+')));assert.ok((await response.arrayBuffer()).byteLength>100);
  }
  assert.equal((await fetch(f.base+'/media/welcome')).status,401);
});

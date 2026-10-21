'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Controller } = require('../src/core/controller.cjs');
const { validateProjects } = require('../src/core/library.cjs');
function setup(t, player = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-flow-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, path.resolve(__dirname, '../examples')); const played = [];
  const c = new Controller(store, { play: async scene => played.push(scene.id), guide: async () => {}, page: async () => {}, ...player });
  c.setOutput({ connected: true }); return { store, c, played };
}
test('last-scene choice restores a committed scene after connection; drafts/tests never replace it', async t => {
  const f = setup(t); f.store.saveSettings({ afterPairingView: 'last-scene', defaultProjectId: 'topic' });
  await f.c.switchTo('home', 'product'); await f.c.testScene(f.store.data.draft[0], f.store.data.draft[0].scenes[0]);
  assert.deepEqual(f.store.settings.lastPlayback, { projectId: 'home', sceneId: 'product' });
  const c = new Controller(f.store, { play: async s => f.played.push(s.id), guide: async () => {} });
  c.setOutput({ connected: true }); await c.startup(); assert.equal(c.current.isGuide, true);
  await c.phoneConnected(); assert.equal(c.current.sceneId, 'product');
});
test('a removed last scene falls back to the configured project default', async t => {
  const { store, c } = setup(t); store.saveSettings({ afterPairingView: 'last-scene', defaultProjectId: 'topic', lastPlayback: { projectId: 'removed', sceneId: 'removed' } });
  await c.startup(); await c.phoneConnected(); assert.equal(c.current.sceneId, 'topic-default');
});
test('phone arriving before LED readiness waits for the guide; later phones do not reset playback', async t => {
  const { c, played } = setup(t); c.setOutput({ connected: false });
  await c.phoneConnected(); assert.deepEqual(played, []);
  c.setOutput({ connected: true }); await c.startup(); assert.equal(c.current.sceneId, 'welcome');
  await c.switchTo('home', 'product'); await c.phoneConnected(); assert.equal(c.current.sceneId, 'product');
});
test('local playback without a phone is preserved when the first phone connects', async t => {
  const { c } = setup(t); await c.startup(); await c.switchTo('home', 'product');
  await c.phoneConnected(); assert.equal(c.current.sceneId, 'product');
});
test('failed automatic playback keeps the guide and records a recoverable error', async t => {
  const { c } = setup(t, { play: async () => { throw new Error('decode failed'); } });
  await c.startup(); await c.phoneConnected(); assert.equal(c.current.isGuide, true); assert.match(c.error, /手机已连接.*decode failed/);
});
test('page changes require renderer acknowledgement and reject stale scene commands', async t => {
  let complete; const { c, store } = setup(t, { page: () => new Promise(resolve => { complete = resolve; }) });
  await c.switchTo('home', 'slides'); const id = c.current.playbackId;
  const job = c.turnPage(id, 'next'); assert.equal(c.busy, true); assert.equal(c.current.pageIndex, 0);
  await assert.rejects(c.turnPage(id, 'previous'), /仍在准备/);
  complete(); await job; assert.equal(c.current.pageIndex, 1);
  assert.deepEqual(store.settings.lastPlayback, { projectId: 'home', sceneId: 'slides' });
  await c.switchTo('home', 'slides'); await assert.rejects(c.turnPage(id, 'next'), /已变化/);
  c.pageChanged({ playbackId: id, pageIndex: 1 }); assert.equal(c.current.pageIndex, 0);
  c.pageChanged({ playbackId: c.current.playbackId, pageIndex: 1 }); assert.equal(c.current.pageIndex, 1);
  c.pageChanged({ playbackId: c.current.playbackId, pageIndex: 99 }); assert.equal(c.current.pageIndex, 1);
  await assert.rejects(c.turnPage(c.current.playbackId, 'invalid'), /方向或目标页码无效/);
});
test('page failure preserves current index; active page count survives later publishing edits', async t => {
  const { c, store } = setup(t, { page: async () => { throw new Error('no ack'); } });
  await c.switchTo('home', 'slides'); const count = c.current.pageCount;
  store.data.published[0].scenes.find(s => s.id === 'slides').assetIds.pop();
  await assert.rejects(c.turnPage(c.current.playbackId, 'next'), /no ack/);
  assert.equal(c.current.pageIndex, 0); assert.equal(c.current.pageCount, count);
});
test('old slideshows remain automatic while invalid modes cannot be saved', t => {
  const { store } = setup(t); const projects = structuredClone(store.data.published);
  assert.equal(validateProjects(projects, store)[0].scenes.find(s => s.id === 'slides').slideshowMode, 'auto');
  projects[0].scenes[0].slideshowMode = 'unknown'; assert.throws(() => validateProjects(projects, store), /多图播放方式/);
});
test('local playback preempts an unfinished phone scene; its late acknowledgement cannot restore the phone scene', async t => {
  let finishRemote, cancelled = 0;
  const { c, store } = setup(t, { play: scene => scene.id === 'product' ? new Promise(resolve => { finishRemote = resolve; }) : Promise.resolve(), cancel: () => { cancelled++; } });
  const remote = c.switchTo('home', 'product', 'remote'); const rejected = assert.rejects(remote, /本地操作接管/);
  await c.switchTo('home', 'welcome', 'local'); assert.equal(c.current.sceneId, 'welcome'); assert.equal(cancelled, 1);
  finishRemote(); await rejected; assert.equal(c.current.sceneId, 'welcome'); assert.equal(c.busy, false);
  assert.deepEqual(store.settings.lastPlayback, { projectId: 'home', sceneId: 'welcome' });
  await assert.rejects(c.switchTo('home', 'loop', 'remote'), /电脑正在操作/);
  c.localPriorityUntil = 0; await c.switchTo('home', 'loop', 'remote'); assert.equal(c.current.sceneId, 'loop');
});
test('a local page can take over an unfinished phone scene and keep the current multi-image scene', async t => {
  let finishRemote; const { c } = setup(t, { play: scene => scene.id === 'product' ? new Promise(resolve => { finishRemote = resolve; }) : Promise.resolve() });
  await c.switchTo('home', 'slides'); const id = c.current.playbackId;
  const remote = c.switchTo('home', 'product'); const rejected = assert.rejects(remote, /本地操作接管/);
  await c.turnPage(id, 'next', 'local'); assert.equal(c.current.sceneId, 'slides'); assert.equal(c.current.pageIndex, 1);
  finishRemote(); await rejected; assert.equal(c.current.sceneId, 'slides');
});
test('a local scene supersedes an unfinished remote page without accepting its late page result', async t => {
  let finishRemote; const { c } = setup(t, { page: () => new Promise(resolve => { finishRemote = resolve; }) });
  await c.switchTo('home', 'slides'); const remote = c.turnPage(c.current.playbackId, 'next'); const rejected = assert.rejects(remote, /本地操作接管/);
  await c.switchTo('home', 'welcome', 'local'); finishRemote(); await rejected;
  assert.equal(c.current.sceneId, 'welcome'); assert.equal(c.current.pageIndex, 0);
});
test('current image preview follows committed pages and the active scene snapshot rather than later publications', async t => {
  let finishPage;
  const { c, store } = setup(t, { page: () => new Promise(resolve => { finishPage = resolve; }) });
  await c.switchTo('home', 'slides');
  const active = structuredClone(c.activeScene), id = c.current.playbackId;
  assert.deepEqual(c.snapshot().current.preview, { assetId: active.assetIds[0], assetIds: active.assetIds, transform: active.transform });
  const published = store.data.published[0].scenes.find(s => s.id === 'slides');
  published.assetIds.reverse(); published.transform.x = 55;
  assert.deepEqual(c.snapshot().current.preview, { assetId: active.assetIds[0], assetIds: active.assetIds, transform: active.transform });
  const page = c.turnPage(id, 'next');
  assert.equal(c.snapshot().current.preview.assetId, active.assetIds[0]);
  finishPage(); await page;
  assert.equal(c.snapshot().current.preview.assetId, active.assetIds[1]);
  c.pageChanged({playbackId:id,pageIndex:0});assert.equal(c.snapshot().current.preview.assetId,active.assetIds[0]);
  c.snapshot().current.preview.transform.x = 99;assert.deepEqual(c.snapshot().current.preview.transform,active.transform);
  await c.showGuide(false,'local');assert.equal(c.snapshot().current.preview,undefined);
});
test('manual page pause policy commits only after player acknowledgement; resume uses the acknowledged actual page', async t => {
  let finish, fail = false, pausedInPlayer;
  const { c, store } = setup(t, { page: (_index,_id,paused) => { pausedInPlayer=paused;return new Promise((resolve,reject)=>{finish=()=>fail?reject(new Error('page failed')):resolve();}); }, setSlideshowPaused: async () => ({pageIndex:0}) });
  store.data.published[0].scenes.find(s=>s.id==='slides').pauseOnManual=true;
  await c.switchTo('home','slides');const id=c.current.playbackId;
  const job=c.turnPage(id,'next');assert.equal(pausedInPlayer,true);assert.equal(c.current.slideshowPaused,false);finish();await job;assert.equal(c.current.slideshowPaused,true);
  fail=true;const bad=c.turnPage(id,'previous');const rejected=assert.rejects(bad,/page failed/);finish();await rejected;assert.equal(c.current.pageIndex,1);assert.equal(c.current.slideshowPaused,true);
  await c.setSlideshowPaused(id,false);assert.equal(c.current.slideshowPaused,false);assert.equal(c.current.pageIndex,0);
  await assert.rejects(c.setSlideshowPaused('stale',true),/场景已变化/);
  await assert.rejects(c.setSlideshowPaused(id,'yes'),/设置无效/);
});
test('an unfinished remote pause cannot overwrite native scene takeover', async t => {
  let finish;const {c}=setup(t,{setSlideshowPaused:()=>new Promise(resolve=>{finish=resolve;})});
  await c.switchTo('home','slides');const pause=c.setSlideshowPaused(c.current.playbackId,true);const rejected=assert.rejects(pause,/本地操作接管/);
  await c.switchTo('home','welcome','local');finish({pageIndex:1});await rejected;assert.equal(c.current.sceneId,'welcome');assert.equal(c.current.slideshowPaused,false);
});
test('old scene pause policy remains off and invalid policy values cannot be published', t => {
  const {store}=setup(t);let projects=structuredClone(store.data.published);
  assert.equal(validateProjects(projects,store)[0].scenes.find(s=>s.id==='slides').pauseOnManual,false);
  projects[0].scenes[0].pauseOnManual='yes';assert.throws(()=>validateProjects(projects,store),/暂停设置无效/);
});

test('direct page selection jumps over intermediate pages, commits after ACK and rejects invalid indices', async t => {
  const calls=[];let finish;
  const {c,store}=setup(t,{page:(index,id,paused)=>{calls.push({index,id,paused});return new Promise(resolve=>{finish=resolve;});}});
  const slides=store.data.published[0].scenes.find(s=>s.id==='slides');slides.assetIds=['welcome','product','product'];slides.slideshowMode='auto';slides.pauseOnManual=true;
  await c.switchTo('home','slides');const id=c.current.playbackId;
  const job=c.turnPage(id,2,'local');assert.equal(c.current.pageIndex,0);assert.deepEqual(calls,[{index:2,id,paused:true}]);finish();await job;
  assert.equal(c.current.pageIndex,2);assert.equal(c.current.slideshowPaused,true);assert.deepEqual(c.snapshot().current.preview.assetIds,slides.assetIds);
  for(const invalid of [-1,3,1.5,NaN,'2',true,null,{}]) await assert.rejects(c.turnPage(id,invalid,'local'),/无效/);
  assert.equal(calls.length,1);assert.equal(c.current.pageIndex,2);
  c.snapshot().current.preview.assetIds.reverse();assert.equal(c.snapshot().current.preview.assetIds[0],'welcome');
});
test('selecting the already active image honors pause-on-manual without changing its page', async t => {
  let requested;const {c,store}=setup(t,{page:async(index,_id,paused)=>{requested={index,paused};}});
  const slides=store.data.published[0].scenes.find(s=>s.id==='slides');slides.pauseOnManual=true;
  await c.switchTo('home','slides');await c.turnPage(c.current.playbackId,0,'local');
  assert.deepEqual(requested,{index:0,paused:true});assert.equal(c.current.pageIndex,0);assert.equal(c.current.slideshowPaused,true);
});

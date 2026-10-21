'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, atomicJSON } = require('../src/core/store.cjs');
const { Controller } = require('../src/core/controller.cjs');
const { validateProjects } = require('../src/core/library.cjs');
const { resolveDisplay } = require('../src/desktop/displays.cjs');
const { privateIP, sameSubnet } = require('../src/core/network.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, path.resolve(__dirname, '../examples'));
  store.saveSettings({ startupView: 'project-default' });
  return store;
}
test('atomic storage preserves old library on invalid serialization', t => {
  const store = setup(t); const old = fs.readFileSync(store.file, 'utf8'); const circular = {}; circular.self = circular;
  assert.throws(() => atomicJSON(store.file, circular)); assert.equal(fs.readFileSync(store.file, 'utf8'), old);
  assert.ok(!fs.readdirSync(store.root).some(f => f.endsWith('.tmp')));
});
test('corrupt existing library fails clearly instead of replacing operator data', t => {
  const store = setup(t); fs.writeFileSync(store.file, '{broken');
  assert.throws(() => new Store(store.root, path.resolve(__dirname, '../examples')));
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});
test('renderer acknowledgement is required; failure retains previous committed scene', async t => {
  const store = setup(t); let finish; let fail = false;
  const controller = new Controller(store, { play: () => fail ? Promise.reject(new Error('decode failed')) : new Promise(r => { finish = r; }) });
  controller.setOutput({ connected: true });
  const job = controller.switchTo('home', 'welcome'); assert.equal(controller.current, null); assert.equal(controller.busy, true);
  await assert.rejects(controller.switchTo('home', 'product'), /仍在准备/);
  finish(); await job; assert.equal(controller.current.sceneId, 'welcome');
  fail = true; await assert.rejects(controller.switchTo('home', 'product'), /decode failed/);
  assert.equal(controller.current.sceneId, 'welcome'); assert.equal(controller.busy, false);
});
test('restart always shows the guide, then the first connected phone activates the configured background', async t => {
  const store = setup(t); const played = []; const player = { play: async s => played.push(s.id), guide: async () => {} };
  const c = new Controller(store, player); await c.switchTo('home', 'loop');
  const restart = new Controller(store, player); restart.setOutput({ connected: true }); await restart.startup();
  assert.equal(restart.current.isGuide, true); assert.deepEqual(played, ['loop']);
  await restart.phoneConnected(); assert.deepEqual(played, ['loop', 'welcome']);
  await restart.phoneConnected(); assert.deepEqual(played, ['loop', 'welcome']);
});
test('missing media cannot replace a good scene', async t => {
  const store = setup(t); let plays = 0; const c = new Controller(store, { play: async () => plays++ });
  await c.switchTo('home', 'welcome'); fs.unlinkSync(store.assetPath('product'));
  await assert.rejects(c.switchTo('home', 'product'), /素材丢失/); assert.equal(plays, 1); assert.equal(c.current.sceneId, 'welcome');
});
test('published validation rejects missing defaults, unsupported types, transforms and unsafe asset paths', t => {
  const store = setup(t);
  for (const change of [p => p[0].defaultSceneId = 'gone', p => p[0].scenes[0].type = 'ppt', p => p[0].scenes[0].transform.scale = 9, p => p[0].scenes[0].assetIds = ['motion'], p => p[0].id = '../x']) {
    const p = structuredClone(store.data.draft); change(p); assert.throws(() => validateProjects(p, store));
  }
  store.data.assets.welcome.file = '../credentials.json'; assert.throws(() => store.assetPath('welcome'));
});
test('display binding survives resolution changes but never follows another ID or a shared name', () => {
  const displays = [{ id: 1, label: 'Desk', internal: false }, { id: 2, label: 'LED', internal: false }];
  assert.equal(resolveDisplay(displays, 1, { id: '2', label: 'LED' }).id, 2);
  assert.equal(resolveDisplay(displays, 1, { id: 'old', label: 'LED' }), null);
  assert.equal(resolveDisplay([{ ...displays[1], bounds: { width: 1280, height: 720 } }], 1, { id: '2', label: 'LED' }).id, 2);
  assert.equal(resolveDisplay(displays, 2, { id: '2', label: 'LED' }), null);
  assert.equal(resolveDisplay([...displays, { id: 3, label: 'LED' }], 1, { id: 'old', label: 'LED' }), null);
  assert.equal(resolveDisplay(displays, 1, null), null);
});
test('disconnect invalidates phone current state', async t => {
  const c = new Controller(setup(t), { play: async () => {}, guide: async () => {} }); await c.startup(); assert.ok(c.current);
  c.setOutput({ connected: false }); assert.equal(c.current, null);
});
test('network whitelist restricts private ranges and subnet', () => {
  assert.equal(privateIP('8.8.8.8'), false); assert.equal(privateIP('172.32.1.1'), false); assert.equal(privateIP('192.168.1.4'), true);
  assert.equal(sameSubnet('192.168.1.5', '192.168.1.10', '255.255.255.0'), true);
  assert.equal(sameSubnet('192.168.2.5', '192.168.1.10', '255.255.255.0'), false);
});
test('guide startup and draft tests never overwrite last formal project, and restore returns to the guide', async t => {
  const store = setup(t); store.saveSettings({ startupView: 'pairing-guide', lastProjectId: 'topic' });
  let guides = 0; const c = new Controller(store, { play: async () => {}, guide: async () => { guides++; } });
  await c.startup(); assert.equal(c.current.isGuide, true); assert.equal(guides, 1);
  await c.testScene(store.data.published[0], store.data.published[0].scenes[0]);
  assert.equal(c.current.isTest, true); assert.equal(store.settings.lastProjectId, 'topic');
  await c.restore(); assert.equal(c.current.isGuide, true); assert.equal(guides, 2);
});

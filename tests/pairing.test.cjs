'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Auth, PIN_AGE } = require('../src/core/auth.cjs');
const { Store } = require('../src/core/store.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-pair-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, auth: new Auth(root) };
}
const req = token => ({ headers: { cookie: `livescreen_device=${token}` } });
test('device trust persists across restarts; rotating random codes never disconnects trusted devices', t => {
  const { root, auth } = setup(t); const first = auth.pairingInfo().pin;
  const paired = auth.pair(first, '127.0.0.1', 'iPhone Safari');
  assert.notEqual(auth.pairingInfo().pin, first);
  auth.refreshPairing(); assert.equal(auth.session(req(paired.token)).role, 'control');
  const restarted = new Auth(root); assert.equal(restarted.session(req(paired.token)).role, 'control');
  assert.equal(restarted.listDevices()[0].name, 'iPhone / Safari');
  const persisted = fs.readFileSync(path.join(root, 'trusted-devices.json'), 'utf8');
  assert.equal(persisted.includes(paired.token), false); assert.equal(persisted.includes(first), false);
  restarted.revokeDevice(paired.device.id); assert.throws(() => restarted.session(req(paired.token)), /配对码/);
});
test('expired pairing code is rejected and refreshes after five minutes', t => {
  const { auth } = setup(t); const previous = auth.pairingInfo();
  t.mock.method(Date, 'now', () => previous.serverTime + PIN_AGE + 1);
  assert.throws(() => auth.pair(previous.pin, '127.0.0.1', ''), /配对码/);
  assert.notEqual(auth.pairingInfo().pin, previous.pin);
});
test('unknown/forged devices cannot control or elevate; forgetting a device revokes it', t => {
  const { auth } = setup(t);
  assert.throws(() => auth.session(req('a'.repeat(64))), /配对码/);
  const paired = auth.pair(auth.pairingInfo().pin, '127.0.0.1', 'Android Chrome');
  assert.throws(() => auth.session(req(paired.token), 'admin'), /管理口令/);
  auth.forget(req(paired.token)); assert.throws(() => auth.session(req(paired.token)), /配对码/);
});
test('changing remote admin password preserves the native operator session', t => {
  const { auth } = setup(t); const native = 'a'.repeat(64);
  auth.sessions.set(native, { role: 'admin', native: true, expires: Number.MAX_SAFE_INTEGER });
  const remote = auth.login('admin', auth.initial.admin, '127.0.0.1');
  auth.set('admin', 'new-password-long-enough');
  assert.equal(auth.session({ headers: { cookie: `livescreen=${native}` } }, 'admin').role, 'admin');
  assert.throws(() => auth.session({ headers: { cookie: `livescreen=${remote}` } }, 'admin'));
});
test('upgrade preserves existing projects and passwords, adds enabled transition defaults', t => {
  const { root, auth } = setup(t); const oldHash = auth.credentials.admin.hash;
  const store = new Store(root, path.resolve(__dirname, '../examples'));
  const published = structuredClone(store.data.published);
  const settings = { ...store.settings, lastProjectId: 'topic' }; delete settings.transition;
  fs.writeFileSync(store.settingsFile, JSON.stringify(settings));
  const reopened = new Store(root, path.resolve(__dirname, '../examples'));
  assert.deepEqual(reopened.data.published, published); assert.equal(reopened.settings.lastProjectId, 'topic');
  assert.deepEqual(reopened.settings.transition, { enabled: true, durationMs: 300 });
  assert.equal(new Auth(root).credentials.admin.hash, oldHash);
});

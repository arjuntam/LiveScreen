'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { Store } = require('../src/core/store.cjs');
const { Auth } = require('../src/core/auth.cjs');
const { Controller } = require('../src/core/controller.cjs');
const { createControlServer } = require('../src/core/server.cjs');
const { interfaces } = require('../src/core/network.cjs');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-network-'));
  const store = new Store(root, path.resolve(__dirname, '../examples')), auth = new Auth(root);
  const controller = new Controller(store, { play: async () => {}, guide: async () => {} });
  const api = createControlServer({ store, auth, controller, webRoot: path.resolve(__dirname, '../web') });
  const port = await api.listen(0), base = `http://127.0.0.1:${port}`;
  t.after(async () => { await api.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { api, port, base, auth };
}
test('failed LAN binding is explicit, retryable and never takes down native management', async t => {
  const f = await fixture(t);
  // TEST-NET addresses and all public/loopback entries must never become LAN listeners.
  let info = await f.api.updateInterfaces([{ name: 'public', address: '192.0.2.1', netmask: '255.255.255.0' }, { name: 'wildcard', address: '0.0.0.0', netmask: '0.0.0.0' }]);
  assert.deepEqual(info.addresses, []);
  const actual = new Set(interfaces().map(i => i.address));
  const unavailable = ['10.254.254.253','172.31.254.253','192.168.254.253'].find(ip => !actual.has(ip));
  info = await f.api.updateInterfaces([{ name: 'disconnected', address: unavailable, netmask: '255.255.255.0' }]);
  assert.deepEqual(info.addresses, []); assert.deepEqual(info.connections, []);
  assert.equal(info.network.errors[0].address, unavailable); assert.ok(info.network.errors[0].code);
  assert.deepEqual(await (await fetch(f.base + '/api/health')).json(), { app: 'LiveScreen', ok: true, port: f.port });
  assert.equal((await fetch(f.base + '/admin')).status, 200);
  info = await f.api.updateInterfaces([]); assert.deepEqual(info.network.errors, []);
});
test('LAN appears after startup, disappears and reconnects without restart, while local SSE remains alive', async t => {
  const actual = interfaces()[0]; assert.ok(actual, 'This integration test requires a private IPv4 interface');
  const f = await fixture(t); const token = 'a'.repeat(64);
  f.auth.sessions.set(token, { role: 'admin', native: true, expires: Number.MAX_SAFE_INTEGER });
  const stream = await fetch(f.base + '/api/events', { headers: { Cookie: `livescreen=${token}` } });
  const reader = stream.body.getReader(); await reader.read();
  t.after(() => reader.cancel().catch(() => {}));
  let info = await f.api.updateInterfaces([actual]);
  const lanURL = info.connections[0].url;
  assert.equal((await fetch(lanURL + '/api/health')).status, 200);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: network/);
  // A netmask change must update the access policy without requiring another listener.
  info = await f.api.updateInterfaces([{ ...actual, netmask: '255.255.255.255' }]);
  assert.equal(info.addresses[0].netmask, '255.255.255.255');
  await f.api.updateInterfaces([]);
  await assert.rejects(fetch(lanURL + '/api/health'));
  assert.equal((await fetch(f.base + '/admin')).status, 200);
  info = await f.api.updateInterfaces([actual]);
  assert.equal(info.connections[0].url, lanURL);
  assert.equal((await fetch(lanURL + '/')).status, 200);
  const forged = await new Promise((resolve, reject) => {
    const req = http.get(lanURL + '/api/health', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(forged, 403);
  await reader.cancel();
});
test('network rebind operations serialize and shutdown releases both LAN and loopback listeners', async t => {
  const actual = interfaces()[0]; assert.ok(actual);
  const f = await fixture(t);
  await Promise.all([f.api.updateInterfaces([actual]), f.api.updateInterfaces([]), f.api.updateInterfaces([actual])]);
  const info = await f.api.networkInfo(); assert.equal(info.addresses.length, 1);
  const pending = f.api.updateInterfaces([]); await f.api.close(); await pending;
  await assert.rejects(fetch(f.base)); await assert.rejects(fetch(info.connections[0].url));
});

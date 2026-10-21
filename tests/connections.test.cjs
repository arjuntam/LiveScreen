'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { buildConnections } = require('../src/core/connections.cjs');
test('offline QR codes decode independently to the exact live control URL, without a PIN or credential', async () => {
  const connections = await buildConnections([{ name: 'LAN', address: '192.168.1.20' }, { name: 'LAN2', address: '10.10.0.5' }], 8080);
  assert.equal(connections.length, 2);
  for (const c of connections) {
    const png = PNG.sync.read(Buffer.from(c.qr.split(',')[1], 'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.equal(decoded.data, `http://${c.address}:8080`); assert.equal(new URL(decoded.data).search, '');
  }
});
test('Wi-Fi URLs precede Ethernet even when the OS lists wired first; unreadable Wi-Fi still has priority', async () => {
  const addresses = [{ name: 'Ethernet', kind: 'ethernet', address: '192.168.2.20' }, { name: 'Wi-Fi', kind: 'wifi', ssid: 'Studio', address: '192.168.1.20' }, { name: 'VPN', kind: 'other', address: '10.0.0.1' }];
  const before = structuredClone(addresses); let links = await buildConnections(addresses, 8080);
  assert.equal(links[0].kind, 'wifi'); assert.equal(links[0].label, 'Wi-Fi · Studio'); assert.equal(links[1].kind, 'ethernet'); assert.deepEqual(addresses, before);
  delete addresses[1].ssid; links = await buildConnections(addresses, 8080);
  assert.equal(links[0].kind, 'wifi'); assert.equal(links[0].label, 'Wi-Fi · 名称暂不可读'); assert.equal(links[1].kind, 'ethernet');
});

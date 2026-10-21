'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNetworkDetector, cleanSSID, parseMacHardware, parseMacSSID, mergeMetadata } = require('../src/desktop/network-info.cjs');
const { buildConnections } = require('../src/core/connections.cjs');
const addresses = [{ name: 'Wi-Fi', address: '192.168.1.20', netmask: '255.255.255.0' }];
test('SSID keeps literal text and meaningful spaces, rejects control or invalid/oversized values', () => {
  assert.equal(cleanSSID(' Studio Wi-Fi '), ' Studio Wi-Fi '); assert.equal(cleanSSID('演示厅网络'), '演示厅网络');
  for (const value of ['', 'x'.repeat(33), 'a\nb', '<\ufffd>', null]) assert.equal(cleanSSID(value), null);
  assert.equal(parseMacSSID('Current Wi-Fi Network: Studio \n'), 'Studio ');
  assert.equal(parseMacSSID('You are not associated with an AirPort network.\n'), null);
  assert.equal(parseMacSSID('Current Wi-Fi Network: <redacted>\n'), null);
});
test('hardware names distinguish wired and wireless; interface aliases are never claimed as SSIDs', async () => {
  const mac = parseMacHardware('Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: omitted\n\nHardware Port: USB Ethernet\nDevice: en1\n');
  assert.deepEqual(mac, [{ name: 'en0', kind: 'wifi' }, { name: 'en1', kind: 'ethernet' }]);
  const metadata = mergeMetadata(addresses, [{ name: 'Alias', addresses: ['192.168.1.20'], kind: 'wifi', ssid: 'Studio', ssidStatus: 'ok' }]);
  assert.equal(metadata[0].ssid, 'Studio');
  const unknown = mergeMetadata(addresses, []); assert.equal(unknown[0].kind, 'other'); assert.equal(unknown[0].ssid, null);
  const links = await buildConnections([{ ...addresses[0], kind: 'ethernet', ssid: null }], 8080);
  assert.equal(links[0].label, '以太网 · Wi-Fi'); assert.equal(links[0].ssid, null);
});
test('Windows detector requests structured current connection data and handles Unicode alias/IP matching', async () => {
  const calls = [];
  const detect = createNetworkDetector({ platform: 'win32', run: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: '\ufeff' + JSON.stringify([{ name: '无线网络', addresses: ['192.168.1.20'], kind: 'wifi', ssid: '演示网络', ssidStatus: 'ok' }]) };
  } });
  assert.equal((await detect(addresses))[0].ssid, '演示网络');
  assert.match(calls[0].file, /WindowsPowerShell.*powershell\.exe$/); assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.timeout, 4000);
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /WlanQueryInterface/); assert.doesNotMatch(script, /GetProfile|key=clear|ExecutionPolicy|Set-Net/);
});
test('SSID metadata caches briefly, IP changes and manual refresh bypass cache, denied reads clear old names', async () => {
  let clock = 0, calls = 0, ssid = 'First';
  const detect = createNetworkDetector({ platform: 'win32', now: () => clock, run: async () => {
    calls++; return { stdout: JSON.stringify([{ name: 'Wi-Fi', kind: 'wifi', ssid, ssidStatus: ssid ? 'ok' : 'denied' }]) };
  } });
  await detect(addresses); await detect(addresses); assert.equal(calls, 1);
  ssid = 'Second'; assert.equal((await detect(addresses, true))[0].ssid, 'Second'); assert.equal(calls, 2);
  await detect([{ ...addresses[0], address: '192.168.1.21' }]); assert.equal(calls, 3);
  ssid = null; clock = 16000; const result = await detect([{ ...addresses[0], address: '192.168.1.21' }]);
  assert.equal(result[0].ssid, null); assert.equal(result[0].ssidStatus, 'denied');
});
test('Mac SSID restriction preserves Wi-Fi type, while Ethernet never queries a Wi-Fi name', async () => {
  const calls = [];
  const detect = createNetworkDetector({ platform: 'darwin', run: async (file, args) => {
    calls.push(args); return { stdout: args[0] === '-listallhardwareports' ? 'Hardware Port: Wi-Fi\nDevice: en0\n\nHardware Port: Ethernet\nDevice: en1\n' : 'You are not associated with an AirPort network.\n' };
  } });
  const data = await detect([{ ...addresses[0], name: 'en0' }, { ...addresses[0], name: 'en1', address: '192.168.2.20' }]);
  assert.equal(data[0].kind, 'wifi'); assert.equal(data[0].ssid, null); assert.equal(data[1].kind, 'ethernet'); assert.equal(calls.length, 2);
});
test('missing tools, malformed output, unsupported OS or timeout never prevent LAN operation', async () => {
  for (const run of [async () => { throw new Error('timeout'); }, async () => ({ stdout: 'not JSON' })]) {
    const detect = createNetworkDetector({ platform: 'win32', run }); const data = await detect(addresses);
    assert.equal(data[0].address, addresses[0].address); assert.equal(data[0].ssid, null);
  }
  const detect = createNetworkDetector({ platform: 'linux', run: async () => { throw new Error('must not execute'); } });
  assert.equal((await detect(addresses))[0].kind, 'other');
});

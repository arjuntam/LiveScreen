'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { crc32, verifyNsis } = require('../scripts/verify-windows.cjs');

test('NSIS checksum matches the standard CRC32 known answer', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
test('installer verification rejects corrupted executable bytes and disabled CRC', () => {
  const exe = Buffer.alloc(4096); exe.write('MZ');
  Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex').copy(exe, 1028);
  exe.writeUInt32LE(exe.length - 1024, 1048);
  exe.writeUInt32LE(crc32(exe.subarray(512, -4)), exe.length - 4);
  assert.equal(verifyNsis(exe).bytes, exe.length);
  const corrupt = Buffer.from(exe); corrupt[700] ^= 0x20;
  assert.throws(() => verifyNsis(corrupt), /CRC mismatch/);
  const disabled = Buffer.from(exe); disabled.writeUInt32LE(4, 1024);
  assert.throws(() => verifyNsis(disabled), /disabled integrity/);
  assert.throws(() => verifyNsis(exe.subarray(0, -1)), /Missing NSIS header/);
});

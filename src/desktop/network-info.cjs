'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
function cleanSSID(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 32 || /[\u0000-\u001f\u007f\ufffd]/u.test(value)) return null;
  return value;
}
function parseMacHardware(text) {
  return text.split(/\r?\n\s*\r?\n/).flatMap(block => {
    const device = /^Device:\s*(\S+)/m.exec(block)?.[1];
    if (!device) return [];
    const label = /^Hardware Port:\s*(.+)/m.exec(block)?.[1] || '';
    return [{ name: device, kind: /Wi-Fi|AirPort/i.test(label) ? 'wifi' : /Ethernet|LAN/i.test(label) ? 'ethernet' : 'other' }];
  });
}
function parseMacSSID(text) {
  // networksetup returns a sentence rather than an SSID when disconnected or privacy-restricted.
  const value = /^Current (?:Wi-Fi|AirPort) Network: (.*)$/m.exec(text.replace(/\r\n/g, '\n'))?.[1];
  if (!value || /^(?:<redacted>|\(null\))$/i.test(value)) return null;
  return cleanSSID(value);
}
function mergeMetadata(addresses, metadata) {
  return addresses.map(a => {
    const meta = metadata.find(m => Array.isArray(m.addresses) && m.addresses.includes(a.address)) || metadata.find(m => m.name === a.name);
    const kind = ['wifi', 'ethernet', 'other'].includes(meta?.kind) ? meta.kind : 'other';
    const ssid = kind === 'wifi' ? cleanSSID(meta?.ssid) : null;
    return { ...a, kind, ssid, ssidStatus: ssid ? 'ok' : meta?.ssidStatus === 'denied' ? 'denied' : 'unavailable' };
  });
}
function createNetworkDetector({ platform = process.platform, run = exec, now = Date.now, ttl = 15000 } = {}) {
  let cached = [], fingerprint = null, checkedAt = -Infinity;
  const command = (file, args) => run(file, args, { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 256 * 1024 });
  return async function detect(addresses, force = false) {
    const key = JSON.stringify(addresses);
    if (!force && key === fingerprint && now() - checkedAt < ttl) return mergeMetadata(addresses, cached);
    let metadata = [];
    try {
      if (addresses.length && platform === 'win32') {
        const script = fs.readFileSync(path.join(__dirname, 'network-info.ps1'), 'utf8');
        const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const { stdout } = await command(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
        const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); metadata = Array.isArray(parsed) ? parsed : [parsed];
      } else if (addresses.length && platform === 'darwin') {
        const { stdout } = await command('/usr/sbin/networksetup', ['-listallhardwareports']);
        metadata = parseMacHardware(stdout).filter(m => addresses.some(a => a.name === m.name));
        await Promise.all(metadata.filter(m => m.kind === 'wifi').map(async m => {
          try { m.ssid = parseMacSSID((await command('/usr/sbin/networksetup', ['-getairportnetwork', m.name])).stdout); } catch { m.ssid = null; }
        }));
      }
    } catch { /* OS restrictions or missing tools must not prevent LAN binding or playback. */ }
    cached = metadata.filter(m => m && typeof m === 'object'); fingerprint = key; checkedAt = now();
    return mergeMetadata(addresses, cached);
  };
}
module.exports = { createNetworkDetector, cleanSSID, parseMacHardware, parseMacSSID, mergeMetadata };

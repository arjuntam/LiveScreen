'use strict';
const QRCode = require('qrcode');
const cache = new Map();
async function buildConnections(addresses, port) {
  const rank = a => a.kind === 'wifi' ? (a.ssid ? 0 : 1) : a.kind === 'ethernet' ? 2 : 3;
  const ordered = [...addresses].sort((a, b) => rank(a) - rank(b));
  return Promise.all(ordered.map(async a => {
    const url = `http://${a.address}:${port}`;
    if (!cache.has(url)) cache.set(url, QRCode.toDataURL(url, { width: 320, margin: 3, errorCorrectionLevel: 'M' }));
    const kind = a.kind || 'other';
    const label = kind === 'wifi' ? (a.ssid ? `Wi-Fi · ${a.ssid}` : 'Wi-Fi · 名称暂不可读') : kind === 'ethernet' ? `以太网 · ${a.name}` : `网络接口 · ${a.name}`;
    return { name: a.name, address: a.address, kind, ssid: a.ssid || null, label, url, qr: await cache.get(url) };
  }));
}
module.exports = { buildConnections };

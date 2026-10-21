'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicJSON } = require('./store.cjs');
const { AppError } = require('./library.cjs');
const hash = (s, salt) => crypto.scryptSync(s, salt, 32).toString('hex');
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const DEVICE_AGE = 365 * 24 * 3600000;
const PIN_AGE = 5 * 60000;
function cookie(req, name) { return new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie || '')?.[1]; }
function deviceName(agent = '') {
  const os = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? '安卓手机' : /Windows/.test(agent) ? 'Windows' : /Macintosh/.test(agent) ? 'Mac' : '浏览器';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox|FxiOS/.test(agent) ? 'Firefox' : /Chrome|CriOS/.test(agent) ? 'Chrome' : /Safari/.test(agent) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' / ');
}
class Auth {
  constructor(root) {
    this.file = path.join(root, 'credentials.json');
    this.sessions = new Map(); this.attempts = new Map();
    if (fs.existsSync(this.file)) this.credentials = JSON.parse(fs.readFileSync(this.file));
    else {
      this.initial = { admin: crypto.randomBytes(12).toString('base64url') };
      this.credentials = {};
      this.set('admin', this.initial.admin);
      // First-install handoff file is local-only, never served by HTTP. Rotate passwords in Settings.
      fs.writeFileSync(path.join(root, '首次安装口令.txt'), `远程管理口令：${this.initial.admin}\n电脑本机无需输入；手机请使用电脑管理页上显示的随机配对码。\n修改远程管理口令后此文件不再有效。\n`, { mode: 0o600 });
    }
    this.devicesFile = path.join(root, 'trusted-devices.json');
    this.devices = fs.existsSync(this.devicesFile) ? JSON.parse(fs.readFileSync(this.devicesFile)) : [];
    this.refreshPairing();
  }
  set(role, secret) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.credentials[role] = { salt, hash: hash(secret, salt) };
    atomicJSON(this.file, this.credentials);
    for (const [token, session] of this.sessions) if (session.role === role && !session.native) this.sessions.delete(token);
  }
  limit(ip) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (now > entry.until) this.attempts.delete(key);
    for (const [key, entry] of this.sessions) if (now > entry.expires) this.sessions.delete(key);
    const attempts = this.attempts.get(ip) || { count: 0, until: now + 60000 };
    if (++attempts.count > 8) throw new AppError('尝试过多，请一分钟后重试', 429);
    this.attempts.set(ip, attempts);
  }
  login(role, secret, ip) {
    // Fixed control PINs from 0.1.0 are deliberately retired; paired devices only receive control access.
    if (role !== 'admin') throw new AppError('手机请使用电脑上显示的随机配对码', 401);
    this.limit(ip);
    if (typeof secret !== 'string' || secret.length > 128) throw new AppError('管理口令不正确', 401);
    const now = Date.now();
    const c = this.credentials[role];
    if (!crypto.timingSafeEqual(Buffer.from(hash(secret, c.salt), 'hex'), Buffer.from(c.hash, 'hex'))) throw new AppError('口令不正确', 401);
    if (this.sessions.size >= 500) this.sessions.delete(this.sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { role, expires: now + 12 * 60 * 60 * 1000 });
    this.attempts.delete(ip); return token;
  }
  refreshPairing() {
    const previous = this.pairing?.pin;
    let pin;
    do { pin = String(crypto.randomInt(100000, 1000000)); } while (pin === previous);
    this.pairing = { pin, expiresAt: Date.now() + PIN_AGE };
    return this.pairingInfo();
  }
  pairingInfo() {
    if (Date.now() >= this.pairing.expiresAt) return this.refreshPairing();
    return { ...this.pairing, serverTime: Date.now(), devices: this.listDevices() };
  }
  pair(pin, ip, agent) {
    this.limit(ip);
    const pairing = this.pairingInfo();
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin) || !crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(pairing.pin))) throw new AppError('配对码不正确或已刷新，请查看电脑上的最新配对码', 401);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const device = { id: crypto.randomUUID(), name: deviceName(agent), tokenHash: digest(token), createdAt: now, lastSeenAt: now, expires: now + DEVICE_AGE };
    const devices = [...this.devices.filter(d => d.expires > now), device];
    if (devices.length > 100) throw new AppError('已信任设备达到 100 台，请在电脑上移除旧设备', 409);
    this.saveDevices(devices); this.attempts.delete(ip); this.refreshPairing();
    return { token, device: { id: device.id, name: device.name }, maxAge: DEVICE_AGE / 1000 };
  }
  saveDevices(devices) { atomicJSON(this.devicesFile, devices); this.devices = devices; }
  listDevices() { return this.devices.filter(d => d.expires > Date.now()).map(({ tokenHash, ...d }) => d); }
  revokeDevice(id) {
    if (!this.devices.some(d => d.id === id)) throw new AppError('设备已移除或不存在', 404);
    this.saveDevices(this.devices.filter(d => d.id !== id));
  }
  forget(req) {
    const token = cookie(req, 'livescreen_device');
    if (token) this.saveDevices(this.devices.filter(d => d.tokenHash !== digest(token)));
  }
  session(req, required = 'control') {
    const token = cookie(req, 'livescreen');
    const s = this.sessions.get(token);
    if (s && Date.now() < s.expires && (required !== 'admin' || s.role === 'admin')) return s;
    if (required !== 'admin') {
      const deviceToken = cookie(req, 'livescreen_device');
      const device = deviceToken && this.devices.find(d => d.tokenHash === digest(deviceToken) && d.expires > Date.now());
      if (device) {
        // No per-heartbeat disk writes. Persist last-use at most once per hour.
        if (Date.now() - device.lastSeenAt > 3600000) this.saveDevices(this.devices.map(d => d.id === device.id ? { ...d, lastSeenAt: Date.now() } : d));
        return { role: 'control', expires: device.expires, deviceId: device.id, deviceName: device.name };
      }
    }
    throw new AppError(required === 'admin' ? '请先输入远程管理口令' : '请先使用电脑上的配对码连接', 401);
  }
}
module.exports = { Auth, PIN_AGE, DEVICE_AGE };

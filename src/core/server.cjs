'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { isDeepStrictEqual } = require('node:util');
const { AppError, validateProjects } = require('./library.cjs');
const { ipv4, privateIP, sameSubnet } = require('./network.cjs');
const { buildConnections } = require('./connections.cjs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.ico': 'image/vnd.microsoft.icon', '.svg': 'image/svg+xml' };
const UPLOAD_MAX = 512 * 1024 * 1024;
async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new AppError('请求超过 2 MB', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError('JSON 格式错误'); }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function serveFile(req, res, file) {
  if (!fs.existsSync(file)) throw new AppError('文件不存在', 404);
  const stat = fs.statSync(file);
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  let start = 0; let end = stat.size - 1; let status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) throw new AppError('Range 不受支持', 416);
    if (!m[1]) start = Math.max(0, stat.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= stat.size) { res.setHeader('Content-Range', `bytes */${stat.size}`); throw new AppError('Range 超出文件', 416); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
async function upload(req, store) {
  let name;
  try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { throw new AppError('文件名编码错误'); }
  const ext = path.extname(name).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.mp4'].includes(ext)) throw new AppError('仅支持 PNG、JPG、WebP 和 H.264 MP4');
  const size = Number(req.headers['content-length']);
  if (!Number.isInteger(size) || size <= 0 || size > UPLOAD_MAX) throw new AppError('单个文件需在 1 B–512 MB 之间', 413);
  const disk = fs.statfsSync(store.mediaDir);
  if (Number(disk.bavail) * Number(disk.bsize) < size + 1024 ** 3) throw new AppError('磁盘空间不足，需保留至少 1 GB', 507);
  const id = crypto.randomUUID(); const file = id + ext; const temp = path.join(store.mediaDir, file + '.part');
  let received = 0; const first = [];
  const meter = new Transform({ transform(chunk, enc, cb) {
    received += chunk.length; if (received <= 4096 || first.length === 0) first.push(chunk.subarray(0, 32));
    cb(received > size ? new AppError('上传长度超出声明大小', 413) : null, chunk);
  } });
  try {
    await pipeline(req, meter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (received !== size) throw new AppError('上传未完整到达');
    const head = Buffer.concat(first);
    const valid = ext === '.mp4' ? head.subarray(4, 8).toString() === 'ftyp'
      : ext === '.png' ? head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : ext === '.webp' ? head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP'
      : head[0] === 255 && head[1] === 216 && head[2] === 255;
    if (!valid) throw new AppError('文件内容与扩展名不符');
    fs.renameSync(temp, path.join(store.mediaDir, file));
    const asset = { id, file, name: path.basename(name).slice(0, 160), kind: ext === '.mp4' ? 'video' : 'image', bytes: size };
    store.save({ ...store.data, assets: { ...store.data.assets, [id]: asset } });
    return asset;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function createControlServer({ store, controller, auth, webRoot, desktop = {}, allowedInterfaces = [], presentationImporter }) {
  const clients = new Set(); const servers = []; const sockets = new Set();
  let closed = false, closePromise, listenerPort, networkErrors = [], networkUpdatedAt = null;
  let networkWork = Promise.resolve();
  function event(res, state) { res.write(`data: ${JSON.stringify(state)}\n\n`); }
  function pairingChanged() {
    for (const c of clients) {
      try { auth.session(c.req, 'admin'); if (!c.res.destroyed) c.res.write('event: pairing\ndata: {}\n\n'); }
      catch { /* Pairing details are visible only to operators. */ }
    }
  }
  function networkChanged() {
    for (const c of clients) {
      try { auth.session(c.req, 'admin'); if (!c.res.destroyed) c.res.write('event: network\ndata: {}\n\n'); }
      catch { /* Network details are visible only to operators. */ }
    }
  }
  const broadcast = state => { for (const c of clients) {
    try { auth.session(c.req); if (!c.res.destroyed) event(c.res, state); else clients.delete(c); }
    catch { c.res.end(); clients.delete(c); }
  } };
  controller.on('state', broadcast);
  const heartbeat = setInterval(() => { for (const c of clients) {
    try { auth.session(c.req); c.res.write(': heartbeat\n\n'); } catch { c.res.end(); clients.delete(c); }
  } }, 3000); heartbeat.unref();
  async function handler(req, res) {
    if (closed) { res.writeHead(503, { Connection: 'close' }); res.end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const remote = ipv4(req.socket.remoteAddress);
      if (remote !== '127.0.0.1' && !(privateIP(remote) && allowedInterfaces.some(i => sameSubnet(remote, i.address, i.netmask)))) throw new AppError('只允许本机或受信任局域网访问', 403);
      const host = req.headers.host;
      const localHost = req.socket.localAddress?.replace(/^::ffff:/, '');
      if (host !== `${localHost}:${req.socket.localPort}` && !(localHost === '127.0.0.1' && host === `localhost:${req.socket.localPort}`)) throw new AppError('主机地址不受信任', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError('跨站请求已拒绝', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('跨站请求已拒绝', 403);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-livescreen'] !== '1') throw new AppError('缺少操作验证标记', 403);
      const url = new URL(req.url, `http://${host}`); const route = url.pathname;
      if (req.method === 'GET' && route === '/api/health') return json(res, 200, { app: 'LiveScreen', ok: true, port: req.socket.localPort });
      if (req.method === 'POST' && route === '/api/pair') {
        const body = await jsonBody(req); const result = auth.pair(body.pin, remote, req.headers['user-agent']);
        res.setHeader('Set-Cookie', `livescreen_device=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${result.maxAge}`);
        store.log('device-paired', { deviceId: result.device.id });
        pairingChanged();
        void controller.phoneConnected();
        return json(res, 200, { ok: true, device: result.device });
      }
      if (req.method === 'POST' && route === '/api/login') {
        const body = await jsonBody(req); const token = auth.login(body.role, body.secret, remote);
        res.setHeader('Set-Cookie', `livescreen=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return json(res, 200, { ok: true, role: body.role });
      }
      if (req.method === 'POST' && route === '/api/logout') {
        const token = /livescreen=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; auth.sessions.delete(token);
        auth.forget(req);
        res.setHeader('Set-Cookie', ['livescreen=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'livescreen_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/logout') {
        const current = auth.session(req, 'admin');
        if (current.native) throw new AppError('请在本机软件中使用退出软件', 403);
        const token = /(?:^|;\s*)livescreen=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        auth.sessions.delete(token); res.setHeader('Set-Cookie', 'livescreen=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (route.startsWith('/api/admin/')) {
        const admin = auth.session(req, 'admin');
        if (['/api/admin/quit', '/api/admin/display', '/api/admin/autostart', '/api/admin/output'].includes(route) && !admin.native) throw new AppError('此操作仅限大屏电脑本机软件，远程管理无法执行', 403);
      }
      else if (route.startsWith('/api/') || route.startsWith('/media/')) auth.session(req);
      if (req.method === 'GET' && route === '/api/session') {
        const s = auth.session(req); return json(res, 200, { role: s.role, native: !!s.native, deviceName: s.deviceName || null });
      }
      if (req.method === 'GET' && route === '/api/state') {
        if (auth.session(req).role === 'control') void controller.phoneConnected();
        return json(res, 200, controller.snapshot());
      }
      if (req.method === 'GET' && route === '/api/events') {
        if (auth.session(req).role === 'control') void controller.phoneConnected();
        if (clients.size >= 100) throw new AppError('连接数已达上限', 503);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
        const client = { req, res, expires: auth.session(req).expires }; clients.add(client); event(res, controller.snapshot());
        req.on('close', () => clients.delete(client)); return;
      }
      if (req.method === 'POST' && route === '/api/switch') {
        const b = await jsonBody(req); const source = auth.session(req).native ? 'local' : 'remote';
        if (source === 'remote' && b.controlGeneration !== controller.controlGeneration) throw new AppError('电脑已接管，请稍候再操作；旧页面请刷新。', 409);
        const current = await controller.switchTo(b.projectId, b.sceneId, source); return json(res, 200, { current });
      }
      if (req.method === 'POST' && route === '/api/page') {
        const b = await jsonBody(req); const source = auth.session(req).native ? 'local' : 'remote';
        if (source === 'remote' && b.controlGeneration !== controller.controlGeneration) throw new AppError('电脑已接管，请稍候再操作；旧页面请刷新。', 409);
        if (Object.hasOwn(b, 'index') && Object.hasOwn(b, 'direction')) throw new AppError('目标页码和翻页方向不能同时提交');
        return json(res, 200, { current: await controller.turnPage(b.playbackId, Object.hasOwn(b, 'index') ? b.index : b.direction, source) });
      }
      if (req.method === 'POST' && route === '/api/slideshow') {
        const b = await jsonBody(req); const source = auth.session(req).native ? 'local' : 'remote';
        if (source === 'remote' && b.controlGeneration !== controller.controlGeneration) throw new AppError('电脑已接管，请稍候再操作；旧页面请刷新。', 409);
        return json(res, 200, { current: await controller.setSlideshowPaused(b.playbackId, b.paused, source) });
      }
      if (req.method === 'GET' && route === '/api/admin/library') return json(res, 200, { ...store.data, hasUnpublishedChanges: !isDeepStrictEqual(store.data.draft, store.data.published) });
      if (route.startsWith('/api/admin/imports')) {
        if (!presentationImporter) throw new AppError('此运行环境未启用文稿导入，请使用正式软件', 503);
        if (req.method === 'GET' && route === '/api/admin/imports/capabilities') return json(res,200,await presentationImporter.capabilities());
        if (req.method === 'POST' && route === '/api/admin/imports/upload') return json(res,202,await presentationImporter.upload(req));
        const match = /^\/api\/admin\/imports\/([a-f0-9-]{36})(?:\/(commit|pages\/(\d+)\.png))?$/.exec(route);
        if (!match) throw new AppError('导入地址无效',404);
        if (req.method === 'GET' && match[3] !== undefined) return serveFile(req,res,presentationImporter.page(match[1],Number(match[3])));
        if (req.method === 'GET' && !match[2]) return json(res,200,presentationImporter.get(match[1]));
        if (req.method === 'POST' && match[2] === 'commit') return json(res,200,presentationImporter.commit(match[1],await jsonBody(req)));
        if (req.method === 'DELETE' && !match[2]) { await presentationImporter.cancel(match[1]); return json(res,200,{ok:true}); }
        throw new AppError('导入操作无效',404);
      }
      if (req.method === 'POST' && route === '/api/admin/test-scene') {
        const b = await jsonBody(req);
        const [project] = validateProjects([{ id: b.projectId, name: b.projectName, defaultSceneId: b.scene?.id, scenes: [b.scene] }], store);
        return json(res, 200, { current: await controller.testScene(project, project.scenes[0], auth.session(req).native ? 'local' : 'remote') });
      }
      if (req.method === 'POST' && route === '/api/admin/test/restore') return json(res, 200, { current: await controller.restore(auth.session(req).native ? 'local' : 'remote') });
      if (req.method === 'POST' && route === '/api/admin/guide') return json(res, 200, { current: await controller.showGuide(false, auth.session(req).native ? 'local' : 'remote') });
      if (req.method === 'POST' && route === '/api/admin/startup') {
        const b = await jsonBody(req);
        if (!['project-default', 'last-scene'].includes(b.afterPairingView)) throw new AppError('手机连接后播放选项无效');
        if (b.defaultProjectId !== null && !store.data.published.some(p => p.id === b.defaultProjectId)) throw new AppError('请选择已发布的默认背景项目');
        store.saveSettings({ startupView: 'pairing-guide', afterPairingView: b.afterPairingView, defaultProjectId: b.defaultProjectId });
        return json(res, 200, { afterPairingView: b.afterPairingView, defaultProjectId: b.defaultProjectId });
      }
      if (req.method === 'GET' && route === '/api/admin/pairing') return json(res, 200, auth.pairingInfo());
      if (req.method === 'POST' && route === '/api/admin/pairing/refresh') { const result = auth.refreshPairing(); pairingChanged(); return json(res, 200, result); }
      if (req.method === 'POST' && route === '/api/admin/devices/revoke') {
        const b = await jsonBody(req); auth.revokeDevice(b.id); store.log('device-revoked', { deviceId: b.id });
        controller.notify(); pairingChanged(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/playback') {
        const b = await jsonBody(req);
        if (typeof b.enabled !== 'boolean' || !Number.isInteger(b.durationMs) || b.durationMs < 100 || b.durationMs > 1000) throw new AppError('渐变时长需在 100–1000 毫秒之间');
        store.saveSettings({ transition: { enabled: b.enabled, durationMs: b.durationMs } });
        return json(res, 200, { transition: store.settings.transition });
      }
      if (req.method === 'PUT' && route === '/api/admin/draft') {
        const b = await jsonBody(req);
        if (b.revision !== store.data.draftRevision) throw new AppError('草稿已被另一管理端更新，请先重新载入', 409);
        const draft = validateProjects(b.projects, store, true);
        store.save({ ...store.data, draft, draftRevision: store.data.draftRevision + 1 });
        return json(res, 200, { draftRevision: store.data.draftRevision, hasUnpublishedChanges: !isDeepStrictEqual(store.data.draft, store.data.published) });
      }
      if (req.method === 'POST' && route === '/api/admin/publish') {
        const b = await jsonBody(req);
        if (b.revision !== store.data.draftRevision) throw new AppError('草稿已变化，请重新载入后发布', 409);
        const published = validateProjects(store.data.draft, store);
        store.save({ ...store.data, published, revision: store.data.revision + 1 });
        store.log('published', { revision: store.data.revision }); controller.notify();
        // Publishing changes the catalogue, never the live frame.
        return json(res, 200, { revision: store.data.revision, hasUnpublishedChanges: false });
      }
      if (req.method === 'POST' && route === '/api/admin/upload') return json(res, 201, await upload(req, store));
      if (req.method === 'POST' && route === '/api/admin/network/hint') {
        const b = await jsonBody(req);
        if (typeof b.name !== 'string' || b.name.length > 64 || /[\u0000-\u001f\u007f]/u.test(b.name)) throw new AppError('网络名称请填写 64 字以内的单行文字');
        store.saveSettings({ phoneNetworkName: b.name.trim() });
        networkChanged(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/network/refresh') {
        await desktop.refreshNetwork?.(); return json(res, 200, await networkInfo());
      }
      if (req.method === 'GET' && route === '/api/admin/system') {
        const native = !!auth.session(req, 'admin').native;
        return json(res, 200, { settings: { ...store.settings, port: servers[0]?.address()?.port || store.settings.port }, ...(await networkInfo()),
          displays: native ? desktop.displays?.() || [] : [], platform: process.platform, localControls: native,
          dataRoot: native ? store.root : null, preview: native && !!desktop.preview, autoStartSupported: native && (desktop.autoStartSupported || false),
          autoStartStatus: native ? desktop.loginStatus?.() || null : null, outputSize: desktop.outputSize?.() || null });
      }
      if (req.method === 'POST' && route === '/api/admin/display') {
        const b = await jsonBody(req); await desktop.bindDisplay?.(b.id); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/autostart') {
        const b = await jsonBody(req);
        if (typeof b.enabled !== 'boolean' || !desktop.autoStartSupported) throw new AppError('请在 Windows 或 Mac 正式安装版中配置登录自启');
        if (b.silent !== undefined && typeof b.silent !== 'boolean') throw new AppError('静默启动设置无效');
        await desktop.setAutoStart(b.enabled, b.silent ?? store.settings.silentAutoStart); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/output') {
        const b = await jsonBody(req);
        if (typeof b.paused !== 'boolean' || !desktop.setOutputPaused) throw new AppError('请在桌面软件中操作大屏输出');
        await desktop.setOutputPaused(b.paused); return json(res, 200, { paused: store.settings.outputPaused });
      }
      if (req.method === 'POST' && route === '/api/admin/password') {
        const b = await jsonBody(req);
        if (b.role !== 'admin' || typeof b.secret !== 'string' || b.secret.length < 12 || b.secret.length > 128) throw new AppError('远程管理口令至少 12 位；手机使用随机配对码');
        auth.set(b.role, b.secret); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/admin/quit') {
        if (!desktop.quit) throw new AppError('请通过桌面程序退出');
        json(res, 200, { ok: true }); setTimeout(() => desktop.quit(), 100); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && /^\/media\/[a-zA-Z0-9_-]+$/.test(route)) return serveFile(req, res, store.assetPath(route.slice(7)));
      const staticFiles = { '/favicon.ico': '../assets/livescreen.ico', '/icon.svg': '../assets/livescreen.svg', '/apple-touch-icon.png': '../assets/livescreen.png', '/': 'index.html', '/admin': 'admin.html', '/app.js': 'app.js', '/admin.js': 'admin.js', '/presentation.js': 'presentation.js', '/common.js': 'common.js', '/style.css': 'style.css', '/tokens.css': 'tokens.css' };
      if (['GET', 'HEAD'].includes(req.method) && staticFiles[route]) return serveFile(req, res, path.join(webRoot, staticFiles[route]));
      throw new AppError('页面或接口不存在', 404);
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(res, e.status || 500, { error: e.status ? e.message : '服务处理失败，请查看本机日志' });
      else if (!res.destroyed) res.end();
      if (!e.status) store.log('http-error', { error: e.message });
    }
  }
  async function openListener(port, host) {
    const server = http.createServer(handler); server.requestTimeout = 120000; server.headersTimeout = 15000;
    const ownedSockets = new Set();
    server.on('connection', socket => {
      if (closed) { socket.destroy(); return; }
      sockets.add(socket); ownedSockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); ownedSockets.delete(socket); });
    });
    server.on('error', error => store.log('listener-error', { address: host, code: error.code }));
    await new Promise((resolve, reject) => {
      const fail = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', fail); resolve(); };
      server.once('error', fail); server.once('listening', ready); server.listen(port, host);
    });
    server.lanHost = host; server.ownedSockets = ownedSockets;
    servers.push(server); return server;
  }
  function closeListener(server) {
    const done = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); for (const socket of server.ownedSockets) socket.destroy();
    return done;
  }
  async function networkInfo() {
    return { phoneNetworkName: store.settings.phoneNetworkName || '', addresses: structuredClone(allowedInterfaces), connections: await buildConnections(allowedInterfaces, listenerPort || store.settings.port),
      network: { port: listenerPort || store.settings.port, updatedAt: networkUpdatedAt, errors: structuredClone(networkErrors) } };
  }
  return {
    async listen(port = 8080, hosts = ['127.0.0.1']) {
      try {
        for (const host of hosts) {
          const server = await openListener(port, host);
          if (port === 0) port = server.address().port;
        }
        listenerPort = port;
      } catch (e) { await this.close(); throw e; }
      return port;
    },
    // Rebind only private IPv4 interfaces. Loopback and active local playback stay up.
    updateInterfaces(next) {
      const requested = [...new Map(next.filter(i => privateIP(i.address) && /^\d+\.\d+\.\d+\.\d+$/.test(i.netmask || ''))
        .map(i => [i.address, { name: String(i.name), address: i.address, netmask: i.netmask, kind: ['wifi', 'ethernet', 'other'].includes(i.kind) ? i.kind : 'other', ssid: typeof i.ssid === 'string' ? i.ssid : null, ssidStatus: i.ssidStatus || 'unavailable' }])).values()];
      const update = async () => {
        if (closed) return networkInfo();
        const before = JSON.stringify([allowedInterfaces, networkErrors]);
        allowedInterfaces = allowedInterfaces.filter(i => requested.some(n => n.address === i.address));
        for (const server of [...servers]) {
          if (server.lanHost === '127.0.0.1' || requested.some(i => i.address === server.lanHost)) continue;
          servers.splice(servers.indexOf(server), 1); await closeListener(server);
        }
        const errors = [];
        for (const item of requested) {
          if (closed) break;
          if (servers.some(s => s.lanHost === item.address)) continue;
          try { await openListener(listenerPort, item.address); }
          catch (error) { errors.push({ name: item.name, address: item.address, code: error.code || 'LISTEN_FAILED' }); }
        }
        allowedInterfaces = requested.filter(i => servers.some(s => s.lanHost === i.address));
        networkErrors = errors; networkUpdatedAt = new Date().toISOString();
        if (before !== JSON.stringify([allowedInterfaces, networkErrors])) {
          store.log('network-updated', { addresses: allowedInterfaces.map(({ name, address, netmask, kind }) => ({ name, address, netmask, kind })), errors });
          networkChanged();
        }
        return networkInfo();
      };
      networkWork = networkWork.then(update, update); return networkWork;
    },
    networkInfo,
    close() {
      if (closed) return closePromise; closed = true;
      clearInterval(heartbeat); controller.off('state', broadcast);
      for (const c of clients) c.res.end(); clients.clear();
      closePromise = networkWork.catch(() => {}).then(() => Promise.all([...servers.map(closeListener), presentationImporter?.close()]));
      return closePromise;
    }
  };
}
module.exports = { createControlServer, serveFile, UPLOAD_MAX };

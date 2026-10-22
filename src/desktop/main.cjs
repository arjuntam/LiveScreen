'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog, Menu, Tray, nativeImage, powerSaveBlocker, session, shell } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Store } = require('../core/store.cjs');
const { Auth } = require('../core/auth.cjs');
const { Controller } = require('../core/controller.cjs');
const { createControlServer } = require('../core/server.cjs');
const { interfaces } = require('../core/network.cjs');
const { createNetworkDetector } = require('./network-info.cjs');
const detectNetwork = createNetworkDetector();
const { buildConnections } = require('../core/connections.cjs');
const { bindingFor, resolveDisplay, describe } = require('./displays.cjs');
const { createShutdown } = require('./shutdown.cjs');
const { createLoginItems, silentLoginLaunch } = require('./login-items.cjs');
const { outputWindowOptions, positionOutputWindow } = require('./output-window.cjs');
const { createPresentationImporter } = require('../core/presentation-import.cjs');
const { createPresentationAdapter } = require('./presentation-adapter.cjs');
const root = path.resolve(__dirname, '../..');
const packagedPreview = process.platform === 'darwin' && app.isPackaged && require(path.join(root, 'package.json')).livescreenPreview === true;
const preview = packagedPreview || (!app.isPackaged && process.argv.includes('--dev-preview'));
const smoke = !app.isPackaged && process.argv.includes('--smoke-test');
const loginItems = createLoginItems(app, process.platform, preview || smoke);
let store, auth, controller, api, operator, playerWindow, tray, pending, quitting = false, reconciling = false, retryTimer, guideTimer, blocker, baseURL;
let connections = [], networkTimer, networkRefreshing, lastNetworkMetadata = [];
let activeDisplayId = null, previewPhoneWindow;
const dataArg = !app.isPackaged && process.argv.find(a => a.startsWith('--data-dir='));
if (packagedPreview) app.setPath('userData', path.join(app.getPath('appData'), 'LiveScreen-Preview'));
else if (process.platform === 'darwin' && app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'LiveScreen'));
if (dataArg) app.setPath('userData', dataArg.slice(11));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);
else {
  app.on('second-instance', showOperator);
  app.whenReady().then(start).catch(async e => { if (quitting) return; store?.log('startup-error', { error: e.message }); dialog.showErrorBox('LiveScreen 启动失败', e.message); await quit(); });
}
function rejectPending(message) {
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = null; }
}
const player = {
  play(scene) {
    return prepare({ scene, sources: scene.assetIds.map(a => pathToFileURL(store.assetPath(a)).href) });
  },
  guide() { return prepare({ kind: 'guide', guide: guideInfo() }); },
  page(index, playbackId, paused) { return sendPlayerCommand('page', { index, playbackId, paused }, 5000); },
  setSlideshowPaused(paused, playbackId) { return sendPlayerCommand('slideshow', { paused, playbackId }, 5000); },
  cancel() {
    if (pending) { playerWindow?.webContents.send('cancel', pending.id); rejectPending('电脑本地操作已接管'); }
  }
};
function guideInfo() {
  const { pin, expiresAt } = auth.pairingInfo();
  return { pin, expiresAt, connections, phoneNetworkName: store.settings.phoneNetworkName || '', isPreview: preview || smoke };
}
function prepare(content) {
    return sendPlayerCommand('prepare', { ...content, transition: store.settings.transition, deadline: Date.now() + 18000 }, 20000);
}
function sendPlayerCommand(channel, content, timeout) {
    if (!playerWindow || playerWindow.isDestroyed() || !playerWindow.readyForScene) return Promise.reject(new Error('LED 尚未就绪，请在管理页检查显示器绑定'));
    if (pending) return Promise.reject(new Error('播放器仍在准备上一场景'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        playerWindow?.webContents.send('cancel', id); pending = null;
        reject(new Error(channel === 'page' ? '翻页未得到播放器确认，请重试' : '素材准备超过 20 秒，已保留原画面'));
      }, timeout);
      pending = { id, resolve, reject, timer };
      playerWindow.webContents.send(channel, { id, ...content });
    });
}
async function start() {
  if (process.platform === 'win32') app.setAppUserModelId('local.livescreen.player');
  store = new Store(app.getPath('userData'), path.join(root, 'examples'));
  auth = new Auth(store.root); controller = new Controller(store, player);
  const portArg = !app.isPackaged && process.argv.find(a => a.startsWith('--port='));
  const presentationImporter = createPresentationImporter({ store, adapter: createPresentationAdapter({ BrowserWindow, ipcMain }) });
  api = createControlServer({ store, controller, auth, webRoot: path.join(root, 'web'), allowedInterfaces: [], presentationImporter,
    desktop: {
      displays: () => screen.getAllDisplays().map(d => describe(d, screen.getPrimaryDisplay().id)),
      outputSize: () => {
        const d = resolveDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, store.settings.display);
        return d ? { width:d.bounds.width, height:d.bounds.height, scaleFactor:d.scaleFactor || 1 } : preview || smoke ? { width:960, height:540, preview:true } : null;
      },
      bindDisplay: async id => {
        const d = screen.getAllDisplays().find(d => String(d.id) === String(id));
        if (!d || d.id === screen.getPrimaryDisplay().id || d.internal) throw Object.assign(new Error('请选择非主显示器的外接 LED 扩展屏'), { status: 400 });
        store.saveSettings({ display: bindingFor(d) }); await reconcile();
      },
      autoStartSupported: loginItems.supported, loginStatus: loginItems.read,
      setAutoStart: (enabled, silent) => { const state = loginItems.set(enabled); store.saveSettings({ autoStart: state.requested, silentAutoStart: silent }); },
      preview: preview || smoke, setOutputPaused, refreshNetwork: () => refreshNetwork(true),
      quit
    }
  });
  const port = await api.listen(portArg ? Number(portArg.slice(7)) : packagedPreview ? 0 : store.settings.port, ['127.0.0.1']);
  baseURL = `http://127.0.0.1:${port}`;
  await refreshNetwork();
  networkTimer = setInterval(() => { refreshNetwork().catch(error => store.log('network-error', { error: error.message })); }, 5000);
  // Authentication remains required even for loopback. Only this native operator window receives its own session.
  const desktopToken = crypto.randomBytes(32).toString('hex');
  auth.sessions.set(desktopToken, { role: 'admin', native: true, expires: Number.MAX_SAFE_INTEGER });
  await session.defaultSession.cookies.set({ url: baseURL, name: 'livescreen', value: desktopToken, httpOnly: true, sameSite: 'strict' });
  const loginState = loginItems.read();
  // Honor changes made in System Settings. Never silently re-register a Mac
  // login item that the user has disabled outside LiveScreen.
  if (loginItems.supported && loginState.status !== 'unavailable') store.saveSettings({ autoStart: loginState.requested });
  const silentLaunch = silentLoginLaunch({ platform: process.platform, args: process.argv, login: loginState, settings: store.settings });
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  operator = new BrowserWindow({ width: Math.min(1440, workArea.width), height: Math.min(900, workArea.height), minWidth: 760, minHeight: 600, show: !smoke && !silentLaunch,
    icon: path.join(root, 'assets/livescreen.png'), backgroundColor: '#f3f5f9', webPreferences: { preload: path.join(__dirname, 'operator-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  ipcMain.handle('operator-command', async (event, command) => {
    const trustedWindow = operator && !operator.isDestroyed() && event.sender === operator.webContents;
    if (!trustedWindow || event.senderFrame !== event.sender.mainFrame || new URL(event.sender.getURL()).origin !== baseURL) throw new Error('无权执行本机操作');
    if (command === 'quit') { setTimeout(quit, 100); return { ok: true }; }
    if ((preview || smoke) && command === 'preview-player') { playerWindow?.show(); playerWindow?.focus(); return { ok: true }; }
    if ((preview || smoke) && command === 'preview-phone') { await showPreviewPhone(); return { ok: true }; }
    throw new Error('不支持的本机操作');
  });
  operator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  operator.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseURL + '/admin')) e.preventDefault();
  });
  operator.on('close', e => { if (!quitting) { e.preventDefault(); tray ? operator.hide() : operator.minimize(); } });
  await operator.loadURL(baseURL + '/admin');
  try {
    const iconPath = path.join(root, 'assets', process.platform === 'win32' ? 'livescreen.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'livescreen.png');
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('托盘图标资源未加载');
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(process.platform === 'win32' ? iconPath : process.platform === 'darwin' ? image : image.resize({ width: 24, height: 24 }));
    tray.setToolTip('LiveScreen · 大屏内容管理');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开大屏管理', click: showOperator },
      { label: '隐藏管理窗口，继续播放', click: () => operator?.hide() },
      { label: '暂停大屏输出', click: () => setOutputPaused(true) },
      { label: '恢复大屏输出', click: () => setOutputPaused(false) },
      { type: 'separator' },
      { label: '退出软件', click: quit }
    ]));
    tray.on('double-click', showOperator);
    if (process.platform !== 'darwin') tray.on('click', showOperator);
    store.log('tray-ready');
  } catch (error) { store.log('tray-error', { error: error.message }); if (!smoke) showOperator(); }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'LiveScreen', submenu: [
      ...(process.platform === 'darwin' ? [{ role: 'about', label: '关于 LiveScreen' }, { type: 'separator' }] : []),
      { label: '打开大屏管理', click: showOperator },
      ...(preview || smoke ? [{ label: '打开模拟大屏', click: () => playerWindow?.show() }, { label: '打开手机预览', click: showPreviewPhone }] : []),
      { label: '暂停大屏输出', click: () => setOutputPaused(true) },
      { label: '恢复大屏输出', click: () => setOutputPaused(false) },
      { label: '查看手机连接方式', click: () => dialog.showMessageBox(operator, { title: '手机连接', message: connections.length ? connections.map(c => `${c.label || c.name} · ${c.url}`).join('\n') : '尚未发现可用内网地址，请连接网络后稍候或刷新设备', detail: `当前配对码：${auth.pairingInfo().pin}\n有效期 5 分钟，配对成功后自动刷新。同一手机的同一浏览器下次自动连接。` }) },
      { label: '打开本机数据与初始口令目录', click: () => shell.openPath(store.root) },
      ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'hide', label: '隐藏 LiveScreen' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' }] : []),
      { type: 'separator' }, { label: '退出软件', accelerator: 'CmdOrCtrl+Q', click: quit }
    ] }, { role: 'editMenu', label: '编辑' }, ...(process.platform === 'darwin' ? [{ role: 'windowMenu', label: '窗口' }] : [])
  ]));
  ipcMain.on('player-ready', async e => {
    if (!playerWindow || e.sender !== playerWindow.webContents) return;
    playerWindow.readyForScene = true;
    updateSleepBlocker();
    controller.setOutput({ connected: true, message: preview || smoke ? '开发预览窗口（未验证 LED）' : 'LED 已连接' });
    try { await controller.startup(); } catch (err) { if (err.status !== 409) { controller.error = err.message; controller.notify(); } }
  });
  ipcMain.on('result', (e, result) => {
    if (!playerWindow || e.sender !== playerWindow.webContents || result?.id !== pending?.id) return;
    const p = pending; pending = null; clearTimeout(p.timer);
    result.ok ? p.resolve(result) : p.reject(new Error(String(result.error || '播放失败')));
  });
  ipcMain.on('page-state', (e, state) => {
    if (playerWindow && e.sender === playerWindow.webContents) controller.pageChanged(state || {});
  });
  ipcMain.on('playback-fault', (e, error) => {
    if (e.sender === playerWindow?.webContents) { controller.current = null; controller.error = String(error); controller.notify(); store.log('playback-fault', { error }); }
  });
  screen.on('display-added', scheduleReconcile); screen.on('display-removed', (_event, removed) => {
    if (playerWindow && (preview || smoke || removed?.id === activeDisplayId)) {
      void setOutputPaused(true, '大屏连接已断开，LiveScreen 已暂停输出。', true);
    } else scheduleReconcile();
  });
  screen.on('display-metrics-changed', scheduleReconcile);
  retryTimer = setInterval(scheduleReconcile, 5000);
  guideTimer = setInterval(() => {
    if (playerWindow?.readyForScene && !playerWindow.isDestroyed()) playerWindow.webContents.send('guide-info', guideInfo());
  }, 1000);
  app.on('activate', showOperator);
  store.log('started', { version: app.getVersion(), preview: preview || smoke });
  await reconcile();
}
async function refreshNetwork(force = false) {
  if (networkRefreshing) return networkRefreshing;
  networkRefreshing = (async () => {
    const addresses = smoke ? [] : interfaces();
    // Bind fresh addresses immediately; SSID queries are bounded and cannot delay LAN recovery.
    const bound = await api.updateInterfaces(addresses.map(a => ({ ...lastNetworkMetadata.find(m => m.address === a.address && m.name === a.name), ...a })));
    if (!smoke) connections = bound.connections;
    lastNetworkMetadata = smoke ? [] : await detectNetwork(addresses, force);
    const info = await api.updateInterfaces(lastNetworkMetadata);
    connections = smoke ? await buildConnections([{ name: '本机开发测试', address: '127.0.0.1' }], info.network.port) : info.connections;
    if (playerWindow?.readyForScene && !playerWindow.isDestroyed()) playerWindow.webContents.send('guide-info', guideInfo());
    return info;
  })().finally(() => { networkRefreshing = null; });
  return networkRefreshing;
}
function showOperator() {
  if (!operator || operator.isDestroyed() || quitting) return;
  if (operator.isMinimized()) operator.restore();
  operator.show(); operator.focus();
}
async function showPreviewPhone() {
  if (previewPhoneWindow && !previewPhoneWindow.isDestroyed()) { previewPhoneWindow.show(); previewPhoneWindow.focus(); return; }
  const win = new BrowserWindow({ width: 410, height: 820, title: 'LiveScreen · 手机预览', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:livescreen-preview-phone', nodeIntegration: false, contextIsolation: true, sandbox: true } });
  previewPhoneWindow = win; win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== baseURL) event.preventDefault(); });
  await win.loadURL(baseURL);
}
async function setOutputPaused(paused, reason = 'LiveScreen 已暂停大屏输出。', reveal = false) {
  store.saveSettings({ outputPaused: paused, outputPauseReason: paused ? reason : '' });
  if (paused) { closePlayer(); controller.setOutput({ connected: false, paused: true, message: reason }); }
  else controller.setOutput({ connected: false, paused: false, message: '等待已绑定的大屏就绪，请确认显示器。' });
  if (reveal) showOperator();
  store.log(paused ? 'output-paused' : 'output-resumed', { reason });
  await reconcile();
}
function closePlayer() {
  rejectPending('LED 显示器断开，未完成切换');
  if (playerWindow) { const w = playerWindow; playerWindow = null; w.destroy(); }
  activeDisplayId = null;
  updateSleepBlocker();
  controller?.setOutput({ connected: false, paused: !!store?.settings.outputPaused, message: store?.settings.outputPaused ? store.settings.outputPauseReason || 'LiveScreen 已暂停大屏输出。' : 'LED 未连接或尚未绑定；请检查 HDMI 并选择扩展屏' });
}
function updateSleepBlocker() {
  const playing = !quitting && playerWindow?.readyForScene && !playerWindow.isDestroyed() && !store?.settings.outputPaused;
  if (playing && (blocker === undefined || !powerSaveBlocker.isStarted(blocker))) blocker = powerSaveBlocker.start('prevent-display-sleep');
  else if (!playing && blocker !== undefined) { if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); blocker = undefined; }
}
function scheduleReconcile() { reconcile().catch(e => { store.log('display-error', { error: e.message }); }); }
async function reconcile() {
  if (quitting || reconciling) return; reconciling = true;
  try {
    if (store.settings.outputPaused) { if (playerWindow) closePlayer(); controller.setOutput({ connected: false, paused: true, message: store.settings.outputPauseReason || 'LiveScreen 已暂停大屏输出。' }); return; }
    const target = preview || smoke ? null : resolveDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, store.settings.display);
    if (!target && !preview && !smoke) {
      if (store.settings.display) { store.saveSettings({ outputPaused: true, outputPauseReason: '未找到已绑定的大屏，LiveScreen 已暂停输出。请确认显示器后恢复。' }); closePlayer(); showOperator(); }
      return;
    }
    if (playerWindow && !playerWindow.isDestroyed()) {
      if (target) positionOutputWindow(playerWindow, target, process.platform);
      return;
    }
    const win = new BrowserWindow({ ...outputWindowOptions(target, process.platform), show: false,
      autoHideMenuBar: true, backgroundColor: '#071d32', skipTaskbar: !!target,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    playerWindow = win; win.setMenu(null);
    activeDisplayId = target?.id ?? null;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      if (quitting) return;
      store.log('renderer-crashed', { reason: details.reason }); closePlayer();
      // The next bounded display retry recreates the renderer at the project's default scene.
    });
    win.on('closed', () => {
      if (playerWindow === win) { playerWindow = null; rejectPending('LED 窗口已关闭'); controller.setOutput({ connected: false, message: 'LED 窗口关闭，正在等待恢复' }); }
    });
    win.once('ready-to-show', () => { if (!win.isDestroyed() && !smoke) { if (target) positionOutputWindow(win, target, process.platform); win.showInactive(); } });
    await win.loadFile(path.join(root, 'src/player/index.html'));
  } finally { reconciling = false; }
}
const quit = createShutdown({
  onBegin: () => { quitting = true; },
  stopActivity: () => {
    clearInterval(retryTimer); clearInterval(guideTimer); clearInterval(networkTimer); rejectPending('程序已主动退出');
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  },
  closeWindows: () => { tray?.destroy(); previewPhoneWindow?.destroy(); operator?.destroy(); closePlayer(); },
  closeServer: () => { store?.log('intentional-quit'); return api?.close(); },
  quit: () => app.quit(), forceExit: code => app.exit(code),
  log: (event, detail) => store?.log(event, detail)
});
if (primaryInstance) app.on('before-quit', e => { if (!quitting) { e.preventDefault(); quit(); } });

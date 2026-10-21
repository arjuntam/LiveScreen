'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
test('Mac native management starts without taking over a screen; close, reopen and quit remain accessible', async () => {
  test.skip(process.platform !== 'darwin', 'macOS native integration');
  const root = path.resolve(__dirname, '../..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-mac-native-'));
  let app;
  try {
    app = await electron.launch({ args: [root, '--port=0', `--data-dir=${data}`], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const admin = await app.firstWindow(); await admin.waitForURL('**/admin'); await expect(admin.locator('#admin')).toBeVisible();
    expect(app.windows().filter(w => w.url().includes('/src/player/index.html'))).toHaveLength(0);
    await expect(admin.locator('#previewTools')).toBeHidden(); await admin.locator('#tabSystem').click();
    await expect(admin.locator('#platformNote')).toContainText('macOS'); await expect(admin.locator('#platformNote')).toContainText('关闭镜像');
    const info = await admin.evaluate(async () => (await (await fetch('/api/admin/system')).json()));
    expect(info.preview).toBe(false); expect(info.dataRoot).toBe(data); expect(info.displays.some(d => d.primary)).toBe(true);
    for (const d of info.displays.filter(d => d.primary || d.internal)) await expect(admin.locator(`#displaySelect option[value="${d.id}"]`)).toHaveAttribute('disabled', '');
    const result = await admin.evaluate(async id => {
      const res = await fetch('/api/admin/display', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LiveScreen': '1' }, body: JSON.stringify({ id }) }); return res.status;
    }, info.displays.find(d => d.primary).id); expect(result).toBe(400);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/admin')).close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/admin')).isVisible())).toBe(false);
    await app.evaluate(({ app }) => app.emit('activate'));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/admin')).isVisible())).toBe(true);
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.some(item => item.label === '退出软件' && item.accelerator === 'CmdOrCtrl+Q'))).toBe(true);
    fs.mkdirSync(path.join(root, 'test-results/evidence'), { recursive: true });
    await admin.screenshot({ path: path.join(root, 'test-results/evidence/mac-native-settings.png') });
    const base = new URL(admin.url()).origin, closed = app.waitForEvent('close');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === '退出软件').click());
    await closed; app = null;
    await expect.poll(async () => { try { await fetch(base + '/api/health'); return false; } catch { return true; } }).toBe(true);
  } finally {
    if (app) { const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => app.quit()); await closed; }
    fs.rmSync(data, { recursive: true, force: true });
  }
});

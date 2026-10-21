const { electronEnvironment } = require('./electron-env.cjs');
'use strict';
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { interfaces } = require('../../src/core/network.cjs');
const root = path.resolve(__dirname, '../..');
test('network reconnect updates desktop and guide QR automatically; actual LAN URL supports pairing and remote administration', async () => {
  const localInterface = interfaces()[0]; expect(localInterface).toBeTruthy();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-lan-ui-'));
  let app, browser;
  try {
    app = await electron.launch({ args: [root, '--dev-preview', '--port=0', `--data-dir=${dataRoot}`], env: electronEnvironment() });
    const admin = await app.firstWindow(); await admin.waitForURL('**/admin');
    await expect(admin.locator('#admin')).toBeVisible(); await admin.locator('#tabSystem').click();
    const info = await admin.evaluate(async () => (await (await fetch('/api/admin/system')).json()));
    const connection = info.connections.find(c => c.address === localInterface.address); expect(connection).toBeTruthy();
    const led = app.windows().find(w => w.url().includes('/src/player/index.html'));
    await expect(led.locator('.pairing-guide')).toBeVisible();
    await expect(admin.locator('#pairAddresses')).toContainText(localInterface.name);
    // Simulate a machine that loses all private networks, then obtains the interface again.
    await app.evaluate(() => { const os = process.getBuiltinModule('os'); globalThis.originalNetworkInterfaces = os.networkInterfaces; os.networkInterfaces = () => ({}); });
    await expect(admin.locator('#pairAddresses img')).toHaveCount(0, { timeout: 12000 });
    await expect(admin.locator('#networkStatus')).toContainText('未发现可用内网监听地址');
    await expect(led.locator('.guide-qr')).toHaveCount(0, { timeout: 12000 });
    expect((await fetch(new URL(admin.url()).origin + '/api/health')).status).toBe(200);
    await app.evaluate(() => { process.getBuiltinModule('os').networkInterfaces = globalThis.originalNetworkInterfaces; });
    await expect(admin.locator('#pairAddresses')).toContainText(connection.url, { timeout: 12000 });
    await expect(led.locator('.guide-address').filter({ hasText: connection.url })).toHaveCount(1, { timeout: 12000 });
    await admin.locator('#refreshSystem').click(); await expect(admin.locator('#message')).toHaveText('网络与设备已刷新，请使用当前二维码。');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await phone.goto(connection.url); await expect(phone.locator('#login')).toBeVisible();
    const pin = await admin.evaluate(async () => (await (await fetch('/api/admin/pairing')).json()).pin);
    await phone.getByLabel('配对码', { exact: true }).fill(pin);
    await phone.getByRole('button', { name: '配对并连接', exact: true }).click(); await expect(phone.locator('#remote')).toBeVisible();
    expect(await phone.evaluate(async () => (await fetch('/api/admin/network/refresh', { method: 'POST', headers: { 'X-LiveScreen': '1' } })).status)).toBe(401);
    const manager = await browser.newPage(); await manager.goto(connection.url + '/admin');
    const secret = fs.readFileSync(path.join(dataRoot, '首次安装口令.txt'), 'utf8').split('\n')[0].split('：')[1];
    await manager.getByLabel('远程管理口令', { exact: true }).fill(secret);
    await manager.getByRole('button', { name: '进入管理', exact: true }).click(); await expect(manager.locator('#admin')).toBeVisible();
    await manager.locator('#tabSystem').click(); await expect(manager.locator('#networkStatus')).toContainText('已监听');
    fs.mkdirSync(path.join(root, 'test-results/evidence'), { recursive: true });
    await admin.locator('#networkStatus').scrollIntoViewIfNeeded();
    await admin.screenshot({ path: path.join(root, 'test-results/evidence/network-status.png') });
  } finally {
    await browser?.close();
    if (app) { const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => app.quit()); await closed; }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

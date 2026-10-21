const { electronEnvironment } = require('./electron-env.cjs');
'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..');
test('generic guide prefers Wi-Fi over simultaneous Ethernet, updates same-IP SSID and supports explicit fallback names', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-generic-guide-'));
  let app;
  try {
    app = await electron.launch({ args: [root, '--smoke-test', '--port=0', `--data-dir=${dataRoot}`], env: electronEnvironment() });
    const admin = await app.firstWindow(); await admin.waitForURL('**/admin'); await expect(admin.locator('#admin')).toBeVisible();
    await expect.poll(() => app.windows().some(w => w.url().includes('/src/player/index.html'))).toBe(true);
    const led = app.windows().find(w => w.url().includes('/src/player/index.html')); await expect(led.locator('.pairing-guide')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/src/player/index.html'));
      win.setContentSize(1920,1080);
      const send = win.webContents.send.bind(win.webContents);
      globalThis.guideTestMode = 'both'; globalThis.guideTestSSID = 'Studio Wi-Fi';
      win.webContents.send = (channel, ...args) => {
        if (channel === 'guide-info') {
          const original = args[0], url = original.connections[0].url, qr = original.connections[0].qr;
          const wired = { name:'Ethernet', kind:'ethernet', ssid:null, label:'以太网 · Ethernet', url:url+'/?wired=1', qr };
          const wifi = { name:'Wi-Fi', kind:'wifi', ssid:globalThis.guideTestSSID, label:globalThis.guideTestSSID?'Wi-Fi · '+globalThis.guideTestSSID:'Wi-Fi · 名称暂不可读', url, qr };
          const connections = globalThis.guideTestMode==='wired'?[wired]:globalThis.guideTestMode==='none'?[]:[wired,wifi];
          args = [{ ...original, connections }];
        }
        return send(channel,...args);
      };
    });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('Studio Wi-Fi');
    await expect(led.locator('.guide-network-label').first()).toHaveText('Wi-Fi · Studio Wi-Fi');
    await expect(led.locator('.guide-network-label').nth(1)).toHaveText('以太网 · Ethernet');
    await expect(led.locator('.pairing-guide')).not.toContainText('Daikin'); await expect(led.locator('.pairing-guide')).not.toContainText('企业微信');
    expect(await led.locator('.pairing-guide img').count()).toBe(2);
    const geometry = await led.evaluate(() => {
      const g = document.querySelector('.guide-connect').getBoundingClientRect(), footer = document.querySelector('.pairing-guide footer').getBoundingClientRect();
      return { bottom:g.bottom,footer:footer.top,height:innerHeight };
    });
    expect(geometry.bottom).toBeLessThan(geometry.footer); expect(geometry.footer).toBeLessThan(geometry.height);
    fs.mkdirSync(path.join(root,'test-results/evidence'),{recursive:true});
    await led.screenshot({path:path.join(root,'test-results/evidence/generic-guide-wifi-first.png'),scale:'css'});
    await app.evaluate(() => { globalThis.guideTestSSID = 'Demo & <Wi-Fi>'; });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('Demo & <Wi-Fi>');
    await expect(led.locator('.guide-network-label').first()).toHaveText('Wi-Fi · Demo & <Wi-Fi>');
    await expect(led.locator('.guide-connect script')).toHaveCount(0);
    await app.evaluate(() => { globalThis.guideTestSSID = null; });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('Wi-Fi 名称暂不可读');
    await expect(led.locator('.guide-network-label').first()).toHaveText('Wi-Fi · 名称暂不可读');
    await app.evaluate(() => { globalThis.guideTestMode = 'wired'; });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('以太网');
    await admin.locator('#tabSystem').click();
    await expect(admin.locator('.guide-reference-full')).toHaveCount(0);
    await expect(admin.locator('#systemPanel')).not.toContainText('企业微信');
    await admin.getByLabel('手机连接网络名称', { exact:true }).fill('演示厅 Wi-Fi');
    await admin.getByRole('button',{name:'保存网络名称',exact:true}).click();
    await expect(admin.locator('#networkHintFeedback')).toHaveText('已保存；未识别到 Wi-Fi 名称时使用');
    await expect(led.locator('[data-guide-network-name]')).toHaveText('演示厅 Wi-Fi');
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot,'settings.json'))).phoneNetworkName).toBe('演示厅 Wi-Fi');
    await led.screenshot({path:path.join(root,'test-results/evidence/generic-guide-ethernet-hint.png'),scale:'css'});
    await app.evaluate(() => { globalThis.guideTestMode = 'both'; globalThis.guideTestSSID = 'Studio Restored'; });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('Studio Restored');
    await app.evaluate(() => { globalThis.guideTestMode = 'wired'; });
    await expect(led.locator('[data-guide-network-name]')).toHaveText('演示厅 Wi-Fi');
    await admin.getByLabel('手机连接网络名称',{exact:true}).fill(''); await admin.getByRole('button',{name:'保存网络名称',exact:true}).click();
    await expect(led.locator('[data-guide-network-name]')).toHaveText('以太网');
    await app.evaluate(() => { globalThis.guideTestMode = 'none'; });
    await expect(led.locator('.guide-qr')).toHaveCount(0); await expect(led.locator('[data-guide-connections]')).toContainText('未发现可用内网地址');
  } finally {
    if (app) { const closed=app.waitForEvent('close'); await app.evaluate(({app})=>app.quit()); await closed; }
    fs.rmSync(dataRoot,{recursive:true,force:true});
  }
});

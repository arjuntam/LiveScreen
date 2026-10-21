'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoginItems, silentLoginLaunch } = require('../src/desktop/login-items.cjs');
const { outputWindowOptions, positionOutputWindow } = require('../src/desktop/output-window.cjs');
test('Mac login registration uses main app service, reports approval and respects external disabling', () => {
  let state = { openAtLogin: false, status: 'not-registered' }, requested;
  const app = { isPackaged: true, getLoginItemSettings: options => { assert.deepEqual(options, { type: 'mainAppService' }); return state; },
    setLoginItemSettings: options => { requested = options; state = options.openAtLogin ? { openAtLogin: false, status: 'requires-approval' } : { openAtLogin: false, status: 'not-registered' }; } };
  const login = createLoginItems(app, 'darwin', false);
  assert.equal(login.read().requested, false);
  assert.equal(login.set(true).status, 'requires-approval');
  assert.deepEqual(requested, { type: 'mainAppService', openAtLogin: true });
  state = { openAtLogin: true, status: 'enabled', wasOpenedAtLogin: true };
  assert.equal(login.read().enabled, true); assert.equal(login.read().wasOpenedAtLogin, true);
  state = { openAtLogin: false, status: 'not-registered' };
  assert.equal(login.read().requested, false);
  assert.equal(login.set(false).requested, false);
});
test('a silently rejected login registration is a failure and preview cannot alter system login items', () => {
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }), setLoginItemSettings: () => {} };
  assert.throws(() => createLoginItems(app, 'darwin', false).set(true), /未确认/);
  for (const [isPackaged, preview] of [[false,false],[true,true]]) {
    const login = createLoginItems({ ...app, isPackaged }, 'darwin', preview);
    assert.equal(login.supported, false); assert.throws(() => login.set(true), /正式安装版/);
  }
});
test('Windows login registration and matching query retain the exact executable and startup arguments', () => {
  let saved;
  const app = { isPackaged: true, setLoginItemSettings: v => { saved = v; }, getLoginItemSettings: options => {
    assert.deepEqual(options, { path: 'C:\\Programs\\LiveScreen.exe', args: ['--autostart'] }); return { openAtLogin: !!saved?.openAtLogin };
  } };
  const login = createLoginItems(app, 'win32', false, 'C:\\Programs\\LiveScreen.exe');
  assert.equal(login.set(true).enabled, true); assert.deepEqual(saved.args, ['--autostart']); assert.equal(login.set(false).enabled, false);
});
test('Mac login launch hides management only for system login and never when output is paused', () => {
  const input = { platform: 'darwin', args: [], login: { wasOpenedAtLogin: true }, settings: { silentAutoStart: true, outputPaused: false } };
  assert.equal(silentLoginLaunch(input), true);
  assert.equal(silentLoginLaunch({ ...input, login: { wasOpenedAtLogin: false } }), false);
  assert.equal(silentLoginLaunch({ ...input, settings: { ...input.settings, outputPaused: true } }), false);
  assert.equal(silentLoginLaunch({ ...input, settings: { ...input.settings, silentAutoStart: false } }), false);
  assert.equal(silentLoginLaunch({ ...input, platform: 'win32', login: {}, args: ['--autostart'] }), true);
});
test('Mac output covers the selected display without a fullscreen Space; Windows retains fullscreen', () => {
  const target = { bounds: { x: -2560, y: 120, width: 2560, height: 1440 } };
  const options = outputWindowOptions(target, 'darwin');
  assert.equal(options.fullscreen, false); assert.equal(options.fullscreenable, false); assert.equal(options.frame, false);
  const calls = [];
  const win = { setBounds: b => calls.push(['bounds',b]), setAlwaysOnTop: (...a) => calls.push(['top',...a]),
    setVisibleOnAllWorkspaces: (...a) => calls.push(['spaces',...a]), isFullScreen: () => false, setFullScreen: () => assert.fail('Mac must not create a fullscreen Space') };
  positionOutputWindow(win,target,'darwin'); assert.deepEqual(calls[0],['bounds',target.bounds]); assert.equal(calls[2][2].skipTransformProcessType,true);
  assert.equal(outputWindowOptions(target,'win32').fullscreen,true);
  let fullscreen = false; positionOutputWindow({setBounds: b => assert.deepEqual(b,target.bounds), isFullScreen: () => false, setFullScreen: v => { fullscreen=v; }},target,'win32'); assert.equal(fullscreen,true);
  assert.equal(outputWindowOptions(null,'darwin').frame,true);
});

'use strict';
// Keep platform registration separate from the user's silent-window preference.
function createLoginItems(app, platform, preview, execPath = process.execPath) {
  const supported = app.isPackaged && !preview && ['darwin', 'win32'].includes(platform);
  const options = platform === 'win32' ? { path: execPath, args: ['--autostart'] } : { type: 'mainAppService' };
  function read() {
    if (!supported) return { enabled: false, requested: false, status: 'unsupported', message: '登录自启请在正式安装版中设置。' };
    try {
      const value = app.getLoginItemSettings(options);
      const pending = platform === 'darwin' && value.status === 'requires-approval';
      return { enabled: !!value.openAtLogin, requested: !!value.openAtLogin || pending,
        wasOpenedAtLogin: platform === 'darwin' && !!value.wasOpenedAtLogin,
        status: pending ? 'requires-approval' : value.openAtLogin ? 'enabled' : 'disabled',
        message: pending ? '请在 macOS「系统设置 → 通用 → 登录项与扩展」允许 LiveScreen。' : value.openAtLogin ? '系统已登记登录自启。' : '登录自启未开启。' };
    } catch (error) { return { enabled: false, requested: false, status: 'unavailable', message: `无法读取系统登录项：${error.message}` }; }
  }
  function set(enabled) {
    if (!supported) throw new Error('请在正式安装版中配置登录自启');
    app.setLoginItemSettings({ ...options, openAtLogin: enabled });
    const state = read();
    if (state.status === 'unavailable' || state.requested !== enabled) {
      throw new Error(platform === 'darwin' ? 'macOS 未确认登录自启变更。请先将 LiveScreen 放入「应用程序」，并在系统「登录项与扩展」中检查；当前包尚未经 Apple 公证。' : 'Windows 未确认登录自启变更，请检查系统启动应用设置。');
    }
    return state;
  }
  return { supported, read, set };
}
function silentLoginLaunch({ platform, args, login, settings }) {
  return !!((platform === 'darwin' && login.wasOpenedAtLogin || args.includes('--autostart')) && settings.silentAutoStart && !settings.outputPaused);
}
module.exports = { createLoginItems, silentLoginLaunch };

'use strict';
function createEmergencyAccess(shortcuts, takeOver) {
  let state = { registered: false, accelerator: null, message: '应急快捷键尚未就绪' };
  return {
    register() {
      for (const accelerator of ['CommandOrControl+Alt+Shift+L', 'CommandOrControl+Alt+Shift+F12']) {
        try {
          if (shortcuts.register(accelerator, takeOver)) {
            const label = accelerator.replace('CommandOrControl', process.platform === 'darwin' ? 'Command' : 'Ctrl').split('+').join(' + ');
            state = { registered: true, accelerator, message: '本机应急快捷键：' + label + '（暂停输出并打开管理）' };
            return state;
          }
        } catch { /* Try the alternative instead of claiming the shortcut works. */ }
      }
      state = { registered: false, accelerator: null, message: '应急快捷键注册失败。可用托盘打开管理，或再次打开 LiveScreen 接管；请在专用主机部署前检查。' };
      return state;
    },
    status() { return { ...state }; },
    close() { if (state.accelerator) shortcuts.unregister(state.accelerator); }
  };
}
module.exports = { createEmergencyAccess };

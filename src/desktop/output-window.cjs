'use strict';
function outputWindowOptions(target, platform) {
  if (!target) return { x: 40, y: 60, width: 960, height: 540, frame: true, fullscreen: false };
  if (platform === 'darwin') {
    // A borderless window covers only the selected screen without creating a
    // full-screen Space or changing the main display's presentation options.
    return { ...target.bounds, frame: false, fullscreen: false, fullscreenable: false,
      enableLargerThanScreen: true, roundedCorners: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, closable: false };
  }
  return { ...target.bounds, frame: false, fullscreen: true };
}
function positionOutputWindow(win, target, platform) {
  win.setBounds(target.bounds);
  if (platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } else if (!win.isFullScreen()) win.setFullScreen(true);
}
module.exports = { outputWindowOptions, positionOutputWindow };

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('led', {
  onPrepare: callback => ipcRenderer.on('prepare', (_event, command) => callback(command)),
  onPage: callback => ipcRenderer.on('page', (_event, command) => callback(command)),
  onSlideshow: callback => ipcRenderer.on('slideshow', (_event, command) => callback(command)),
  onCancel: callback => ipcRenderer.on('cancel', (_event, id) => callback(id)),
  onGuideInfo: callback => ipcRenderer.on('guide-info', (_event, info) => callback(info)),
  result: result => ipcRenderer.send('result', result),
  pageChanged: state => ipcRenderer.send('page-state', state),
  fault: error => ipcRenderer.send('playback-fault', String(error).slice(0, 300)),
  ready: () => ipcRenderer.send('player-ready')
});

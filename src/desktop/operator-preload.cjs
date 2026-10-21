'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('livescreenDesktop', {
  quit: () => ipcRenderer.invoke('operator-command', 'quit'),
  previewPlayer: () => ipcRenderer.invoke('operator-command', 'preview-player'),
  previewPhone: () => ipcRenderer.invoke('operator-command', 'preview-phone')
});

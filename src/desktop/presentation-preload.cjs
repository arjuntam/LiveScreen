'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = process.argv.find(a => a.startsWith('--presentation-channel='))?.split('=')[1];
contextBridge.exposeInMainWorld('presentationRender', { send: request => ipcRenderer.invoke(channel, request) });

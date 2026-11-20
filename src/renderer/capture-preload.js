const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureApi', {
  onInit: (callback) => ipcRenderer.on('capture:init', (_event, payload) => callback(payload)),
  ready: () => ipcRenderer.send('capture:ready'),
  done: (rect) => ipcRenderer.send('capture:done', rect),
  cancel: () => ipcRenderer.send('capture:cancel'),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderApi', {
  ready: () => ipcRenderer.send('recorder:ready'),
  fail: (message) => ipcRenderer.send('recorder:error', message),
  frame: (payload) => ipcRenderer.send('recorder:frame', payload),
  onGrab: (cb) => ipcRenderer.on('recorder:grab', (event, payload) => cb(payload)),
  onCrop: (cb) => ipcRenderer.on('recorder:crop', (event, payload) => cb(payload)),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('answerApi', {
  onData: (callback) => ipcRenderer.on('answer:data', (_event, payload) => callback(payload)),
  hide: () => ipcRenderer.send('answer:hide'),
  capture: () => ipcRenderer.invoke('answer:capture'),
  resizeStart: () => ipcRenderer.send('answer:resize-start'),
  resizeEnd: () => ipcRenderer.send('answer:resize-end'),
});

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dfrDesktop', {
  print: () => ipcRenderer.invoke('print'),
  saveBackup: (name, json) => ipcRenderer.invoke('saveBackup', name, json),
});

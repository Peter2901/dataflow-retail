const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dfrDesktop', {
  print: () => ipcRenderer.invoke('print'),
  saveBackup: (name, json) => ipcRenderer.invoke('saveBackup', name, json),
  // Free offline bill reading runs in the desktop app itself (file pages cannot load the OCR worker).
  ocr: dataUrl => ipcRenderer.invoke('ocr', dataUrl),
});

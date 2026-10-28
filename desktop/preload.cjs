const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('miraDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('mira:get-info'),
  repairWifi: () => ipcRenderer.invoke('mira:repair-wifi'),
  request: args => ipcRenderer.invoke('mira:request', args)
}));

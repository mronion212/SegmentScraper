const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  pickFiles: () => ipcRenderer.invoke('desktop:pick-files'),
  pickFolder: () => ipcRenderer.invoke('desktop:pick-folder'),
  pickDestination: () => ipcRenderer.invoke('desktop:pick-destination'),
  saveReport: report => ipcRenderer.invoke('desktop:save-report', report),
  openUpdate: () => ipcRenderer.invoke('desktop:open-update'),
});

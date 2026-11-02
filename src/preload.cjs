'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Never preload this bridge into external website WebContentsViews.
contextBridge.exposeInMainWorld('minternet', Object.freeze({
  command: (name, value) => ipcRenderer.invoke('minternet:command', { name, value }),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('minternet:state', listener);
    return () => ipcRenderer.removeListener('minternet:state', listener);
  }
}));

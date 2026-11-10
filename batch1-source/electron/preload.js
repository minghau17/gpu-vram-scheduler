'use strict';
/** preload.js — 渲染进程唯一通道，只暴露白名单方法。 */
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),

  setPreference: (path, pref) => ipcRenderer.invoke('app:setPreference', { path, pref }),
  setBulk: (paths, pref) => ipcRenderer.invoke('app:bulk', { paths, pref }),
  restoreDefault: (path) => ipcRenderer.invoke('app:restoreDefault', { path }),
  smartOptimize: () => ipcRenderer.invoke('app:smartOptimize'),
  addApp: () => ipcRenderer.invoke('app:add'),
  removeApp: (path) => ipcRenderer.invoke('app:remove', { path }),
  revealInExplorer: (path) => ipcRenderer.invoke('app:revealInExplorer', { path }),
  launchApp: (path) => ipcRenderer.invoke('app:launch', { path }),
  restartApp: (path, pids) => ipcRenderer.invoke('app:restart', { path, pids }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getHistory: (minutes) => ipcRenderer.invoke('history:get', { minutes }),

  startMeasure: (opts) => ipcRenderer.invoke('measure:start', opts),
  cancelMeasure: () => ipcRenderer.invoke('measure:cancel'),
  resetMeasure: () => ipcRenderer.invoke('measure:reset'),
  getMeasure: () => ipcRenderer.invoke('measure:state'),

  exportReport: () => ipcRenderer.invoke('report:export'),
  openGraphicsSettings: () => ipcRenderer.invoke('shell:openGraphicsSettings'),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  version: () => ipcRenderer.invoke('app:version'),

  onTick: (cb) => on('tick', cb),
  onWindowState: (cb) => on('window:state', cb),
  onMeasure: (cb) => on('measure:state', cb),
  onAutoApplied: (cb) => on('auto:applied', cb),
});

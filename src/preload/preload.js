'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aerogcs', {
  listPorts: () => ipcRenderer.invoke('link:list'),
  connect: (options) => ipcRenderer.invoke('link:connect', options),
  disconnect: () => ipcRenderer.invoke('link:disconnect'),
  status: () => ipcRenderer.invoke('link:status'),
  write: (bytes) => ipcRenderer.invoke('link:write', bytes),
  saveLog: (name, payload) => ipcRenderer.invoke('log:save', name, payload),
  info: () => ipcRenderer.invoke('app:info'),
  getMapTiles: (urls) => ipcRenderer.invoke('map:getTiles', urls),

  onTelemetry: (cb) => {
    const handler = (_evt, snapshot) => cb(snapshot);
    ipcRenderer.on('telemetry:update', handler);
    return () => ipcRenderer.removeListener('telemetry:update', handler);
  },
  onLinkStatus: (cb) => {
    const handler = (_evt, s) => cb(s);
    ipcRenderer.on('link:status', handler);
    return () => ipcRenderer.removeListener('link:status', handler);
  },
  onRaw: (cb) => {
    const handler = (_evt, msg) => cb(msg);
    ipcRenderer.on('mavlink:raw', handler);
    return () => ipcRenderer.removeListener('mavlink:raw', handler);
  },
  onMission: (cb) => {
    const handler = (_evt, wp) => cb(wp);
    ipcRenderer.on('mission:update', handler);
    return () => ipcRenderer.removeListener('mission:update', handler);
  },
  onAdsb: (cb) => {
    const handler = (_evt, list) => cb(list);
    ipcRenderer.on('adsb:update', handler);
    return () => ipcRenderer.removeListener('adsb:update', handler);
  },
});
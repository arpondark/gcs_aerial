'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MAVLink = require('./mavlink');
const TelemetryStore = require('./telemetry-store');
const SerialLink = require('./serial-link');
const MockLink = require('./mock-link');
const { TileFetcher, TileCache } = require('./tile-fetcher');
const { OfflineTileDownloadManager } = require('./offline-tile-download-manager');
const { registerTrackLogIpc } = require('./track-log');
const LocalTileServer = require('./local-tile-server');

const isMock = process.argv.includes('--mock');
const isDev = process.argv.includes('--enable-logging');

let mainWindow = null;
let link = null;
const telemetry = new TelemetryStore();
const mavlink = new MAVLink({ onMessage: (msg) => telemetry.apply(msg) });

const tileCacheRoot = TileCache.defaultRoot(app);
const tileFetcher = new TileFetcher(tileCacheRoot);
const localTileServer = new LocalTileServer({
  tileCacheDir: tileCacheRoot,
  fallbackDirs: [path.join(process.cwd(), 'osm')],
});
tileFetcher.localTileServer = localTileServer;
const offlineDownload = new OfflineTileDownloadManager(tileFetcher);

offlineDownload.on('progress', (payload) => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('map:downloadProgress', payload);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#020617',
    show: false,
    autoHideMenuBar: true,
    title: 'UIU Aerial Robotics GCP - ArduPilot Ground Station',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // forward decoded telemetry to renderer
  telemetry.on('update', (snapshot) => {
    if (!win.isDestroyed()) {
      win.webContents.send('telemetry:update', snapshot);
    }
  });

  telemetry.on('raw', (msg) => {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send('mavlink:raw', msg);
    }
  });

  // Expose a counter to the renderer via a global so we can prove the
  // main process is actually receiving packets.
  let _packetCount = 0;
  telemetry.on('raw', () => {
    _packetCount++;
    if (_packetCount % 50 === 0) {
      console.log(`[main] ${_packetCount} MAVLink packets processed`);
    }
  });

  // expose the win so link-level events (mission/adsb) can forward to it
  mainWindow = win;
  return win;
}

function setMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        {
          label: 'Open Log Folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function init() {
  setMenu();
  mainWindow = createWindow();
  registerTrackLogIpc();
  await app.whenReady();
  await localTileServer.start().catch((err) => console.error('[main] Local tile server failed to start:', err));
}

// ---------- IPC handlers ----------

ipcMain.handle('link:list', async () => {
  if (isMock) {
    return {
      ok: true,
      ports: [{ path: 'MOCK', friendlyName: 'MOCK — simulated MAVLink stream', manufacturer: 'UIU Aerial Robotics GCP' }],
      error: null,
    };
  }
  const result = await SerialLink.list();
  console.log('[link:list] ok=' + result.ok + ' ports=' + (result.ports ? result.ports.length : 0) + (result.error ? ' error=' + result.error : ''));
  return {
    ok: result.ok,
    ports: result.ports || [],
    error: result.error,
  };
});

ipcMain.handle('link:connect', async (_evt, options) => {
  if (link) {
    await link.close().catch(() => {});
    link = null;
  }
  const opts = options || {};
  if (isMock || opts.path === 'MOCK') {
    link = new MockLink();
  } else {
    link = new SerialLink();
  }
  link.on('data', (chunk) => mavlink.parse(chunk));
  link.on('status', (s) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('link:status', s);
    }
  });
  link.on('mission', (wp) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mission:update', wp);
    }
  });
  link.on('adsb', (list) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adsb:update', list);
    }
  });
  await link.open(opts);
  telemetry.reset();
  return { ok: true, path: opts.path || 'MOCK' };
});

ipcMain.handle('link:disconnect', async () => {
  if (!link) return { ok: true };
  await link.close().catch(() => {});
  link = null;
  telemetry.reset();
  return { ok: true };
});

ipcMain.handle('link:status', async () => ({
  connected: !!link && link.isOpen(),
  path: link ? link.path() : null,
  baud: link ? link.baud() : null,
}));

ipcMain.handle('link:write', async (_evt, bytes) => {
  if (!link || !link.isOpen()) return { ok: false, error: 'not connected' };
  await link.write(bytes);
  return { ok: true };
});

ipcMain.handle('map:getTiles', async (_evt, urls) => {
  try {
    const tiles = await tileFetcher.fetchTiles(urls || []);
    return tiles;
  } catch (err) {
    return [];
  }
});

ipcMain.handle('map:estimateDownload', async (_evt, payload) => {
  try {
    return offlineDownload.estimate(payload || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('map:downloadArea', async (_evt, payload) => {
  try {
    const res = await offlineDownload.start(payload || {});
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('map:cancelDownload', async (_evt, jobId) => {
  try {
    return offlineDownload.cancel(jobId);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('map:downloadStatus', async () => {
  try {
    return offlineDownload.status();
  } catch (err) {
    return null;
  }
});

ipcMain.handle('map:setDatabasePath', async (_evt, filePath) => {
  try {
    const ok = localTileServer.loadDatabase(filePath);
    return { ok, databasePath: localTileServer.activeDatabasePath, metadata: localTileServer.getMetadata() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('map:getDatabaseInfo', async () => {
  return {
    databasePath: localTileServer.activeDatabasePath,
    sourceType: localTileServer.getSourceType(),
    metadata: localTileServer.getMetadata(),
  };
});

ipcMain.handle('map:getTileServerStatus', async () => {
  return {
    running: localTileServer.isRunning,
    port: localTileServer.port,
    host: localTileServer.host,
    url: `http://${localTileServer.host}:${localTileServer.port}`,
    databasePath: localTileServer.activeDatabasePath,
    sourceType: localTileServer.getSourceType(),
    metadata: localTileServer.getMetadata(),
  };
});

ipcMain.handle('map:selectDatabaseFile', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Offline World Map Database (.mbtiles, .pmtiles, or tile folder)',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Map Databases', extensions: ['mbtiles', 'pmtiles'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return { canceled: true };
  }
  const filePath = res.filePaths[0];
  const ok = localTileServer.loadDatabase(filePath);
  return { canceled: false, filePath, ok, metadata: localTileServer.getMetadata() };
});

// Log to file
ipcMain.handle('log:save', async (_evt, name, payload) => {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (name || 'session').replace(/[^a-z0-9_-]/gi, '_');
    const file = path.join(dir, `${safe}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:info', async () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  userData: app.getPath('userData'),
  mock: isMock,
  tileServerPort: localTileServer.port,
  tileServerSource: localTileServer.getSourceType(),
  tileServerDb: localTileServer.activeDatabasePath,
}));

app.whenReady().then(init).catch((err) => {
  console.error('init failed', err);
  dialog.showErrorBox('Startup error', err.message);
  app.exit(1);
});

app.on('window-all-closed', async () => {
  if (link) await link.close().catch(() => {});
  await offlineDownload.shutdown().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
});
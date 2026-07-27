'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Track log IPC: save KML/GPX text to disk via dialog.showSaveDialog,
// load KML/GPX text from disk via dialog.showOpenDialog.
//
// Renderer side calls api.trackLog.save({ format, name, kml }) and
// api.trackLog.load().

function sanitize(name) {
  return String(name || 'track').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'track';
}

async function handleSave(_evt, payload) {
  try {
    if (!payload || typeof payload.kml !== 'string') {
      return { ok: false, error: 'invalid payload' };
    }
    const fmt = payload.format === 'gpx' ? 'gpx' : 'kml';
    const ext = fmt === 'gpx' ? '.gpx' : '.kml';
    const defaultName = `${sanitize(payload.name || 'track')}${ext}`;
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win, {
      title: 'Save track log',
      defaultPath: path.join(app.getPath('documents') || app.getPath('userData'), defaultName),
      filters: [
        { name: fmt.toUpperCase(), extensions: [fmt] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    await fsp.writeFile(res.filePath, payload.kml, 'utf8');
    return { ok: true, file: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleLoad(_evt) {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: 'Load track log',
      properties: ['openFile'],
      filters: [
        { name: 'Track log', extensions: ['kml', 'gpx'] },
        { name: 'KML', extensions: ['kml'] },
        { name: 'GPX', extensions: ['gpx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'cancelled' };
    const file = res.filePaths[0];
    const content = await fsp.readFile(file, 'utf8');
    const ext = path.extname(file).toLowerCase();
    const format = ext === '.gpx' ? 'gpx' : 'kml';
    return { ok: true, file, content, format };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function registerTrackLogIpc() {
  ipcMain.handle('trackLog:save', handleSave);
  ipcMain.handle('trackLog:load', handleLoad);
}

module.exports = { registerTrackLogIpc };

const fs = require('fs');
const log = (s) => fs.appendFileSync("C:\\Users\\ARPON\\Desktop\\gcs_aerial\\test\\app-probe.log", s + '\n');
const { app, ipcMain } = require('electron');
log('--- app-probe start ---');
log('electron=' + process.versions.electron);

// Hook into the app's own handler by requiring it via the same path as main.
process.argv.push('--app-probe');

// Load main process file (which registers IPC handlers).
require("C:\\Users\\ARPON\\Desktop\\gcs_aerial\\src\\main\\main.js");

// Give the renderer a moment to call link:list, then exit.
setTimeout(() => {
  log('done');
  process.exit(0);
}, 3500);

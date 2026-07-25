'use strict';
// Boots the actual Electron app and prints what link:list returns from main.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const probePath = path.join(__dirname, 'app-probe-inline.js');
const logFile = path.join(__dirname, 'app-probe.log');
fs.writeFileSync(logFile, '');

fs.writeFileSync(probePath, `
const fs = require('fs');
const log = (s) => fs.appendFileSync(${JSON.stringify(logFile)}, s + '\\n');
const { app, ipcMain } = require('electron');
log('--- app-probe start ---');
log('electron=' + process.versions.electron);

// Hook into the app's own handler by requiring it via the same path as main.
process.argv.push('--app-probe');

// Load main process file (which registers IPC handlers).
require(${JSON.stringify(path.resolve(__dirname, '..', 'src/main/main.js'))});

// Give the renderer a moment to call link:list, then exit.
setTimeout(() => {
  log('done');
  process.exit(0);
}, 3500);
`);

const child = spawn(require('electron'), [probePath], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'ignore',
});
child.on('exit', (code) => {
  process.stdout.write('APP PROBE EXIT ' + code + '\n');
  try {
    const out = fs.readFileSync(logFile, 'utf8');
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write('no log\n');
  }
});

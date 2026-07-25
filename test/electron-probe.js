'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const probePath = path.join(__dirname, 'probe-inline.js');
fs.writeFileSync(probePath, `
const fs = require('fs');
const log = (s) => fs.appendFileSync(${JSON.stringify(path.join(__dirname, 'probe.log'))}, s + '\\n');
log('--- probe start ---');
try {
  const b = require('@serialport/bindings-cpp');
  log('keys: ' + Object.keys(b).join(','));
  const WB = b.WindowsBinding;
  log('WB typeof: ' + typeof WB);
  if (WB && WB.list) {
    WB.list().then(p => {
      log('list count: ' + (p ? p.length : -1));
      if (p && p[0]) log('first: ' + JSON.stringify(p[0]));
      log('done');
      process.exit(0);
    }).catch(e => { log('list err: ' + e.message); process.exit(1); });
  } else {
    log('no list function on WB');
    process.exit(2);
  }
} catch (e) {
  log('require err: ' + e.message + '\\n' + e.stack);
  process.exit(3);
}
setTimeout(() => { log('timeout'); process.exit(4); }, 3000);
`);

fs.writeFileSync(path.join(__dirname, 'probe.log'), '');
const child = spawn(require('electron'), [probePath], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'ignore',
});
child.on('exit', (code) => {
  process.stdout.write('PROBE EXIT ' + code + '\n');
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'probe.log'), 'utf8'));
});
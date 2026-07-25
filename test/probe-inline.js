
const fs = require('fs');
const log = (s) => fs.appendFileSync("C:\\Users\\ARPON\\Desktop\\gcs_aerial\\test\\probe.log", s + '\n');
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
  log('require err: ' + e.message + '\n' + e.stack);
  process.exit(3);
}
setTimeout(() => { log('timeout'); process.exit(4); }, 3000);

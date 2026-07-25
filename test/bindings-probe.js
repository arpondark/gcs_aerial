'use strict';
process.stdout.write('--- bindings probe start ---\n');
var b = require('@serialport/bindings-cpp');
process.stdout.write('exports: ' + Object.keys(b).join(',') + '\n');
var WB = b.WindowsBinding;
process.stdout.write('typeof WB: ' + typeof WB + '\n');
try {
  var inst = new WB({ autoOpen: false });
  process.stdout.write('inst ok: ' + typeof inst + '\n');
  Promise.resolve(inst.list()).then(function (r) {
    process.stdout.write('list result: ' + JSON.stringify(r) + '\n');
  }).catch(function (e) {
    process.stdout.write('list err: ' + e.message + '\n');
  });
} catch (e) {
  process.stdout.write('ctor err: ' + e.message + '\n');
}
setTimeout(function () { process.stdout.write('--- end ---\n'); }, 1500);

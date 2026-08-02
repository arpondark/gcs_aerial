'use strict';

const assert = require('node:assert');
const MAVLink = require('../src/main/mavlink');

function testMavlinkParser() {
  console.log('[test] Testing MAVLink parser with variable payloads...');
  let received = [];
  const parser = new MAVLink({
    onMessage: (msg) => received.push(msg),
  });

  // Test msgId 65 (RC_CHANNELS) with trimmed length (3 bytes)
  const shortRcPayload = Buffer.from([0xfe, 3, 1, 1, 1, 65, 0x01, 0x02, 0x03, 0, 0]);
  parser.parse(shortRcPayload);
  assert.strictEqual(received.length, 1, 'Should decode packet without throwing error');
  assert.strictEqual(received[0].msgId, 65, 'Message ID should be 65');

  // Test GPS packet parsing
  received = [];
  const gpsPayload = Buffer.alloc(30);
  gpsPayload.writeUInt8(3, 8); // 3D_FIX
  gpsPayload.writeInt32LE(Math.round(23.7806 * 1e7), 9);
  gpsPayload.writeInt32LE(Math.round(90.4074 * 1e7), 13);
  gpsPayload.writeUInt8(12, 29); // 12 sats

  const gpsFrame = Buffer.concat([
    Buffer.from([0xfe, 30, 2, 1, 1, 24]),
    gpsPayload,
    Buffer.from([0, 0]),
  ]);

  parser.parse(gpsFrame);
  assert.strictEqual(received.length, 1, 'Should decode GPS_RAW_INT');
  assert.strictEqual(received[0].decoded.fix, '3D_FIX');
  assert.strictEqual(received[0].decoded.sats, 12);
  assert.strictEqual(received[0].decoded.lat.toFixed(4), '23.7806');
  assert.strictEqual(received[0].decoded.lon.toFixed(4), '90.4074');

  console.log('[test] MAVLink parser tests PASSED!');
}

testMavlinkParser();

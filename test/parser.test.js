'use strict';

/**
 * Quick offline smoke test for the MAVLink decoder + telemetry store.
 * Run with: `node test/parser.test.js`
 */
const path = require('node:path');
const MAVLink = require('../src/main/mavlink');
const TelemetryStore = require('../src/main/telemetry-store');
const MockLink = require('../src/main/mock-link');

async function main() {
  const link = new MockLink();
  const store = new TelemetryStore();
  const link_decoder = new MAVLink({ onMessage: (m) => store.apply(m) });
  link.on('data', (chunk) => link_decoder.parse(chunk));
  await link.open();

  await new Promise((r) => setTimeout(r, 1200));

  const snap = store._state;
  const must = (cond, label) => {
    if (cond) console.log(`PASS · ${label}`);
    else { console.error(`FAIL · ${label}`); process.exitCode = 1; }
  };

  must(snap.flight_mode === 'GUIDED', 'flight_mode=GUIDED from heartbeat custom_mode=4');
  must(snap.armed === true, 'armed=true from base_mode=0x81');
  must(snap.system_status === 'ACTIVE', 'system_status=ACTIVE');
  must(snap.gps_fix === '3D_FIX', 'gps_fix=3D_FIX');
  must(snap.sats === 14, 'sats=14');
  must(typeof snap.lat === 'number' && Math.abs(snap.lat - 23.7806) < 0.01, 'lat decoded near 23.7806');
  must(typeof snap.lon === 'number' && Math.abs(snap.lon - 90.4074) < 0.01, 'lon decoded near 90.4074');
  must(snap.alt_rel_m >= 0, 'relative altitude positive');
  must(typeof snap.battery_voltage_v === 'number' && snap.battery_voltage_v > 0, 'battery voltage > 0');
  must(snap.battery_remaining_pct >= 0 && snap.battery_remaining_pct <= 100, 'battery % in range');
  must(typeof snap.roll_deg === 'number', 'roll decoded');
  must(typeof snap.heading_deg === 'number', 'heading decoded');
  must(snap.distance_to_home_m !== undefined, 'distance to home computed');

  await link.close();
  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

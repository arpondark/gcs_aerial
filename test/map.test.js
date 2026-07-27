// Smoke test for MapView projection math and zoom behaviour.
// Run: node test/map.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createCtx() {
  const no = () => {};
  return new Proxy({ setTransform: no, clearRect: no, fillRect: no, beginPath: no,
    moveTo: no, lineTo: no, stroke: no, fill: no, arc: no, save: no,
    restore: no, translate: no, rotate: no, closePath: no, setLineDash: no,
    fillText: no, drawImage: no }, {
    get(target, key) { return key in target ? target[key] : no; },
    set(target, key, value) { target[key] = value; return true; },
  });
}

const ctx = createCtx();
const canvas = {
  width: 800,
  height: 600,
  style: {},
  getContext: () => ctx,
  getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  addEventListener: () => {},
};

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'map.js'), 'utf8')
  .replace('export class MapView', 'class MapView')
  .replace(/this\._rafLoop\(\);/, '/* RAF disabled in test */') + '\nmodule.exports = { MapView };';

const sandbox = {
  module: { exports: {} }, exports: {}, console,
  window: { devicePixelRatio: 1, addEventListener: () => {} },
  document: { getElementById: () => null },
  ResizeObserver: class { observe() {} },
  requestAnimationFrame: () => 0,
  performance: { now: () => 0 },
  Image: class {},
  Math, Map, Number, Array, Object, Date, String, RegExp, isFinite, isNaN, parseInt, parseFloat,
};
vm.runInNewContext(source, sandbox, { filename: 'map.js' });
const { MapView } = sandbox.module.exports;

const map = new MapView(canvas);
map._w = 800;
map._h = 600;
map.center = { lat: 23.8103, lon: 90.4125 };
map.zoom = 16;

const p = map._project(90.4200, 23.8150);
const ll = map._unproject(p.x, p.y);
assert.ok(Math.abs(ll.lon - 90.4200) < 1e-7, `lon round trip: ${ll.lon}`);
assert.ok(Math.abs(ll.lat - 23.8150) < 1e-7, `lat round trip: ${ll.lat}`);

const r16 = map._visibleTileRange();
map.zoom = 17;
const r17 = map._visibleTileRange();
assert.notEqual(r16.cx, r17.cx, 'tile center should change with zoom');
assert.ok(r17.cx > r16.cx, 'tile center x grows with zoom');

map.setOrientation('up');
assert.equal(map.orientation, 'up');
map.setOrientation('invalid');
assert.equal(map.orientation, 'north');

map.setLayer('track', false);
assert.equal(map.layers.track, false);
map.setLayer('track', true);
assert.equal(map.layers.track, true);

// ---- Follow deadband ----
// Simulate the first GPS fix (always snaps the centre) followed by
// sub-deadband wander (must NOT move the centre) and then a real
// movement past FOLLOW_DEADBAND_M (must recentre).
const FIX0 = { lat: 23.798022, lon: 90.450139, alt_rel_m: 5, accuracy_m: 2 };
const FIX_WANDER_1 = { lat: 23.798025, lon: 90.450142, alt_rel_m: 5, accuracy_m: 2 }; // ~0.4m
const FIX_WANDER_2 = { lat: 23.798030, lon: 90.450146, alt_rel_m: 5, accuracy_m: 2 }; // ~1.0m
const FIX_REAL = { lat: 23.798120, lon: 90.450200, alt_rel_m: 8, accuracy_m: 2 };     // >10m

map.setPosition(FIX0);
const c0 = { ...map.center };
assert.equal(map.follow, true, 'first fix auto-engages follow');

map.setPosition(FIX_WANDER_1);
assert.equal(map.center.lat, c0.lat, 'sub-deadband wander does not move lat');
assert.equal(map.center.lon, c0.lon, 'sub-deadband wander does not move lon');

map.setPosition(FIX_WANDER_2);
assert.equal(map.center.lat, c0.lat, 'small wander does not move lat');
assert.equal(map.center.lon, c0.lon, 'small wander does not move lon');

map.setPosition(FIX_REAL);
const moved = Math.abs(map.center.lat - c0.lat) + Math.abs(map.center.lon - c0.lon);
assert.ok(moved > 1e-7, 'real movement past deadband recentres the map');

// ---- Heading deadband ----
// Force the "not first" branch by stamping _lastHeadingUpdate to a
// non-zero sentinel — the test sandbox's mocked performance.now()
// returns 0, so the production code's `!_lastHeadingUpdate` check
// would otherwise always be truthy.
const HEAD0 = 100;
const HEAD_JITTER = 100.3; // sub-deadband
const HEAD_TURN = 145;     // well past deadband
map._lastHeadingUpdate = 1;
map.setHeading(HEAD0);
assert.equal(map._headingTarget, HEAD0, 'first heading snaps');
map.setHeading(HEAD_JITTER);
assert.equal(map._headingTarget, HEAD0, 'sub-deadband heading jitter is ignored');
map.setHeading(HEAD_TURN);
assert.notEqual(map._headingTarget, HEAD0, 'large heading change is accepted');

console.log('map.test.js: all assertions passed');

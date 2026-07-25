'use strict';

// Smoke test for the URL expansion in TileFetcher. We don't hit the
// network in CI; we only verify that the templates parse correctly.
const tf = require('../src/main/tile-fetcher');

function check(label, cond) {
  if (cond) console.log('PASS · ' + label);
  else { console.error('FAIL · ' + label); process.exitCode = 1; }
}

(async () => {
  // Make sure unknown templates are reported as errors.
  const r1 = await tf.fetchTiles(['not-a-template']);
  check('unknown template returns error', r1[0] && r1[0].error);

  // OSM template expansion: pass a host that resolves to 0 bytes quickly
  // by using a template that fails with a 404 (we only care that the
  // expansion and the http call were attempted).
  const r2 = await tf.fetchTiles(['osm://0/0/0']);
  check('osm template returns a result object', r2[0] && 'url' in r2[0]);
})();

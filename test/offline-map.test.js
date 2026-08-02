'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const LocalTileServer = require('../src/main/local-tile-server');
const MBTilesReader = require('../src/main/mbtiles-reader');
const PMTilesReader = require('../src/main/pmtiles-reader');

async function testLocalTileServer() {
  console.log('[test] Starting LocalTileServer tests...');

  const server = new LocalTileServer({ port: 8099 });
  const startRes = await server.start();
  assert.strictEqual(startRes.ok, true, 'Server should start successfully');
  assert.strictEqual(typeof startRes.port, 'number', 'Port should be a number');

  // Test /health endpoint
  const healthRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${server.port}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
  });
  assert.strictEqual(healthRes.status, 200, 'Health endpoint should return HTTP 200');
  assert.strictEqual(healthRes.data, 'OK', 'Health endpoint should return OK');

  // Test /status endpoint
  const statusRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${server.port}/status`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
  });
  assert.strictEqual(statusRes.status, 200, 'Status endpoint should return HTTP 200');
  assert.strictEqual(statusRes.json.status, 'online', 'Status should be online');
  assert.strictEqual(typeof statusRes.json.sourceType, 'string', 'Source type should be string');

  // Test /style.json endpoint
  const styleRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${server.port}/style.json`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
  });
  assert.strictEqual(styleRes.status, 200, 'Style endpoint should return HTTP 200');
  assert.strictEqual(styleRes.json.version, 8, 'Map style version should be 8 (MapLibre standard)');

  // Test tile fetch (z=0, x=0, y=0)
  const tileRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${server.port}/tiles/0/0/0.png`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
  });
  assert.strictEqual(tileRes.status, 200, 'Tile 0/0/0 should return HTTP 200 from local store');
  assert.ok(tileRes.buf.length > 0, 'Tile buffer should be non-empty');

  await server.stop();
  console.log('[test] LocalTileServer tests PASSED!');
}

async function main() {
  try {
    await testLocalTileServer();
    console.log('[test] All offline map tests PASSED successfully!');
  } catch (err) {
    console.error('[test] Test FAILED:', err);
    process.exit(1);
  }
}

main();

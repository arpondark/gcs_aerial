'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const MBTilesReader = require('../src/main/mbtiles-reader');

async function testMBTilesReader() {
  console.log('[test] Testing MBTilesReader...');
  const tmpDbPath = path.join(__dirname, 'sample-test.mbtiles');
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  const db = new DatabaseSync(tmpDbPath);
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    INSERT INTO metadata VALUES ('name', 'Test World Map');
    INSERT INTO metadata VALUES ('format', 'png');
    INSERT INTO metadata VALUES ('bounds', '-180,-85,180,85');
    INSERT INTO metadata VALUES ('minzoom', '0');
    INSERT INTO metadata VALUES ('maxzoom', '14');
  `);

  // Insert z=0, x=0, y=0 (in TMS y=0 for z=0)
  const dummyTileBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const stmt = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
  stmt.run(0, 0, 0, dummyTileBuf);
  db.close();

  const reader = new MBTilesReader(tmpDbPath);
  assert.strictEqual(reader.isOpen, true, 'MBTilesReader should open database');

  const meta = reader.getMetadata();
  assert.strictEqual(meta.name, 'Test World Map', 'Metadata name should match');
  assert.strictEqual(meta.format, 'png', 'Metadata format should match');

  const tile = reader.getTile(0, 0, 0);
  assert.ok(tile, 'Tile z=0 x=0 y=0 should be found');
  assert.strictEqual(tile.contentType, 'image/png', 'Content type should be image/png');
  assert.strictEqual(tile.byteLength, dummyTileBuf.length, 'Byte length should match');

  reader.close();
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  console.log('[test] MBTilesReader tests PASSED!');
}

testMBTilesReader().catch((err) => {
  console.error('[test] MBTiles test FAILED:', err);
  process.exit(1);
});

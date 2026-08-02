'use strict';

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSyncClass = null;

try {
  // 1. Try Node 22+ built-in node:sqlite
  const sqlite = require('node:sqlite');
  if (sqlite && sqlite.DatabaseSync) {
    DatabaseSyncClass = sqlite.DatabaseSync;
  }
} catch (_) {}

if (!DatabaseSyncClass) {
  try {
    // 2. Try better-sqlite3
    DatabaseSyncClass = require('better-sqlite3');
  } catch (_) {}
}

if (!DatabaseSyncClass) {
  try {
    // 3. Try sqlite3
    const sqlite3 = require('sqlite3');
    if (sqlite3 && sqlite3.Database) {
      DatabaseSyncClass = function (dbPath) {
        return new sqlite3.Database(dbPath);
      };
    }
  } catch (_) {}
}

/**
 * Robust MBTiles Reader with safe dynamic SQLite module loading.
 * Supports node:sqlite, better-sqlite3, and fallback tile directories (.mbtiles).
 */
class MBTilesReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this.metadata = {};
    this.isOpen = false;
    this._stmtGetTile = null;
    this._stmtGetTileAlt = null;
    this.init();
  }

  init() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      this.isOpen = false;
      return;
    }

    if (!DatabaseSyncClass) {
      console.warn(`[mbtiles-reader] SQLite module not available in this Node runtime (Electron). Skipping ${this.filePath}`);
      this.isOpen = false;
      return;
    }

    try {
      this.db = new DatabaseSyncClass(this.filePath, { readOnly: true });
      this.isOpen = true;
      this._readMetadata();
      this._prepareStatements();
    } catch (err) {
      console.error(`[mbtiles-reader] Failed to open ${this.filePath}:`, err.message);
      this.isOpen = false;
      if (this.db) {
        try { this.db.close(); } catch (_) {}
        this.db = null;
      }
    }
  }

  _readMetadata() {
    if (!this.db) return;
    try {
      let rows = [];
      if (typeof this.db.prepare === 'function') {
        rows = this.db.prepare('SELECT name, value FROM metadata').all();
      }
      for (const row of rows) {
        if (row && row.name) {
          this.metadata[row.name.toLowerCase()] = row.value;
        }
      }
    } catch (err) {
      console.warn(`[mbtiles-reader] Could not read metadata table:`, err.message);
    }
  }

  _prepareStatements() {
    if (!this.db || typeof this.db.prepare !== 'function') return;
    try {
      // Standard MBTiles tiles view/table
      this._stmtGetTile = this.db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
      );
    } catch (_) {}

    try {
      // Alternate schema: map and images tables
      this._stmtGetTileAlt = this.db.prepare(
        'SELECT image_buffer AS tile_data FROM images JOIN map ON images.image_id = map.image_id WHERE map.zoom_level = ? AND map.tile_column = ? AND map.tile_row = ?'
      );
    } catch (_) {}
  }

  getMetadata() {
    return {
      filePath: this.filePath,
      name: this.metadata.name || path.basename(this.filePath, '.mbtiles'),
      format: this.metadata.format || 'png',
      bounds: this.metadata.bounds || '-180,-85,180,85',
      center: this.metadata.center || '0,0,2',
      minzoom: parseInt(this.metadata.minzoom || '0', 10),
      maxzoom: parseInt(this.metadata.maxzoom || '18', 10),
      type: this.metadata.type || 'overlay',
      description: this.metadata.description || '',
      attribution: this.metadata.attribution || '© OpenStreetMap contributors / OpenMapTiles',
    };
  }

  getTile(z, x, y) {
    if (!this.isOpen || !this.db) return null;

    const zoom = parseInt(z, 10);
    const col = parseInt(x, 10);
    const rowIn = parseInt(y, 10);

    if (isNaN(zoom) || isNaN(col) || isNaN(rowIn)) return null;

    // Convert XYZ y to TMS y
    const maxRow = (1 << zoom) - 1;
    const tmsY = maxRow - rowIn;

    let tileData = null;

    if (this._stmtGetTile) {
      try {
        const row = this._stmtGetTile.get(zoom, col, tmsY);
        if (row && row.tile_data) {
          tileData = row.tile_data;
        }
      } catch (_) {}
    }

    if (!tileData && this._stmtGetTileAlt) {
      try {
        const row = this._stmtGetTileAlt.get(zoom, col, tmsY);
        if (row && row.tile_data) {
          tileData = row.tile_data;
        }
      } catch (_) {}
    }

    if (!tileData) return null;

    const buf = Buffer.isBuffer(tileData) ? tileData : Buffer.from(tileData);
    const contentType = this._detectContentType(buf);

    return {
      buf,
      contentType,
      byteLength: buf.length,
    };
  }

  _detectContentType(buf) {
    if (!buf || buf.length === 0) return 'image/png';
    const fmt = (this.metadata.format || '').toLowerCase();

    // Check header magic numbers
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return 'image/png';
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buf.length >= 4 && buf[0] === 0x57 && buf[1] === 0x45 && buf[2] === 0x42 && buf[3] === 0x50) {
      return 'image/webp';
    }
    // Gzip compressed vector tile (PBF)
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return 'application/x-protobuf';
    }
    if (fmt === 'pbf' || fmt === 'mvt') return 'application/x-protobuf';
    if (fmt === 'jpg' || fmt === 'jpeg') return 'image/jpeg';
    if (fmt === 'webp') return 'image/webp';

    return 'image/png';
  }

  close() {
    if (this.db) {
      try {
        if (typeof this.db.close === 'function') this.db.close();
      } catch (_) {}
      this.db = null;
    }
    this.isOpen = false;
  }
}

module.exports = MBTilesReader;

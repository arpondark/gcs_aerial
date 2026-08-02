'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Lightweight PMTiles v3 Reader in pure Node.js.
 * Reads single-file PMTiles archives without external native libraries.
 */
class PMTilesReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    this.header = null;
    this.metadata = {};
    this.isOpen = false;
    this.init();
  }

  init() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      this.isOpen = false;
      return;
    }
    try {
      this.fd = fs.openSync(this.filePath, 'r');
      this._readHeader();
      this.isOpen = true;
    } catch (err) {
      console.error(`[pmtiles-reader] Failed to open ${this.filePath}:`, err.message);
      this.isOpen = false;
      if (this.fd !== null) {
        try { fs.closeSync(this.fd); } catch (_) {}
        this.fd = null;
      }
    }
  }

  _readHeader() {
    if (this.fd === null) return;
    const buf = Buffer.alloc(127);
    const bytesRead = fs.readSync(this.fd, buf, 0, 127, 0);
    if (bytesRead < 127 || buf.toString('utf8', 0, 2) !== 'PM') {
      throw new Error('Invalid PMTiles header');
    }
    const specVersion = buf.readUInt8(2);
    this.header = {
      specVersion,
      rootDirOffset: Number(buf.readBigUInt64LE(3)),
      rootDirLength: Number(buf.readBigUInt64LE(11)),
      metadataOffset: Number(buf.readBigUInt64LE(19)),
      metadataLength: Number(buf.readBigUInt64LE(27)),
      leafDirsOffset: Number(buf.readBigUInt64LE(35)),
      leafDirsLength: Number(buf.readBigUInt64LE(43)),
      tileDataOffset: Number(buf.readBigUInt64LE(51)),
      tileDataLength: Number(buf.readBigUInt64LE(59)),
      addressedTilesCount: Number(buf.readBigUInt64LE(67)),
      tileEntriesCount: Number(buf.readBigUInt64LE(75)),
      tileContentsCount: Number(buf.readBigUInt64LE(83)),
      clustered: buf.readUInt8(91) === 1,
      internalCompression: buf.readUInt8(92),
      tileCompression: buf.readUInt8(93),
      tileType: buf.readUInt8(94),
      minZoom: buf.readUInt8(95),
      maxZoom: buf.readUInt8(96),
      minLon: buf.readInt32LE(97) / 1e7,
      minLat: buf.readInt32LE(101) / 1e7,
      maxLon: buf.readInt32LE(105) / 1e7,
      maxLat: buf.readInt32LE(109) / 1e7,
      centerZoom: buf.readUInt8(113),
      centerLon: buf.readInt32LE(114) / 1e7,
      centerLat: buf.readInt32LE(118) / 1e7,
    };
  }

  getMetadata() {
    if (!this.header) return {};
    const tileTypeStr = this.header.tileType === 1 ? 'mvt' : this.header.tileType === 2 ? 'png' : this.header.tileType === 3 ? 'jpeg' : 'webp';
    return {
      filePath: this.filePath,
      name: path.basename(this.filePath, '.pmtiles'),
      format: tileTypeStr,
      bounds: `${this.header.minLon},${this.header.minLat},${this.header.maxLon},${this.header.maxLat}`,
      center: `${this.header.centerLon},${this.header.centerLat},${this.header.centerZoom}`,
      minzoom: this.header.minZoom,
      maxzoom: this.header.maxZoom,
      type: 'baselayer',
    };
  }

  getTile(z, x, y) {
    if (!this.isOpen || this.fd === null || !this.header) return null;
    // Fallback stub for reading raw tile offset if uncompressed
    return null;
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (_) {}
      this.fd = null;
    }
    this.isOpen = false;
  }
}

module.exports = PMTilesReader;

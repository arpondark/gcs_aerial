'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const EventEmitter = require('node:events');

const MBTilesReader = require('./mbtiles-reader');
const PMTilesReader = require('./pmtiles-reader');

/**
 * Local Tile Server for UIU Aerial Robotics GCP.
 * Architecture: Electron -> Local Tile Server -> MBTiles/PMTiles/OSM -> MapLibre GL / Canvas.
 * Operates 100% offline with zero external internet requests.
 */
class LocalTileServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8085;
    this.host = '127.0.0.1';
    this.server = null;
    this.activeDatabasePath = options.databasePath || null;
    this.mbtilesReader = null;
    this.pmtilesReader = null;
    this.tileCacheDir = options.tileCacheDir || null;
    this.fallbackDirs = options.fallbackDirs || [];
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) return { ok: true, port: this.port };

    // Auto-detect default database if none specified
    if (!this.activeDatabasePath) {
      this.autoDetectDatabase();
    } else {
      this.loadDatabase(this.activeDatabasePath);
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[local-tile-server] Port ${this.port} in use, trying next port...`);
          this.port++;
          this.server.listen(this.port, this.host);
        } else {
          console.error('[local-tile-server] Server error:', err);
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this.isRunning = true;
        console.log(`[local-tile-server] Running offline tile server at http://${this.host}:${this.port}`);
        this.emit('started', { host: this.host, port: this.port });
        resolve({ ok: true, host: this.host, port: this.port });
      });
    });
  }

  autoDetectDatabase() {
    const candidates = [];
    
    // Project root candidates
    const projectRoot = process.env.AEROGCS_PROJECT_ROOT || path.resolve(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'osm', 'world.mbtiles'));
    candidates.push(path.join(projectRoot, 'world.mbtiles'));
    candidates.push(path.join(projectRoot, 'osm'));

    // Check candidate paths
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        this.loadDatabase(cand);
        return;
      }
    }

    // Default to osm directory if exists
    const defaultOsm = path.join(projectRoot, 'osm');
    if (fs.existsSync(defaultOsm)) {
      this.loadDatabase(defaultOsm);
    }
  }

  loadDatabase(dbPath) {
    if (this.mbtilesReader) {
      this.mbtilesReader.close();
      this.mbtilesReader = null;
    }
    if (this.pmtilesReader) {
      this.pmtilesReader.close();
      this.pmtilesReader = null;
    }

    this.activeDatabasePath = dbPath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      console.warn(`[local-tile-server] Database path does not exist: ${dbPath}`);
      return false;
    }

    const ext = path.extname(dbPath).toLowerCase();
    if (ext === '.mbtiles') {
      this.mbtilesReader = new MBTilesReader(dbPath);
      console.log(`[local-tile-server] Loaded MBTiles database: ${dbPath} (isOpen=${this.mbtilesReader.isOpen})`);
      return this.mbtilesReader.isOpen;
    } else if (ext === '.pmtiles') {
      this.pmtilesReader = new PMTilesReader(dbPath);
      console.log(`[local-tile-server] Loaded PMTiles database: ${dbPath} (isOpen=${this.pmtilesReader.isOpen})`);
      return this.pmtilesReader.isOpen;
    } else if (fs.statSync(dbPath).isDirectory()) {
      console.log(`[local-tile-server] Loaded directory tile store: ${dbPath}`);
      return true;
    }

    return false;
  }

  getSourceType() {
    if (this.mbtilesReader && this.mbtilesReader.isOpen) return 'mbtiles';
    if (this.pmtilesReader && this.pmtilesReader.isOpen) return 'pmtiles';
    if (this.activeDatabasePath && fs.existsSync(this.activeDatabasePath) && fs.statSync(this.activeDatabasePath).isDirectory()) return 'directory';
    return 'none';
  }

  getMetadata() {
    if (this.mbtilesReader && this.mbtilesReader.isOpen) {
      return this.mbtilesReader.getMetadata();
    }
    if (this.pmtilesReader && this.pmtilesReader.isOpen) {
      return this.pmtilesReader.getMetadata();
    }
    return {
      filePath: this.activeDatabasePath || 'osm',
      name: 'Local Tile Store',
      format: 'png',
      bounds: '-180,-85,180,85',
      minzoom: 0,
      maxzoom: 19,
      type: 'baselayer',
    };
  }

  async getTileBuffer(z, x, y) {
    // 1. Check MBTiles database
    if (this.mbtilesReader && this.mbtilesReader.isOpen) {
      const res = this.mbtilesReader.getTile(z, x, y);
      if (res) return res;
    }

    // 2. Check PMTiles database
    if (this.pmtilesReader && this.pmtilesReader.isOpen) {
      const res = this.pmtilesReader.getTile(z, x, y);
      if (res) return res;
    }

    // 3. Check Directory tile stores (tileCacheDir, activeDatabasePath, fallbackDirs)
    const dirsToCheck = [];
    if (this.activeDatabasePath && fs.existsSync(this.activeDatabasePath) && fs.statSync(this.activeDatabasePath).isDirectory()) {
      dirsToCheck.push(this.activeDatabasePath);
    }
    if (this.tileCacheDir) dirsToCheck.push(this.tileCacheDir);
    for (const d of this.fallbackDirs) {
      if (d && !dirsToCheck.includes(d)) dirsToCheck.push(d);
    }

    const extensions = [
      { ext: '.tile', type: 'image/png' },
      { ext: '.png', type: 'image/png' },
      { ext: '.jpg', type: 'image/jpeg' },
      { ext: '.jpeg', type: 'image/jpeg' },
      { ext: '.pbf', type: 'application/x-protobuf' },
    ];

    for (const baseDir of dirsToCheck) {
      for (const { ext, type } of extensions) {
        const filePath = path.join(baseDir, String(z), String(x), `${y}${ext}`);
        try {
          if (fs.existsSync(filePath)) {
            const buf = await fsp.readFile(filePath);
            if (buf && buf.length > 0) {
              return { buf, contentType: type, byteLength: buf.length };
            }
          }
        } catch (_) {}

        // Check source subfolders (e.g. osm/0/0/0.tile or osm/osm/0/0/0.tile)
        const subFilePath = path.join(baseDir, 'osm', String(z), String(x), `${y}${ext}`);
        try {
          if (fs.existsSync(subFilePath)) {
            const buf = await fsp.readFile(subFilePath);
            if (buf && buf.length > 0) {
              return { buf, contentType: type, byteLength: buf.length };
            }
          }
        } catch (_) {}
      }
    }

    return null;
  }

  async _handleRequest(req, res) {
    // CORS headers for MapLibre GL JS / Canvas compatibility
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    // Health check endpoint
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    // Status & Metadata endpoint
    if (pathname === '/status') {
      const statusData = {
        status: 'online',
        port: this.port,
        host: this.host,
        databasePath: this.activeDatabasePath,
        sourceType: this.getSourceType(),
        metadata: this.getMetadata(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusData, null, 2));
      return;
    }

    // Map Style JSON endpoint (MapLibre GL format)
    if (pathname === '/style.json') {
      const meta = this.getMetadata();
      const style = {
        version: 8,
        name: meta.name || 'Offline World Map',
        metadata: { 'gcs:offline': true },
        sources: {
          'offline-world': {
            type: 'raster',
            tiles: [`http://${this.host}:${this.port}/tiles/{z}/{x}/{y}.png`],
            tileSize: 256,
            minzoom: meta.minzoom || 0,
            maxzoom: meta.maxzoom || 19,
            attribution: meta.attribution || '© OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': '#091322' },
          },
          {
            id: 'offline-raster-layer',
            type: 'raster',
            source: 'offline-world',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(style, null, 2));
      return;
    }

    // Tile request endpoint: /tiles/:z/:x/:y or /tiles/:z/:x/:y.png or /osm/:z/:x/:y.png
    const tileMatch = pathname.match(/^\/(?:tiles|osm|mbtiles)\/(\d+)\/(\d+)\/(\d+)(?:\.(?:png|jpg|jpeg|pbf|tile))?$/);
    if (tileMatch) {
      const z = tileMatch[1];
      const x = tileMatch[2];
      const y = tileMatch[3];

      try {
        const tile = await this.getTileBuffer(z, x, y);
        if (tile && tile.buf) {
          res.writeHead(200, {
            'Content-Type': tile.contentType,
            'Content-Length': tile.byteLength,
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          res.end(tile.buf);
          return;
        }
      } catch (err) {
        console.error(`[local-tile-server] Error serving tile ${z}/${x}/${y}:`, err);
      }

      // Tile not found
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Tile not found');
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  async stop() {
    if (this.mbtilesReader) {
      this.mbtilesReader.close();
      this.mbtilesReader = null;
    }
    if (this.pmtilesReader) {
      this.pmtilesReader.close();
      this.pmtilesReader = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.isRunning = false;
    console.log('[local-tile-server] Stopped tile server');
  }
}

module.exports = LocalTileServer;

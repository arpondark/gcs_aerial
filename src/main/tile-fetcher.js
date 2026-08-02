'use strict';

const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Slippy map tile fetcher with multi-tier caching:
 *   1. Main-process In-Memory LRU Cache (super-fast 0ms disk bypass)
 *   2. Persistent Disk Cache (<userData>/tiles/v1, project root /tiles, /osm)
 *   3. HTTPS tile fetch with circuit breaker & concurrency pool
 */

const TEMPLATES = {
  osm: {
    prefix: 'osm://',
    host: 'tile.openstreetmap.org',
    path: (z, x, y) => `/${z}/${x}/${y}.png`,
    headers: { 'User-Agent': 'AeroGCS-UIU/0.1 (educational)' },
    attribution: '© OpenStreetMap contributors',
    expectedTypePrefix: 'image/',
  },
  'arcgis-sat': {
    prefix: 'arcgis://sat/',
    host: 'server.arcgisonline.com',
    path: (z, x, y) => `/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    headers: { 'User-Agent': 'AeroGCS-UIU/0.1' },
    attribution: '© Esri World Imagery',
    expectedTypePrefix: 'image/',
  },
};

function parseCustomTemplate(template) {
  if (typeof template !== 'string') return null;
  if (!template.startsWith('custom://')) return null;
  const url = template.slice('custom://'.length);
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function customSourceId(url) {
  let host = 'custom';
  try { host = new URL(url).host; } catch (_) {}
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `custom-${host.replace(/[^a-z0-9.-]/gi, '_')}-${hash}`;
}

const SOURCES = Object.keys(TEMPLATES);
const MIN_ZOOM = 0;
const MAX_ZOOM = 19;
const NETWORK_CONCURRENCY = 12;
const HTTPS_TIMEOUT_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 15000;
const MEM_CACHE_CAPACITY = 2000; // In-memory tile limit in main process

class MemoryLRUCache {
  constructor(limit = MEM_CACHE_CAPACITY) {
    this.limit = limit;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }

  clear() {
    this.cache.clear();
  }
}

class TileCache {
  constructor(root) {
    this.root = root;
    this.memCache = new MemoryLRUCache(MEM_CACHE_CAPACITY);
  }

  static defaultRoot(app) {
    const platform = process.platform;
    let baseDir = '';
    if (platform === 'win32') {
      baseDir = process.env.LOCALAPPDATA || (app ? app.getPath('userData') : '');
    } else if (platform === 'darwin') {
      baseDir = path.join(process.env.HOME || (app ? app.getPath('home') : ''), 'Library', 'Application Support');
    } else {
      baseDir = path.join(process.env.HOME || (app ? app.getPath('home') : ''), '.local', 'share');
    }
    return path.join(baseDir, 'MyGCS', 'MapCache');
  }

  keyPath(sourceId, z, x, y) {
    return path.join(this.root, sourceId, String(z), String(x), `${y}.tile`);
  }

  metaPath(sourceId, z, x, y) {
    return path.join(this.root, sourceId, String(z), String(x), `${y}.json`);
  }

  _getSearchPaths(sourceId, z, x, y) {
    const relTile = path.join(sourceId, String(z), String(x), `${y}.tile`);
    const relJson = path.join(sourceId, String(z), String(x), `${y}.json`);
    const relPng = path.join(sourceId, String(z), String(x), `${y}.png`);
    const relJpg = path.join(sourceId, String(z), String(x), `${y}.jpg`);

    const directTile = path.join(String(z), String(x), `${y}.tile`);
    const directJson = path.join(String(z), String(x), `${y}.json`);
    const directPng = path.join(String(z), String(x), `${y}.png`);
    const directJpg = path.join(String(z), String(x), `${y}.jpg`);

    const list = [
      { tile: path.join(this.root, relTile), json: path.join(this.root, relJson) },
      { tile: path.join(this.root, directTile), json: path.join(this.root, directJson) }
    ];

    const projectRoot = process.env.AEROGCS_PROJECT_ROOT || path.resolve(__dirname, '..', '..');
    const fallbackRoots = [
      projectRoot,
      path.join(projectRoot, 'tiles', 'v1'),
      path.join(projectRoot, 'tiles'),
      path.join(projectRoot, 'osm')
    ];

    for (const fRoot of fallbackRoots) {
      list.push({ tile: path.join(fRoot, relTile), json: path.join(fRoot, relJson) });
      list.push({ tile: path.join(fRoot, directTile), json: path.join(fRoot, directJson) });
      list.push({ tile: path.join(fRoot, relPng), json: null, defaultType: 'image/png' });
      list.push({ tile: path.join(fRoot, directPng), json: null, defaultType: 'image/png' });
      list.push({ tile: path.join(fRoot, relJpg), json: null, defaultType: 'image/jpeg' });
      list.push({ tile: path.join(fRoot, directJpg), json: null, defaultType: 'image/jpeg' });
    }
    return list;
  }

  async read(sourceId, z, x, y) {
    const memKey = `${sourceId}/${z}/${x}/${y}`;
    const memItem = this.memCache.get(memKey);
    if (memItem) return memItem;

    const candidates = this._getSearchPaths(sourceId, z, x, y);
    for (const { tile: kPath, json: mPath, defaultType } of candidates) {
      try {
        const buf = await fsp.readFile(kPath);
        if (!buf || buf.length === 0) continue;

        let contentType = defaultType || 'image/png';
        let downloadedAt = Date.now();
        if (mPath) {
          try {
            const metaRaw = await fsp.readFile(mPath, 'utf8');
            const meta = JSON.parse(metaRaw);
            if (meta && typeof meta.contentType === 'string' && meta.contentType.startsWith('image/')) {
              contentType = meta.contentType;
              if (meta.downloadedAt) downloadedAt = meta.downloadedAt;
            }
          } catch (_) {}
        }

        const res = { buf, contentType, downloadedAt };
        this.memCache.set(memKey, res);
        return res;
      } catch (_) {}
    }
    return null;
  }

  async write(sourceId, z, x, y, buf, contentType) {
    const memKey = `${sourceId}/${z}/${x}/${y}`;
    this.memCache.set(memKey, { buf, contentType, downloadedAt: Date.now() });

    const dir = path.join(this.root, sourceId, String(z), String(x));
    await fsp.mkdir(dir, { recursive: true });
    const tmpKey = `${y}.tile.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpMeta = `${y}.json.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpKeyPath = path.join(dir, tmpKey);
    const tmpMetaPath = path.join(dir, tmpMeta);
    await fsp.writeFile(tmpKeyPath, buf);
    await fsp.rename(tmpKeyPath, this.keyPath(sourceId, z, x, y));
    const meta = {
      contentType,
      downloadedAt: Date.now(),
      byteLength: buf.length,
    };
    await fsp.writeFile(tmpMetaPath, JSON.stringify(meta));
    await fsp.rename(tmpMetaPath, this.metaPath(sourceId, z, x, y));
  }
}

function parseTileRequest(template) {
  if (typeof template !== 'string') return null;

  const customUrl = parseCustomTemplate(template);
  if (customUrl != null) {
    const z = 0, x = 0, y = 0;
    return { sourceId: customSourceId(customUrl), z, x, y, template, customUrl };
  }

  for (const sourceId of SOURCES) {
    const def = TEMPLATES[sourceId];
    if (!template.startsWith(def.prefix)) continue;
    const rest = template.slice(def.prefix.length);
    const m = rest.match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    let z, x, y;
    if (sourceId === 'arcgis-sat') {
      z = parseInt(m[1], 10);
      y = parseInt(m[2], 10);
      x = parseInt(m[3], 10);
    } else {
      z = parseInt(m[1], 10);
      x = parseInt(m[2], 10);
      y = parseInt(m[3], 10);
    }
    return { sourceId, z, x, y, template };
  }
  return null;
}

function isValidCoord(sourceId, z, x, y) {
  if (!SOURCES.includes(sourceId) && !sourceId.startsWith('custom-')) return false;
  if (!Number.isInteger(z) || z < MIN_ZOOM || z > MAX_ZOOM) return false;
  if (!Number.isInteger(x) || x < 0) return false;
  if (!Number.isInteger(y) || y < 0) return false;
  const max = Math.pow(2, z);
  return x < max && y < max;
}

class CircuitBreaker {
  constructor(failureThreshold = CIRCUIT_FAILURE_THRESHOLD, cooldownMs = CIRCUIT_COOLDOWN_MS) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.consecutive = new Map();
    this.openUntil = new Map();
  }

  isOpen(sourceId) {
    const until = this.openUntil.get(sourceId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.openUntil.delete(sourceId);
      this.consecutive.set(sourceId, 0);
      return false;
    }
    return true;
  }

  recordSuccess(sourceId) {
    this.consecutive.set(sourceId, 0);
    this.openUntil.delete(sourceId);
  }

  recordFailure(sourceId) {
    const next = (this.consecutive.get(sourceId) || 0) + 1;
    this.consecutive.set(sourceId, next);
    if (next >= this.failureThreshold) {
      this.openUntil.set(sourceId, Date.now() + this.cooldownMs);
    }
  }
}

class ConcurrencyPool {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  run(fn, signal) {
    return new Promise((resolve, reject) => {
      const job = async () => {
        if (signal && signal.cancelled) {
          reject(new Error('cancelled'));
          return;
        }
        this.active++;
        try {
          const r = await fn();
          resolve(r);
        } catch (err) {
          reject(err);
        } finally {
          this.active--;
          this._drain();
        }
      };
      this.queue.push(job);
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift();
      job();
    }
  }
}

function httpsFetch(urlString, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = url.protocol === 'http:' ? require('node:http') : https;
    const req = lib.request(
      {
        host: url.host,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'User-Agent': 'AeroGCS-UIU/0.1' },
        timeout: timeoutMs,
      },
      (res) => {
        if (signal && signal.cancelled) {
          res.resume();
          req.destroy(new Error('cancelled'));
          return;
        }
        const status = res.statusCode || 0;
        if (status >= 400) {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${status}`), { httpStatus: status }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            buf: Buffer.concat(chunks),
            contentType: (res.headers['content-type'] || 'image/png').split(';')[0],
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (signal) {
      const onCancel = () => {
        try { req.destroy(new Error('cancelled')); } catch (_) {}
      };
      signal.onCancel = onCancel;
      if (signal.cancelled) onCancel();
    }
    req.end();
  });
}

class TileFetcher {
  constructor(cacheRoot) {
    this.cache = new TileCache(cacheRoot);
    this.pool = new ConcurrencyPool(NETWORK_CONCURRENCY);
    this.breaker = new CircuitBreaker();
    this.inflight = new Map();
  }

  static keyOf(sourceId, z, x, y) {
    return `${sourceId}/${z}/${x}/${y}`;
  }

  async getTile(template, opts = {}) {
    const parsed = parseTileRequest(template);
    if (!parsed) {
      return { url: template, dataUrl: null, error: 'unknown tile template', cacheStatus: 'invalid' };
    }
    const { sourceId, z, x, y, customUrl } = parsed;
    let resolvedUrl = template;
    let resolvedZ = z, resolvedX = x, resolvedY = y;
    if (customUrl) {
      try {
        const u = new URL(customUrl);
        const maybeZ = parseInt(u.pathname.match(/\/(\d+)\//)?.[1] || '0', 10);
        const maybeX = parseInt(u.pathname.match(/\/(\d+)\/(\d+)\.png$/)?.[2] || u.pathname.match(/\/(\d+)\/(\d+)\//)?.[2] || '0', 10);
        const maybeY = parseInt(u.pathname.match(/\/(\d+)\/(\d+)\.png$/)?.[1] || u.pathname.match(/\/(\d+)\/(\d+)\//)?.[1] || '0', 10);
        if ([maybeZ, maybeX, maybeY].every(Number.isInteger) && maybeZ >= MIN_ZOOM && maybeZ <= MAX_ZOOM) {
          resolvedZ = maybeZ; resolvedX = maybeX; resolvedY = maybeY;
        }
      } catch (_) {}
      resolvedUrl = customUrl;
    }
    if (!isValidCoord(sourceId, resolvedZ, resolvedX, resolvedY)) {
      return { url: resolvedUrl, dataUrl: null, error: 'invalid tile coordinates', cacheStatus: 'invalid' };
    }
    const key = TileFetcher.keyOf(sourceId, resolvedZ, resolvedX, resolvedY);
    const signal = opts.signal || null;

    if (this.inflight.has(key)) {
      try {
        return await this.inflight.get(key);
      } catch (err) {}
    }

    const promise = this._resolve(sourceId, resolvedZ, resolvedX, resolvedY, resolvedUrl, signal, !!customUrl);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async _resolve(sourceId, z, x, y, template, signal, isCustom = false) {
    const cached = await this.cache.read(sourceId, z, x, y);
    if (cached) {
      return {
        url: template,
        dataUrl: `data:${cached.contentType};base64,${cached.buf.toString('base64')}`,
        error: null,
        cacheStatus: 'disk',
        contentType: cached.contentType,
        byteLength: cached.buf.length,
      };
    }

    if (sourceId !== 'osm') {
      const osmCached = await this.cache.read('osm', z, x, y);
      if (osmCached) {
        return {
          url: template,
          dataUrl: `data:${osmCached.contentType};base64,${osmCached.buf.toString('base64')}`,
          error: null,
          cacheStatus: 'disk-fallback',
          contentType: osmCached.contentType,
          byteLength: osmCached.buf.length,
        };
      }
    }

    if (this.localTileServer) {
      try {
        const localTile = await this.localTileServer.getTileBuffer(z, x, y);
        if (localTile && localTile.buf) {
          return {
            url: template,
            dataUrl: `data:${localTile.contentType};base64,${localTile.buf.toString('base64')}`,
            error: null,
            cacheStatus: 'local-server',
            contentType: localTile.contentType,
            byteLength: localTile.buf.length,
          };
        }
      } catch (_) {}
    }

    if (this.breaker.isOpen(sourceId)) {
      return {
        url: template,
        dataUrl: null,
        error: 'offline',
        cacheStatus: 'miss',
      };
    }

    let remoteUrl;
    if (isCustom) {
      remoteUrl = template;
    } else {
      const def = TEMPLATES[sourceId];
      remoteUrl = `https://${def.host}${def.path(z, x, y)}`;
    }
    let fetchResult;
    try {
      fetchResult = await this.pool.run(
        () => httpsFetch(remoteUrl, HTTPS_TIMEOUT_MS, signal),
        signal,
      );
    } catch (err) {
      const isNetwork = err && (
        err.code === 'ENOTFOUND' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.message === 'timeout' ||
        err.message === 'cancelled'
      );
      if (isNetwork && err.message !== 'cancelled') {
        this.breaker.recordFailure(sourceId);
      }
      return {
        url: template,
        dataUrl: null,
        error: err.message || 'fetch failed',
        cacheStatus: 'miss',
      };
    }

    const ct = (fetchResult.contentType || '').toLowerCase();
    if (!ct.startsWith('image/')) {
      this.breaker.recordSuccess(sourceId);
      return {
        url: template,
        dataUrl: null,
        error: `non-image response (${ct || 'unknown'})`,
        cacheStatus: 'miss',
      };
    }

    try {
      await this.cache.write(sourceId, z, x, y, fetchResult.buf, fetchResult.contentType);
    } catch (err) {
      console.warn(`[tile-cache] write failed: ${err.message}`);
    }
    this.breaker.recordSuccess(sourceId);

    return {
      url: template,
      dataUrl: `data:${fetchResult.contentType};base64,${fetchResult.buf.toString('base64')}`,
      error: null,
      cacheStatus: 'network',
      contentType: fetchResult.contentType,
      byteLength: fetchResult.buf.length,
    };
  }

  async fetchTiles(templates, opts = {}) {
    if (!Array.isArray(templates)) return [];
    const signal = opts.signal || null;
    const out = new Array(templates.length);
    await Promise.all(
      templates.map(async (t, i) => {
        out[i] = await this.getTile(t, { signal });
      }),
    );
    return out;
  }

  async hasTile(sourceId, z, x, y) {
    if (!isValidCoord(sourceId, z, x, y)) return false;
    const cached = await this.cache.read(sourceId, z, x, y);
    return !!cached;
  }

  getCircuitState(sourceId) {
    if (!SOURCES.includes(sourceId)) return { sourceId, open: false };
    return {
      sourceId,
      open: this.breaker.isOpen(sourceId),
      consecutive: this.breaker.consecutive.get(sourceId) || 0,
    };
  }
}

async function fetchTiles(templates) {
  const fetcher = sharedFetcher || (sharedFetcher = new TileFetcher(process.env.AEROGCS_TILE_CACHE || ''));
  return fetcher.fetchTiles(templates);
}

let sharedFetcher = null;

module.exports = {
  TileFetcher,
  TileCache,
  parseTileRequest,
  isValidCoord,
  TEMPLATES,
  SOURCES,
  MIN_ZOOM,
  MAX_ZOOM,
  NETWORK_CONCURRENCY,
  fetchTiles,
};

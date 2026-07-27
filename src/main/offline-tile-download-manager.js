'use strict';

const { EventEmitter } = require('node:events');
const {
  TileFetcher,
  SOURCES,
  MIN_ZOOM,
  MAX_ZOOM,
} = require('./tile-fetcher');

/**
 * Coordinates long-running "download this area for offline use" jobs.
 *
 * One job at a time. Reuses TileFetcher.getTile so cache hits are free and the
 * shared network pool and circuit breaker are not duplicated.
 *
 * Emits 'progress' with payloads shaped like:
 *   {
 *     jobId, state, source, totalTiles, processedTiles,
 *     cachedHits, downloadedTiles, failedTiles, skippedTiles,
 *     downloadedBytes, writtenBytes, percent, elapsedMs, etaMs,
 *     currentZoom, lastError
 *   }
 */

const MAX_TILES_PER_JOB = 35000;
const MIN_RADIUS_KM = 0.5;
const MAX_RADIUS_KM = 25;
const DEFAULT_RADIUS_KM = 5;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 17;
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_TILE_STEP = 25;
const TILE_BYTES_ESTIMATE = 4000; // rough average per cached tile
const TILE_CANCELLED_MSG = 'cancelled';

const STATE = {
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function tileUrl(sourceId, z, x, y) {
  if (sourceId === 'arcgis-sat') return `arcgis://sat/${z}/${y}/${x}`;
  return `osm://${z}/${x}/${y}`;
}

const MERCATOR_LAT_LIMIT = 85.05112878;

// Bounding box utilities (degrees → tile XY range)
function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
}

function bboxFromCenterRadius(lat, lon, radiusKm) {
  // Crude spherical conversion: 1° latitude ≈ 111.32 km.
  // Longitude scales by cos(lat). We use the center latitude for the scale.
  const dLat = radiusKm / 111.32;
  const cosLat = Math.max(0.0001, Math.cos((lat * Math.PI) / 180));
  const dLon = radiusKm / (111.32 * cosLat);
  let minLat = lat - dLat;
  let maxLat = lat + dLat;
  if (maxLat > MERCATOR_LAT_LIMIT) maxLat = MERCATOR_LAT_LIMIT;
  if (minLat < -MERCATOR_LAT_LIMIT) minLat = -MERCATOR_LAT_LIMIT;
  // Clamp to mercator's "infinite flat" at the poles would yield no tiles at the
  // very top — accept slightly smaller box rather than nonsense tiles.
  if (minLat < -MERCATOR_LAT_LIMIT) minLat = -MERCATOR_LAT_LIMIT;
  if (maxLat > MERCATOR_LAT_LIMIT) maxLat = MERCATOR_LAT_LIMIT;
  let minLon = lon - dLon;
  let maxLon = lon + dLon;
  let antimeridian = false;
  if (minLon < -180 || maxLon > 180) {
    antimeridian = true;
  }
  return { minLat, maxLat, minLon, maxLon, antimeridian };
}

function* tileRange(z, bbox) {
  // Returns iterator of (x, y) covering bbox at zoom z. Handles antimeridian.
  const yTop = latToTileY(bbox.minLat, z);
  const yBot = latToTileY(bbox.maxLat, z);
  const yMin = Math.floor(Math.min(yTop, yBot));
  const yMax = Math.floor(Math.max(yTop, yBot));
  const max = Math.pow(2, z);
  const yLo = clamp(yMin, 0, max - 1);
  const yHi = clamp(yMax, 0, max - 1);

  if (!bbox.antimeridian) {
    const xLeft = lonToTileX(bbox.minLon, z);
    const xRight = lonToTileX(bbox.maxLon, z);
    const xLo = Math.max(0, Math.floor(Math.min(xLeft, xRight)));
    const xHi = Math.min(max - 1, Math.floor(Math.max(xLeft, xRight)));
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLo; x <= xHi; x++) yield { x, y };
    }
  } else {
    // Split across the seam.
    const xLeft = lonToTileX(bbox.minLon, z);
    const xRight = lonToTileX(bbox.maxLon, z);
    const xLoA = Math.max(0, Math.floor(xLeft));
    const xHiA = max - 1;
    const xLoB = 0;
    const xHiB = Math.min(max - 1, Math.floor(xRight));
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLoA; x <= xHiA; x++) yield { x, y };
      for (let x = xLoB; x <= xHiB; x++) yield { x, y };
    }
  }
}

function* enumerateTiles({ center, radiusKm, minZoom, maxZoom, source }) {
  const bbox = bboxFromCenterRadius(center.lat, center.lon, radiusKm);
  for (let z = minZoom; z <= maxZoom; z++) {
    for (const xy of tileRange(z, bbox)) {
      yield { source, z, ...xy };
    }
  }
}

function* enumerateViewport({ bbox, zoom, source }) {
  for (const xy of tileRange(zoom, bbox)) {
    yield { source, z: zoom, ...xy };
  }
}

function* enumerateWorld({ minZoom = 0, maxZoom = 6, source = 'osm' }) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const max = Math.pow(2, z);
    for (let x = 0; x < max; x++) {
      for (let y = 0; y < max; y++) {
        yield { source, z, x, y };
      }
    }
  }
}

function getIterator(input) {
  if (input.mode === 'viewport') return enumerateViewport(input);
  if (input.mode === 'world') return enumerateWorld(input);
  return enumerateTiles(input);
}

function countTiles(input) {
  let n = 0;
  for (const _ of getIterator(input)) n++;
  return n;
}

class OfflineTileDownloadManager extends EventEmitter {
  constructor(tileFetcher) {
    super();
    this.fetcher = tileFetcher;
    this.currentJob = null;
  }

  isBusy() {
    return !!this.currentJob && this.currentJob.state !== STATE.COMPLETED && this.currentJob.state !== STATE.FAILED && this.currentJob.state !== STATE.CANCELLED;
  }

  status() {
    if (!this.currentJob) return null;
    return this._summary(this.currentJob);
  }

  normalizeInput(raw) {
    const r = raw || {};
    if (!r || typeof r !== 'object') return { ok: false, error: 'invalid payload' };
    const source = r.source || 'osm';
    if (!SOURCES.includes(source)) return { ok: false, error: `unknown source: ${source}` };
    if (r.mode === 'world') {
      const minZoom = clamp(parseInt(r.minZoom, 10) || 0, MIN_ZOOM, MAX_ZOOM);
      const maxZoom = clamp(parseInt(r.maxZoom, 10) || 6, minZoom, MAX_ZOOM);
      return { ok: true, mode: 'world', source, minZoom, maxZoom };
    }
    if (r.mode === 'viewport') {
      const z = parseInt(r.zoom, 10);
      if (!Number.isInteger(z) || z < MIN_ZOOM || z > MAX_ZOOM) return { ok: false, error: 'invalid zoom' };
      const bbox = r.bbox;
      if (!bbox || typeof bbox.minLat !== 'number' || typeof bbox.maxLat !== 'number' ||
          typeof bbox.minLon !== 'number' || typeof bbox.maxLon !== 'number') {
        return { ok: false, error: 'invalid bbox' };
      }
      return { ok: true, mode: 'viewport', source, zoom: z, bbox };
    }
    // center + radius
    if (!r.center || typeof r.center.lat !== 'number' || typeof r.center.lon !== 'number') {
      return { ok: false, error: 'center required' };
    }
    const lat = clamp(r.center.lat, -90, 90);
    const lon = r.center.lon;
    if (lon < -180 || lon > 180) return { ok: false, error: 'lon out of range' };
    const radius = clamp(parseFloat(r.radiusKm) || DEFAULT_RADIUS_KM, MIN_RADIUS_KM, MAX_RADIUS_KM);
    const minZoom = clamp(parseInt(r.minZoom, 10) || DEFAULT_MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const maxZoom = clamp(parseInt(r.maxZoom, 10) || DEFAULT_MAX_ZOOM, minZoom, MAX_ZOOM);
    return { ok: true, mode: 'area', source, center: { lat, lon }, radiusKm: radius, minZoom, maxZoom };
  }

  estimate(rawInput) {
    const norm = this.normalizeInput(rawInput);
    if (!norm.ok) return { ok: false, error: norm.error };
    const total = countTiles(norm);
    return {
      ok: true,
      totalTiles: total,
      estimatedBytes: total * TILE_BYTES_ESTIMATE,
      source: norm.source,
    };
  }

  async start(rawInput) {
    if (this.isBusy()) {
      return { ok: false, error: 'a download is already active', job: this._summary(this.currentJob) };
    }
    const norm = this.normalizeInput(rawInput);
    if (!norm.ok) return { ok: false, error: norm.error };
    const total = countTiles(norm);
    if (total === 0) return { ok: false, error: 'no tiles in selected area' };
    if (total > MAX_TILES_PER_JOB) {
      return { ok: false, error: `too many tiles (${total}); max ${MAX_TILES_PER_JOB}. Reduce radius or zoom range.` };
    }

    const jobId = `offline-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const iter = getIterator(norm);
    const iterArr = [...iter];

    const job = {
      jobId,
      state: STATE.QUEUED,
      source: norm.source,
      totalTiles: iterArr.length,
      processedTiles: 0,
      cachedHits: 0,
      downloadedTiles: 0,
      failedTiles: 0,
      skippedTiles: 0,
      downloadedBytes: 0,
      writtenBytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
      currentZoom: null,
      lastError: null,
      iter: iterArr,
      idx: 0,
      signal: { cancelled: false, onCancel: null },
    };
    this.currentJob = job;
    this._emit(job, STATE.QUEUED);

    // Fire-and-forget; progress comes via events.
    this._run(job).catch((err) => {
      job.state = STATE.FAILED;
      job.lastError = err && err.message;
      job.finishedAt = Date.now();
      this._emit(job, STATE.FAILED);
      if (this.currentJob === job) this.currentJob = null;
    });

    return {
      ok: true,
      jobId,
      totalTiles: job.totalTiles,
      source: job.source,
    };
  }

  cancel(jobId) {
    if (!this.currentJob) return { ok: false, error: 'no active job' };
    if (jobId && this.currentJob.jobId !== jobId) return { ok: false, error: 'unknown job' };
    if (this.currentJob.state === STATE.CANCELLING || this.currentJob.state === STATE.CANCELLED) {
      return { ok: true, state: this.currentJob.state };
    }
    this.currentJob.state = STATE.CANCELLING;
    this.currentJob.signal.cancelled = true;
    if (this.currentJob.signal.onCancel) {
      try { this.currentJob.signal.onCancel(); } catch (_) {}
    }
    this._emit(this.currentJob, STATE.CANCELLING);
    return { ok: true, state: STATE.CANCELLING };
  }

  async shutdown() {
    if (this.currentJob) this.cancel(this.currentJob.jobId);
  }

  _summary(job) {
    return {
      jobId: job.jobId,
      state: job.state,
      source: job.source,
      totalTiles: job.totalTiles,
      processedTiles: job.processedTiles,
      cachedHits: job.cachedHits,
      downloadedTiles: job.downloadedTiles,
      failedTiles: job.failedTiles,
      skippedTiles: job.skippedTiles,
      downloadedBytes: job.downloadedBytes,
      writtenBytes: job.writtenBytes,
      percent: job.totalTiles > 0 ? (job.processedTiles / job.totalTiles) * 100 : 0,
      elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
      etaMs: this._computeEta(job),
      currentZoom: job.currentZoom,
      lastError: job.lastError,
    };
  }

  _computeEta(job) {
    if (job.processedTiles < 5) return null;
    const elapsed = (job.finishedAt || Date.now()) - job.startedAt;
    const perTile = elapsed / job.processedTiles;
    const remaining = job.totalTiles - job.processedTiles;
    if (remaining <= 0) return 0;
    return Math.round(perTile * remaining);
  }

  _emit(job, stateOverride) {
    const state = stateOverride || job.state;
    const payload = this._summary(job);
    if (stateOverride && stateOverride !== job.state) payload.state = stateOverride;
    this.emit('progress', payload);
  }

  async _run(job) {
    job.state = STATE.RUNNING;
    this._emit(job, STATE.RUNNING);

    let lastEmit = 0;
    let sinceLastEmit = 0;

    for (; job.idx < job.iter.length; job.idx++) {
      if (job.signal.cancelled) {
        job.state = STATE.CANCELLED;
        job.finishedAt = Date.now();
        this._emit(job, STATE.CANCELLED);
        if (this.currentJob === job) this.currentJob = null;
        return;
      }
      const t = job.iter[job.idx];
      job.currentZoom = t.z;
      const url = tileUrl(job.source, t.z, t.x, t.y);
      let result;
      try {
        result = await this.fetcher.getTile(url, { signal: job.signal });
      } catch (err) {
        result = { error: err && err.message, cacheStatus: 'miss' };
      }

      if (job.signal.cancelled) {
        job.state = STATE.CANCELLED;
        job.finishedAt = Date.now();
        this._emit(job, STATE.CANCELLED);
        if (this.currentJob === job) this.currentJob = null;
        return;
      }

      job.processedTiles++;
      if (result && result.cacheStatus === 'disk') {
        job.cachedHits++;
      } else if (result && !result.error && result.dataUrl) {
        job.downloadedTiles++;
        if (typeof result.byteLength === 'number') {
          job.downloadedBytes += result.byteLength;
          job.writtenBytes += result.byteLength;
        }
      } else {
        job.failedTiles++;
        job.lastError = result && result.error ? result.error : 'unknown error';
      }
      sinceLastEmit++;

      const now = Date.now();
      if (
        job.processedTiles === job.totalTiles ||
        sinceLastEmit >= PROGRESS_TILE_STEP ||
        now - lastEmit >= PROGRESS_INTERVAL_MS
      ) {
        this._emit(job);
        lastEmit = now;
        sinceLastEmit = 0;
      }
    }

    job.state = STATE.COMPLETED;
    job.finishedAt = Date.now();
    this._emit(job, STATE.COMPLETED);
    if (this.currentJob === job) this.currentJob = null;
  }
}

module.exports = {
  OfflineTileDownloadManager,
  STATE,
  MAX_TILES_PER_JOB,
  MIN_RADIUS_KM,
  MAX_RADIUS_KM,
  DEFAULT_RADIUS_KM,
  DEFAULT_MIN_ZOOM,
  DEFAULT_MAX_ZOOM,
  TILE_BYTES_ESTIMATE,
};

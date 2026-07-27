// Mission Planner–style moving map for UIU Aerial Robotics GCP.
//
// What you get here:
//   * Slippy OSM / ArcGIS satellite tiles (and a custom URL source) cached on disk.
//   * Heading-up / North-up orientation toggle.
//   * Right-click context menu with "Set Home", "Add Waypoint", "Fly To", etc.
//   * Toggleable overlays (track, home, mission, wind, ADSB, geofence, ruler).
//   * HUD: vehicle / position / cursor blocks (driven from app.js).
//   * Bottom-right compass rose (driven from app.js).
//   * Ruler tool: click two map points to see bearing + distance.
//   * Smoothed drone position + heading interpolation between telemetry ticks.
//
// Backwards-compatible setters:
//   setHome, setPosition, setHeading, setMissionWaypoints, setOtherAircraft,
//   setGeofence, setFollow, setZoom, setTileSource, getCenter, getTileSource,
//   getViewBbox.

const MAX_TRACK = 4000;
const MAX_ZOOM = 19;
const MIN_ZOOM = 2;

// Mission Planner–style animation timing.
// Position/heading smoothing uses an exponential filter driven by RAF
// (capped at 220 ms via `MAX_SMOOTH_MS`) instead of fixed-step keyframes.
//
// Tuned for noisy GPS feeds: the marker should sit still when the drone
// is stationary (even with ±5m GPS wander), only move when there's a
// real heading/ground track change.
const POS_SMOOTH_TAU = 1.20;       // s — heavy smoothing kills GPS wander
const HEADING_SMOOTH_TAU = 0.30;   // s — heading feathers even sharp turns
// Follow-center tau stays tight so the map always tracks the (smoothed)
// drone position without drifting off.
const FOLLOW_SMOOTH_TAU = 0.40;    // s — keep the map glued to the drone
const MAX_SMOOTH_MS = 320;         // hard cap so a single gap doesn't drift forever
const MAX_SMOOTH_STEP = 1;         // — fraction of remaining delta per RAF step

// Minimum movement, in meters, before we accept a new track sample.
// Drops GPS wander so the track polyline doesn't radiate sub-meter noise.
const TRACK_MIN_MOVE_M = 1.5;

// Follow deadband (meters). New fixes closer than this from the current
// center are treated as noise and IGNORED — the map center stays put so
// the drone sits still on screen even with GPS wander. Mission Planner
// gates follow recentre on a similar distance threshold.
const FOLLOW_DEADBAND_M = 6.0;

// Heading deadband (degrees). Don't redraw the heading icon for sub-degree
// yaw jitter from the magnetometer.
const HEADING_DEADBAND_DEG = 0.6;

const MP = {
  bg: '#0b1a2e',
  panel: 'rgba(20, 24, 30, 0.85)',
  cyan: '#22d3ee',
  cyanDim: 'rgba(34, 211, 238, 0.35)',
  magenta: '#ec407a',
  yellow: '#fbbf24',
  green: '#22c55e',
  red: '#ef4444',
  text: '#e8edf2',
  textDim: '#8a94a3',
  trackHead: '#67e8f9',
  trackTail: 'rgba(34, 211, 238, 0.18)',
};

const EARTH_R = 6371008.8; // meters
const RAD = Math.PI / 180;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_R * c;
}

function bearing(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) / RAD + 360) % 360;
  return deg;
}

function fmtMeters(m) {
  if (!isFinite(m)) return '—';
  if (m < 1000) return `${m.toFixed(0)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function fmtBearing(deg) {
  if (deg == null || isNaN(deg)) return '—';
  return `${deg.toFixed(0).padStart(3, '0')}°`;
}

export class MapView {
  constructor(canvas, { tileSource = 'osm', api = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.api = api;

    // Telemetry state
    this.track = [];
    this.home = null;
    this.position = null;
    // Exponential-smoothed render position (what we actually paint).
    this._renderPos = null;
    this._posTarget = null;
    this._lastPosUpdate = 0;
    // Exponential-smoothed render heading.
    this._renderHeading = 0;
    this._headingTarget = 0;
    this._lastHeadingUpdate = 0;
    this.missionWaypoints = [];
    this.otherAircraft = [];
    this.geofence = [];

    // View state
    this.follow = true;
    this.zoom = 16;
    this.center = null;
    // Exponential-smoothed render center (used only when following).
    this._renderCenter = null;
    this._centerTarget = null;
    this.orientation = 'north'; // 'north' | 'up'
    this.layers = {
      track: true,
      home: true,
      mission: true,
      wind: false,
      adsb: true,
      geofence: true,
      cursorReadout: true,
      ruler: false,
    };

    // Tile + interaction state
    this.tileCache = new Map();
    this.tileSource = tileSource;
    this.customUrlTemplate = '';
    this.tilePixelSize = 256;

    this._drag = null;
    this._dragMoved = false;
    this._cursor = null; // {lat, lon}
    this._ruler = { start: null, end: null };
    this._ctxmenuCoords = null;

    this._setup();
    this._bindInteraction();
    this._rafLoop = this._rafLoop.bind(this);
    this._rafLoop();
  }

  _setup() {
    this._ratio = window.devicePixelRatio || 1;
    requestAnimationFrame(() => this._resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.canvas);
    }
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this._w && h === this._h && this.canvas.width === w * this._ratio) {
      this.draw();
      return;
    }
    this._w = w;
    this._h = h;
    this.canvas.width = w * this._ratio;
    this.canvas.height = h * this._ratio;
    this.ctx.setTransform(this._ratio, 0, 0, this._ratio, 0, 0);
    this.draw();
  }

  _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /**
   * Frame-rate-independent exponential smoothing.
   *   alpha = 1 - exp(-dt / tau)
   * `tau` is the time constant — larger = smoother but laggier.
   * Capped at MAX_SMOOTH_MS so a long pause (tab switch) doesn't lock
   * the marker in motion for seconds after returning.
   */
  _expAlpha(dtMs, tauSec) {
    const dt = Math.min(dtMs, MAX_SMOOTH_MS) / 1000;
    const a = 1 - Math.exp(-dt / tauSec);
    return Math.min(a, MAX_SMOOTH_STEP);
  }

  _rafLoop() {
    const now = performance.now();
    const last = this._lastFrameMs || now;
    const dtMs = Math.max(0, now - last);
    this._lastFrameMs = now;
    let needsRedraw = false;

    // Smooth the drone position toward the latest telemetry fix.
    if (this._renderPos && this._posTarget) {
      const a = this._expAlpha(dtMs, POS_SMOOTH_TAU);
      const dLat = this._posTarget.lat - this._renderPos.lat;
      const dLon = this._posTarget.lon - this._renderPos.lon;
      // Snap if delta is effectively zero so we don't redraw forever.
      if (Math.abs(dLat) > 1e-9 || Math.abs(dLon) > 1e-9) {
        this._renderPos = {
          lat: this._renderPos.lat + dLat * a,
          lon: this._renderPos.lon + dLon * a,
        };
        needsRedraw = true;
      } else if (Math.abs(this._renderPos.lat - this._posTarget.lat) > 0 ||
                 Math.abs(this._renderPos.lon - this._posTarget.lon) > 0) {
        this._renderPos = { lat: this._posTarget.lat, lon: this._posTarget.lon };
        needsRedraw = true;
      }
    }

    // Smooth heading using shortest-arc lerp.
    {
      const a = this._expAlpha(dtMs, HEADING_SMOOTH_TAU);
      let delta = this._headingTarget - this._renderHeading;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (Math.abs(delta) > 0.05) {
        this._renderHeading = (this._renderHeading + delta * a + 360) % 360;
        needsRedraw = true;
      } else if (this._renderHeading !== this._headingTarget) {
        this._renderHeading = this._headingTarget;
        needsRedraw = true;
      }
    }

    // Smooth the follow-center toward the rendered drone position.
    // Note: with the FOLLOW_DEADBAND_M gate in setPosition() this loop is
    // mostly a no-op when the drone is hovering — _centerTarget/_renderCenter
    // are only re-written when the raw fix drifts past the deadband. We
    // still keep the exp-blend here so any residual lag (or a manual
    // recentre via setCenter) eases in instead of snapping.
    if (this.follow && this._renderCenter && this._renderPos && this._centerTarget) {
      const a = this._expAlpha(dtMs, FOLLOW_SMOOTH_TAU);
      // Blend the *target* toward the rendered drone position lazily.
      const tLat = this._centerTarget.lat + (this._renderPos.lat - this._centerTarget.lat) * a;
      const tLon = this._centerTarget.lon + (this._renderPos.lon - this._centerTarget.lon) * a;
      if (Math.abs(tLat - this._centerTarget.lat) > 1e-9 || Math.abs(tLon - this._centerTarget.lon) > 1e-9) {
        this._centerTarget = { lat: tLat, lon: tLon };
      }
      // Snap _renderCenter toward the target; since setPosition() already
      // snapped it whenever the deadband was crossed, the only remaining
      // case is "target is shifted but render hasn't caught up" — which
      // is harmless because the marker is drawn at the screen centre
      // anyway in follow mode.
      // We deliberately don't touch `this.center` here — keeping it
      // pinned to the value written by setPosition() means the RAF tick
      // stays cheap when GPS is noisy.
    }

    if (needsRedraw) this.draw();
    this._rafHandle = requestAnimationFrame(this._rafLoop);
  }

  // -------- Setters --------
  setHome(home) {
    if (home && (home.lat || home.lon)) {
      this.home = { ...home };
      if (!this.center) {
        this.center = { lat: home.lat, lon: home.lon };
        this._renderCenter = { lat: home.lat, lon: home.lon };
        this._centerTarget = { lat: home.lat, lon: home.lon };
      }
    }
    this.draw();
    this._maybeRequestTiles(true);
  }
  setPosition(pos) {
    if (!pos) return;
    const isFirstFix = !this._renderPos || !this.position;
    if (isFirstFix) {
      // Snap directly to the first fix — no animation, no rubber-banding.
      this._renderPos = { lat: pos.lat, lon: pos.lon };
      this._posTarget = { lat: pos.lat, lon: pos.lon };
      // Snap the center to the drone so the very first frame paints the
      // marker at the screen center (no jump from world origin).
      this._renderCenter = { lat: pos.lat, lon: pos.lon };
      this._centerTarget = { lat: pos.lat, lon: pos.lon };
      this.center = { lat: pos.lat, lon: pos.lon };
      this._lastTileCellX = Math.floor(this._lon2tileX(pos.lon, this.zoom));
      this._lastTileCellY = Math.floor(this._lat2tileY(pos.lat, this.zoom));
      this._lastFrameMs = performance.now();
      this._lastTileKey = null;
      // Auto-engage follow on first fix so the user doesn't have to hit
      // the recenter button (Mission Planner default). The screen will
      // center on the drone and stay centered as it moves.
      this.follow = true;
    } else {
      // Just update the target — the RAF loop blends toward it.
      this._posTarget = { lat: pos.lat, lon: pos.lon };
    }
    this.position = pos;

    // Track polyline: drop sub-meter GPS wander so the path doesn't
    // radiate sub-meter noise into a giant spider when the drone is
    // stationary. Compare against the LAST ACCEPTED track point, not
    // against the previous frame.
    const lastTrk = this.track[this.track.length - 1];
    if (!lastTrk) {
      this.track.push({ lat: pos.lat, lon: pos.lon, alt: pos.alt_rel_m });
    } else {
      const d = this._trackDistanceMeters(lastTrk.lat, lastTrk.lon, pos.lat, pos.lon);
      if (d >= TRACK_MIN_MOVE_M) {
        this.track.push({ lat: pos.lat, lon: pos.lon, alt: pos.alt_rel_m });
        if (this.track.length > MAX_TRACK) this.track.shift();
      } else {
        // Within noise threshold: update the altitude on the last point
        // so the label stays current, but don't grow the polyline.
        lastTrk.alt = pos.alt_rel_m;
      }
    }

    // Follow-mode centre update with deadband. Only recentre the map when
    // the drone has actually moved past FOLLOW_DEADBAND_M — sub-deadband
    // GPS wander is noise that we deliberately ignore so the marker sits
    // still (Mission Planner behaviour). Past the deadband we snap to the
    // raw position so the drone stays glued to the screen centre while
    // its long-term drift is always zero.
    if (this.follow && !isFirstFix) {
      const cur = this._renderCenter || this.center;
      const dFromCenter = this._trackDistanceMeters(
        cur.lat, cur.lon, pos.lat, pos.lon
      );
      if (dFromCenter >= FOLLOW_DEADBAND_M) {
        // Outside the deadband: recentre. We snap the centre target to
        // the raw fix so the actual map tiles recentre quickly, but the
        // marker icon is still painted at the screen centre so there is
        // no visible jump — only the world scrolls underneath.
        this._centerTarget = { lat: pos.lat, lon: pos.lon };
        this._renderCenter = { lat: pos.lat, lon: pos.lon };
        this.center = { lat: pos.lat, lon: pos.lon };
        // Cell changed → re-fetch tiles on the next RAF tick.
        const tcx = Math.floor(this._lon2tileX(pos.lon, this.zoom));
        const tcy = Math.floor(this._lat2tileY(pos.lat, this.zoom));
        if (tcx !== this._lastTileCellX || tcy !== this._lastTileCellY) {
          this._lastTileCellX = tcx;
          this._lastTileCellY = tcy;
          this._lastTileKey = null;
          this._maybeRequestTiles();
        }
      }
      // Inside the deadband: do nothing. The marker is glued to the
      // screen centre and the tiles don't move, so GPS wander is
      // invisible. We update `_posTarget` (above) so the smoothed icon
      // shape (heading vector length etc.) can still react gently.
    }
    if (isFirstFix) {
      this._maybeRequestTiles();
      this.draw();
    }
  }

  /**
   * Cheap great-circle distance, in meters, for two lat/lon pairs. Used
   * to gate track polyline samples — only add a point if the drone has
   * actually moved >= TRACK_MIN_MOVE_M since the last accepted sample.
   */
  _trackDistanceMeters(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  setHeading(deg) {
    const next = ((deg || 0) + 360) % 360;
    const isFirst = !this._lastHeadingUpdate;
    if (isFirst) {
      // Snap — first-ever heading shouldn't spin in from 0.
      this._renderHeading = next;
      this._headingTarget = next;
      this._lastHeadingUpdate = performance.now();
    } else {
      // Normalized delta for shortest-arc interp.
      let delta = next - this._headingTarget;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      // Sub-deadband jitter suppression: tiny yaw noise from the
      // magnetometer shouldn't move the heading target at all. Only
      // accept the new heading if it differs by HEADING_DEADBAND_DEG
      // or more — keeps the arrow rock-steady when the drone is
      // hovering in place.
      if (Math.abs(delta) >= HEADING_DEADBAND_DEG) {
        this._headingTarget = (this._headingTarget + delta + 360) % 360;
      }
    }
    this.heading = next;
  }
  setMissionWaypoints(wps) {
    this.missionWaypoints = Array.isArray(wps) ? wps : [];
    this.draw();
  }
  setOtherAircraft(list) {
    this.otherAircraft = Array.isArray(list) ? list : [];
    this.draw();
  }
  setGeofence(polygon) {
    this.geofence = Array.isArray(polygon) ? polygon : [];
    this.draw();
  }
  setFollow(on) {
    this.follow = !!on;
    if (this.follow && this.position) {
      this._renderCenter = { lat: this.position.lat, lon: this.position.lon };
      this.center = { ...this._renderCenter };
      this._centerTarget = { lat: this._renderCenter.lat, lon: this._renderCenter.lon };
      this._lastTileCellX = Math.floor(this._lon2tileX(this.center.lon, this.zoom));
      this._lastTileCellY = Math.floor(this._lat2tileY(this.center.lat, this.zoom));
    }
  }

  /**
   * Public helper to relocate the map center and keep the smoothed
   * render-center in sync so the next RAF tick doesn't drift back to
   * the previous position. Use this instead of writing `mapView.center`
   * directly from outside the class.
   */
  setCenter(lat, lon, { keepFollow = false } = {}) {
    if (!this.center) this.center = { lat, lon };
    else { this.center.lat = lat; this.center.lon = lon; }
    this._renderCenter = { lat, lon };
    this._centerTarget = { lat, lon };
    this._lastTileKey = null;
    if (!keepFollow) this.follow = false;
  }
  setZoom(z) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    // Different zoom = different tiles; allow a refetch.
    this._failedTiles = null;
    this._lastTileKey = null;
    this.draw();
    this._maybeRequestTiles();
    this._notifyZoom();
  }
  setTileSource(src) {
    this.tileSource = src || 'osm';
    this.tileCache.clear();
    this._failedTiles = null;
    this._lastTileKey = null;
    this.draw();
    this._maybeRequestTiles(true);
  }
  setCustomUrlTemplate(tpl) {
    this.customUrlTemplate = tpl || '';
    if (this.tileSource === 'custom') {
      this.tileCache.clear();
      this._failedTiles = null;
      this._lastTileKey = null;
      this.draw();
      this._maybeRequestTiles(true);
    }
  }
  setLayer(name, on) {
    if (name in this.layers) {
      this.layers[name] = !!on;
      this.draw();
    }
  }
  setOrientation(o) {
    this.orientation = o === 'up' ? 'up' : 'north';
    this.draw();
  }

  getCenter() { return this.center ? { lat: this.center.lat, lon: this.center.lon } : null; }
  getTileSource() { return this.tileSource; }
  getTrack() { return this.track.slice(); }
  setTrack(track) { this.track = Array.isArray(track) ? track.slice() : []; this.draw(); }
  getRuler() { return { ...this._ruler }; }

  getViewBbox() {
    if (!this.center) return null;
    const r = this._visibleTileRange();
    const minLon = this._tileX2lon(r.x0, this.zoom);
    const maxLon = this._tileX2lon(r.x1 + 1, this.zoom);
    const maxLat = this._tileY2lat(r.y0, this.zoom);
    const minLat = this._tileY2lat(r.y1 + 1, this.zoom);
    return { minLat, maxLat, minLon, maxLon };
  }

  // -------- Tile math --------
  _lon2tileX(lon, zoom) { return ((lon + 180) / 360) * Math.pow(2, zoom); }
  _lat2tileY(lat, zoom) {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom);
  }
  _tileX2lon(x, zoom) { return (x / Math.pow(2, zoom)) * 360 - 180; }
  _tileY2lat(y, zoom) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  _visibleTileRange() {
    const cx = this._lon2tileX(this.center.lon, this.zoom);
    const cy = this._lat2tileY(this.center.lat, this.zoom);
    const tilesAcross = this._w / this.tilePixelSize + 4;
    const tilesDown = this._h / this.tilePixelSize + 4;
    const halfW = Math.ceil(tilesAcross / 2);
    const halfH = Math.ceil(tilesDown / 2);
    return { x0: Math.floor(cx - halfW), x1: Math.floor(cx + halfW), y0: Math.floor(cy - halfH), y1: Math.floor(cy + halfH), cx, cy };
  }

  async _maybeRequestTiles(force = false) {
    if (!this.api || !this.api.getMapTiles) return;
    if (!this.center) return;
    const r = this._visibleTileRange();
    const key = `${this.tileSource}|${this.zoom}|${r.x0}|${r.y0}|${r.x1}|${r.y1}|${this.customUrlTemplate}`;
    if (!force && key === this._lastTileKey) return;
    this._lastTileKey = key;

    // Build the visible tile list, but skip ones we already have in cache.
    const urls = [];
    const wanted = []; // {x, y, url}
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        const url = this._tileUrl(x, y, this.zoom);
        wanted.push({ x, y, url });
        if (!this.tileCache.has(url) && !this._failedTiles?.has(url)) {
          urls.push(url);
        }
      }
    }
    if (urls.length === 0 && !force) return;

    this.draw();
    try {
      const tiles = await this.api.getMapTiles(urls);
      if (!tiles || !tiles.length) return;
      let loaded = 0;
      tiles.forEach((t) => {
        if (!t || !t.url || !t.dataUrl) {
          // Mark transient failures so we don't hammer the network;
          // they get retried after the next pan/zoom.
          if (t && t.url) {
            this._failedTiles = this._failedTiles || new Set();
            this._failedTiles.add(t.url);
          }
          return;
        }
        const img = new Image();
        img.onload = () => {
          this.tileCache.set(t.url, img);
          if (this._failedTiles) this._failedTiles.delete(t.url);
          loaded++;
          this.draw();
        };
        img.onerror = () => {
          if (this._failedTiles) this._failedTiles.add(t.url);
        };
        img.src = t.dataUrl;
      });
      this.draw();
    } catch (_) {}
  }

  _tileUrl(x, y, z) {
    if (this.tileSource === 'custom' && this.customUrlTemplate) {
      const tpl = this.customUrlTemplate
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y)
        .replace('{y_inv}', (Math.pow(2, z) - 1 - y));
      return `custom://${tpl}`;
    }
    if (this.tileSource === 'satellite') return `arcgis://sat/${z}/${y}/${x}`;
    return `osm://${z}/${x}/${y}`;
  }

  // -------- Projection (screen pixels → world lon/lat) --------
  _project(lon, lat) {
    const r = this._visibleTileRange();
    const tileX = this._lon2tileX(lon, this.zoom);
    const tileY = this._lat2tileY(lat, this.zoom);
    const px = (tileX - r.cx) * this.tilePixelSize + this._w / 2;
    const py = (tileY - r.cy) * this.tilePixelSize + this._h / 2;
    return { x: px, y: py };
  }
  _unproject(px, py) {
    const r = this._visibleTileRange();
    const tileX = (px - this._w / 2) / this.tilePixelSize + r.cx;
    const tileY = (py - this._h / 2) / this.tilePixelSize + r.cy;
    const lon = this._tileX2lon(tileX, this.zoom);
    const lat = this._tileY2lat(tileY, this.zoom);
    return { lon, lat };
  }

  // Screen coord → world coord, accounting for the heading-up rotation that
  // we apply around the screen center.
  _screenToLonLat(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    if (this.orientation === 'up') {
      const rot = -((this._renderHeading ?? this.heading) || 0);
      const cx = this._w / 2;
      const cy = this._h / 2;
      const dx = x - cx;
      const dy = y - cy;
      const rad = rot * Math.PI / 180;
      const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
      x = cx + rx;
      y = cy + ry;
    }
    return this._unproject(x, y);
  }

  _notifyZoom() {
    const el = document.getElementById('map-zoom-label');
    if (el) el.textContent = String(this.zoom);
    const ol = document.getElementById('map-orientation-label');
    if (ol) ol.textContent = this.orientation === 'up' ? 'Track Up' : 'North Up';
  }

  // -------- Drawing --------
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this._w;
    const h = this._h;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = MP.bg;
    ctx.fillRect(0, 0, w, h);
    // Crisp vector overlays (default for paths) — high-quality scaling for
    // tile raster work is set inside _drawTiles().
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (!this.center && !this.position && !this.home) {
      this._drawEmpty(ctx, w, h);
      this._drawScaleBar(ctx, w, h);
      return;
    }

    if (!this.center) {
      this.center = (this.position && { lat: this.position.lat, lon: this.position.lon }) ||
        (this.home && { lat: this.home.lat, lon: this.home.lon });
    }

    ctx.save();
    if (this.orientation === 'up') {
      // Rotate around the screen center so the drone's heading points up.
      const rot = -((this._renderHeading ?? this.heading) || 0);
      ctx.translate(this._w / 2, this._h / 2);
      ctx.rotate(rot * Math.PI / 180);
      ctx.translate(-this._w / 2, -this._h / 2);
    }

    const tiles = this._visibleTileRange();
    this._drawTiles(ctx, tiles);
    this._drawGrid(ctx, w, h, tiles);

    if (this.layers.geofence && this.geofence.length > 1) this._drawGeofence(ctx);
    if (this.layers.home && this.home && (this.home.lat || this.home.lon)) this._drawHome(ctx);
    if (this.layers.mission && this.missionWaypoints.length > 0) this._drawMission(ctx);
    if (this.layers.track && this.track.length > 1) this._drawTrack(ctx);
    if (this.layers.adsb) this.otherAircraft.forEach((a) => this._drawAircraft(ctx, a));
    if (this.position) this._drawDrone(ctx);
    if (this.layers.ruler) this._drawRuler(ctx);

    ctx.restore();

    // Always-unrotated chrome
    this._drawScaleBar(ctx, w, h);
    this._drawStatusHud(ctx, w, h);
  }

  _drawTiles(ctx, r) {
    // High-quality, sub-pixel-snapped tile rendering. We use
    // crisp-edges when scaling 256px tiles and trilinear-style smoothing
    // when between zoom levels. Snapping to integer px origins prevents
    // shimmering at high DPR.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const ps = this.tilePixelSize;
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        const url = this._tileUrl(x, y, this.zoom);
        const img = this.tileCache.get(url);
        // Round to integer pixels — anti-shimmer, matches tile grid.
        const px = Math.round((x - r.cx) * ps + this._w / 2);
        const py = Math.round((y - r.cy) * ps + this._h / 2);
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, px, py, ps, ps);
        } else {
          // Tile slot — darker fill, faint border so gaps are visible
          // (not muddy). A subtle crosshatch hints "loading".
          ctx.fillStyle = '#0a1626';
          ctx.fillRect(px, py, ps, ps);
          ctx.strokeStyle = 'rgba(34, 211, 238, 0.06)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, ps - 1, ps - 1);
          // Diagnostic: number the slot so we can see which tiles loaded.
          if (this._drawTileDiag) {
            ctx.font = '10px JetBrains Mono';
            ctx.fillStyle = 'rgba(138, 148, 163, 0.55)';
            ctx.fillText(`${this.zoom}/${x}/${y}`, px + 6, py + 14);
          }
        }
      }
    }
  }

  _drawGrid(ctx, w, h, r) {
    ctx.save();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.10)';
    ctx.lineWidth = 1;
    const gridPx = 80;
    const offsetX = (this._w / 2) - r.cx * this.tilePixelSize;
    const offsetY = (this._h / 2) - r.cy * this.tilePixelSize;
    // Major + minor grid: 80px minor, 320px major.
    for (let x = (offsetX % gridPx); x < w; x += gridPx) {
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
    }
    for (let y = (offsetY % gridPx); y < h; y += gridPx) {
      ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
    }
    // Cross-hair through screen center (the drone).
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.32)';
    ctx.lineWidth = 1;
    const cx = Math.round(this._w / 2) + 0.5;
    const cy = Math.round(this._h / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.restore();
  }

  _drawHome(ctx) {
    const { x, y } = this._project(this.home.lon, this.home.lat);
    // Outer ring
    ctx.fillStyle = 'rgba(96, 165, 250, 0.12)';
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
    // Inner dot
    ctx.fillStyle = '#60a5fa';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    // Flag pole
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 12, y - 14); ctx.stroke();
    // Flag
    ctx.fillStyle = '#60a5fa';
    ctx.beginPath();
    ctx.moveTo(x + 12, y - 14);
    ctx.lineTo(x + 24, y - 10);
    ctx.lineTo(x + 12, y - 6);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.fillStyle = '#dbeafe';
    ctx.fillText('HOME', x + 12, y + 4);
  }

  _drawTrack(ctx) {
    if (!this.track.length) return;
    const n = this.track.length;
    if (n < 2) return;
    // Build the polyline once. Two passes: a wider, semi-transparent halo
    // underneath, then a crisp bright stroke on top — Mission Planner look.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const p = this.track[i];
      const proj = this._project(p.lon, p.lat);
      if (!started) { ctx.moveTo(proj.x, proj.y); started = true; }
      else ctx.lineTo(proj.x, proj.y);
    }
    // Halo
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
    ctx.lineWidth = 4;
    ctx.stroke();
    // Crisp line
    ctx.strokeStyle = MP.cyan;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }

  _drawMission(ctx) {
    if (this.missionWaypoints.length < 1) return;
    // Polyline
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    this.missionWaypoints.forEach((wp, i) => {
      const { x, y } = this._project(wp.lon, wp.lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    this.missionWaypoints.forEach((wp, i) => {
      const { x, y } = this._project(wp.lon, wp.lat);
      const active = wp.index !== undefined ? wp.index : -1;
      const isCurrent = active === i;
      const fill = isCurrent ? MP.magenta : MP.green;
      const flagAccent = isCurrent ? '#f9a8d4' : '#86efac';

      // Flag pole
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 8, y - 18); ctx.stroke();
      // Flag triangle
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x + 8, y - 18);
      ctx.lineTo(x + 20, y - 13);
      ctx.lineTo(x + 8, y - 9);
      ctx.closePath();
      ctx.fill();
      // Base dot
      ctx.fillStyle = flagAccent;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      // Label
      ctx.font = 'bold 10px JetBrains Mono';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(`WP${i + 1}`, x + 10, y - 4);
      if (wp.alt !== undefined) {
        ctx.fillStyle = 'rgba(220, 230, 240, 0.85)';
        ctx.font = '9px JetBrains Mono';
        ctx.fillText(`${Math.round(wp.alt)}m`, x + 10, y + 6);
      }
    });
  }

  _drawGeofence(ctx) {
    if (this.geofence.length < 3) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
    ctx.beginPath();
    this.geofence.forEach((p, i) => {
      const { x, y } = this._project(p[1], p[0]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.07)';
    ctx.fill();
  }

  _drawDrone(ctx) {
    const pos = this._renderPos || this.position;
    const heading = this._renderHeading ?? this.heading;
    if (!pos) return;
    // When following the drone, always draw it at the screen center —
    // Mission Planner behavior. We still animate the heading and the
    // accuracy ring via the smoothed `_renderPos`.
    let x, y;
    if (this.follow) {
      x = this._w / 2;
      y = this._h / 2;
    } else {
      const proj = this._project(pos.lon, pos.lat);
      x = proj.x;
      y = proj.y;
    }
    const headingRad = ((heading || 0) * Math.PI) / 180;
    // Heading vector (yellow, longer than before)
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(headingRad) * 28, y - Math.cos(headingRad) * 28);
    ctx.stroke();
    // Accuracy ring
    const acc = Math.max(8, Math.min(60, this.position.accuracy_m || 0));
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
    ctx.beginPath(); ctx.arc(x, y, acc, 0, Math.PI * 2); ctx.stroke();
    // Yellow triangular arrow (Mission Planner's quad-style arrow)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(headingRad);
    ctx.fillStyle = MP.yellow;
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(6, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Inner accent
    ctx.fillStyle = '#fde68a';
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Label
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.fillStyle = '#fde68a';
    ctx.fillText('UAV', x + 10, y + 4);
    if (this.position.alt_rel_m !== undefined) {
      ctx.fillStyle = 'rgba(220, 230, 240, 0.85)';
      ctx.font = '9px JetBrains Mono';
      ctx.fillText(`${Math.round(this.position.alt_rel_m)}m`, x + 10, y + 16);
    }
  }

  _drawAircraft(ctx, a) {
    const { x, y } = this._project(a.lon, a.lat);
    const headingRad = ((a.heading || 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(headingRad);
    ctx.fillStyle = a.friendly ? MP.yellow : '#f97316';
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(2, -2);
    ctx.lineTo(6, 0); ctx.lineTo(2, 1);
    ctx.lineTo(2, 4); ctx.lineTo(-2, 4); ctx.lineTo(-2, 1);
    ctx.lineTo(-6, 0); ctx.lineTo(-2, -2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = '#fde68a';
    const label = a.callsign || (a.type === 'adsb' ? `ADSB ${a.icao}` : 'OTHER');
    ctx.fillText(label, x + 10, y - 4);
    ctx.fillStyle = 'rgba(220, 230, 240, 0.85)';
    const altStr = a.alt !== undefined ? `${Math.round(a.alt)}m` : '';
    const spdStr = a.speed !== undefined ? `${Math.round(a.speed)}m/s` : '';
    ctx.fillText([altStr, spdStr].filter(Boolean).join(' · '), x + 10, y + 8);
  }

  _drawRuler(ctx) {
    const { start, end } = this._ruler;
    if (!start) return;
    const sp = this._project(start.lon, start.lat);
    ctx.fillStyle = MP.magenta;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2); ctx.fill();
    if (!end) return;
    const ep = this._project(end.lon, end.lat);
    ctx.strokeStyle = MP.magenta;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(ep.x, ep.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(ep.x, ep.y, 4, 0, Math.PI * 2); ctx.fill();
  }

  _drawEmpty(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(w, h) / 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(248, 250, 252, 0.85)';
    ctx.font = 'bold 18px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - Math.min(w, h) / 3 - 12);
    ctx.fillText('S', cx, cy + Math.min(w, h) / 3 + 12);
    ctx.fillText('E', cx + Math.min(w, h) / 3 + 12, cy);
    ctx.fillText('W', cx - Math.min(w, h) / 3 - 12, cy);
    ctx.fillStyle = 'rgba(220, 230, 240, 0.85)';
    ctx.font = '13px Inter';
    ctx.fillText('Awaiting GPS fix…', cx, cy + 4);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  _drawScaleBar(ctx, w, h) {
    if (!this.center) return;
    const metersPerPixel = 156543.03 * Math.cos((this.center.lat || 0) * Math.PI / 180) / Math.pow(2, this.zoom);
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let chosen = candidates[candidates.length - 1];
    for (const c of candidates) {
      if ((c / metersPerPixel) <= 120) { chosen = c; break; }
    }
    const pxLen = chosen / metersPerPixel;
    const x0 = 12;
    const y0 = h - 22;
    ctx.fillStyle = 'rgba(248, 250, 252, 0.85)';
    ctx.fillRect(x0, y0, pxLen, 3);
    ctx.font = '10px JetBrains Mono';
    ctx.fillText(chosen >= 1000 ? `${(chosen / 1000).toFixed(1)} km` : `${chosen} m`, x0, y0 - 4);
  }

  _drawStatusHud(ctx, w, h) {
    // Top-left status: follow/centered indicator
    ctx.save();
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.fillStyle = this.follow ? '#22d3ee' : 'rgba(220, 230, 240, 0.75)';
    ctx.fillText(this.follow ? '● FOLLOW' : '○ FREE', 12, 14);
    // Top-right text
    const lines = [];
    lines.push(`Z${this.zoom}`);
    lines.push(this.orientation === 'up' ? 'TRACK UP' : 'NORTH UP');
    lines.push(`WP ${this.missionWaypoints.length}`);
    if (this.otherAircraft.length) lines.push(`ADSB ${this.otherAircraft.length}`);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(220, 230, 240, 0.85)';
    lines.forEach((l, i) => ctx.fillText(l, w - 12, 14 + i * 12));
    ctx.textAlign = 'start';
    ctx.restore();
  }

  // -------- Interaction --------
  _bindInteraction() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    window.addEventListener('resize', () => this._resize());

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dz = e.deltaY < 0 ? 1 : -1;
      this.setZoom(this.zoom + dz);
    }, { passive: false });

    let last = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return; // right-click handled separately
      last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      this._dragMoved = false;
      this.follow = false;
      // Anchor the smoothed-center so the next RAF tick doesn't drift.
      if (this.center) {
        this._renderCenter = { lat: this.center.lat, lon: this.center.lon };
        this._centerTarget = { ...this._renderCenter };
      }
    });

    c.addEventListener('pointermove', (e) => {
      // Update cursor lat/lon for the HUD readout
      const ll = this._screenToLonLat(e.clientX, e.clientY);
      this._cursor = ll;
      this._updateCursorHud();

      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this._dragMoved = true;
      // Pan in pixels — apply inverse heading rotation if in track-up mode so
      // dragging feels natural (north on the screen stays in the rotated frame).
      const metersPerPixel = 156543.03 * Math.cos((this.center.lat || 0) * Math.PI / 180) / Math.pow(2, this.zoom);
      const dLat = -(dy * metersPerPixel) / 111111;
      const dLon = -(dx * metersPerPixel) / (111111 * Math.cos((this.center.lat || 0) * Math.PI / 180));
      if (this.orientation === 'up') {
        const rot = -((this._renderHeading ?? this.heading) || 0) * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const rLat = dLat * cos - dLon * sin;
        const rLon = dLat * sin + dLon * cos;
        this.center = { lat: this.center.lat + rLat, lon: this.center.lon + rLon };
      } else {
        this.center = { lat: this.center.lat + dLat, lon: this.center.lon + dLon };
      }
      // Keep the smoothed center in sync with the manual pan so a follow
      // re-enable doesn't snap the view back to the drone.
      this._renderCenter = { lat: this.center.lat, lon: this.center.lon };
      this._centerTarget = { ...this._renderCenter };
      // Manual pans invalidate the cached tile key so we refetch on-grid.
      this._lastTileKey = null;
      this.draw();
      this._maybeRequestTiles();
    });

    const endDrag = () => { last = null; };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', (e) => { endDrag(); });

    c.addEventListener('dblclick', (e) => {
      if (this.position) {
        this.setCenter(this.position.lat, this.position.lon, { keepFollow: true });
      }
      this.follow = true;
      this.draw();
    });

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ll = this._screenToLonLat(e.clientX, e.clientY);
      this._ctxmenuCoords = ll;
      const menu = document.getElementById('map-ctxmenu');
      if (!menu) return;
      const rect = this.canvas.getBoundingClientRect();
      menu.style.left = `${e.clientX - rect.left}px`;
      menu.style.top = `${e.clientY - rect.top}px`;
      menu.hidden = false;
    });

    c.addEventListener('click', (e) => {
      if (this._dragMoved) { this._dragMoved = false; return; }
      if (this.layers.ruler) {
        const ll = this._screenToLonLat(e.clientX, e.clientY);
        if (!this._ruler.start) this._ruler.start = ll;
        else if (!this._ruler.end) this._ruler.end = ll;
        else { this._ruler.start = ll; this._ruler.end = null; }
        this._updateRulerHud();
        this.draw();
      }
    });
  }

  _updateCursorHud() {
    if (!this.layers.cursorReadout) return;
    const latEl = document.getElementById('hud-cursor-lat');
    const lonEl = document.getElementById('hud-cursor-lon');
    const dEl = document.getElementById('hud-cursor-dist');
    const bEl = document.getElementById('hud-cursor-bear');
    if (!latEl || !lonEl || !this._cursor) return;
    latEl.textContent = this._cursor.lat.toFixed(6) + '°';
    lonEl.textContent = this._cursor.lon.toFixed(6) + '°';
    if (this.position) {
      const d = haversine(this.position.lat, this.position.lon, this._cursor.lat, this._cursor.lon);
      const b = bearing(this.position.lat, this.position.lon, this._cursor.lat, this._cursor.lon);
      dEl.textContent = fmtMeters(d);
      bEl.textContent = fmtBearing(b);
    } else {
      dEl.textContent = '—';
      bEl.textContent = '—';
    }
  }

  _updateRulerHud() {
    const wrap = document.getElementById('mp-ruler-readout');
    const dEl = document.getElementById('mp-ruler-dist');
    const bEl = document.getElementById('mp-ruler-bear');
    if (!wrap || !dEl) return;
    const { start, end } = this._ruler;
    if (!start) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (!end) {
      dEl.textContent = 'click second point…';
      bEl.textContent = '';
      return;
    }
    const d = haversine(start.lat, start.lon, end.lat, end.lon);
    const b = bearing(start.lat, start.lon, end.lat, end.lon);
    dEl.textContent = fmtMeters(d);
    bEl.textContent = fmtBearing(b);
  }

  // External context menu dispatcher (called by app.js button clicks).
  hideContextMenu() {
    const m = document.getElementById('map-ctxmenu');
    if (m) m.hidden = true;
    this._ctxmenuCoords = null;
  }
  getContextMenuCoords() { return this._ctxmenuCoords ? { ...this._ctxmenuCoords } : null; }

  clearRuler() {
    this._ruler = { start: null, end: null };
    this._updateRulerHud();
    this.draw();
  }

  addWaypointAtCursor() {
    if (!this._ctxmenuCoords) return null;
    const wp = {
      lat: this._ctxmenuCoords.lat,
      lon: this._ctxmenuCoords.lon,
      alt: this.position?.alt_rel_m || 30,
      command: 16,
    };
    this.missionWaypoints = [...this.missionWaypoints, wp];
    this.draw();
    return wp;
  }

  setHomeAtCursor() {
    if (!this._ctxmenuCoords) return null;
    const h = { lat: this._ctxmenuCoords.lat, lon: this._ctxmenuCoords.lon };
    this.setHome(h);
    return h;
  }
}
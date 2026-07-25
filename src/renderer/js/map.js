// Real-time moving map. Mirrors the ArduPilot GCS view:
//  * Optional slippy map tiles (OpenStreetMap by default; configurable to
//    Mapbox-style satellite via url_template) loaded around the current
//    position. Falls back to a vector grid when offline.
//  * Home marker + scaled geofence.
//  * Drone track (rolling tail).
//  * Plane icon rotated by heading, with a heading vector.
//  * Mission waypoints (clickable) + active leg highlight.
//  * Other aircraft (ADSB / simulated) with bearing + altitude tags.
//  * Pan / zoom via mouse drag + wheel. Re-centers on "follow" toggle.
//  * Live scale bar + coordinates HUD.
//
// Tile fetching happens in the main process (TileFetcher.js) which avoids
// CORS issues and keeps the renderer offline-capable.

const MAX_TRACK = 1200; // samples
const MAX_ZOOM = 19;
const MIN_ZOOM = 2;

export class MapView {
  constructor(canvas, { tileSource = 'osm', api = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.track = [];
    this.home = null;
    this.position = null;
    // Smoothed render position: the *displayed* position is interpolated
    // between the last telemetry update and a moving target so the map
    // updates smoothly every frame instead of jumping at 10 Hz.
    this._renderPos = null; // {lat, lon}
    this._posTarget = null; // {lat, lon}
    this._posFrom = null;   // {lat, lon}
    this._posAnimStarted = 0; // ms
    this._posAnimDuration = 120; // ms interpolation window
    this._lastPosChangeMs = 0;
    this.heading = 0;
    this._renderHeading = 0;
    this._headingFrom = 0;
    this._headingTarget = 0;
    this._headingAnimStarted = 0;
    this.missionWaypoints = []; // [{lat, lon, alt, command, name}]
    this.otherAircraft = []; // [{lat, lon, alt, heading, callsign, speed, type}]
    this.geofence = []; // polygon [[lat, lon], ...]
    this.follow = true;
    this.zoom = 16;
    this.center = null; // {lat, lon}
    // Smoothed center for follow mode (so the map keeps recentering every
    // frame as the drone moves, instead of freezing between telemetry ticks).
    this._renderCenter = null;
    this._centerTarget = null;
    this.tileCache = new Map();
    this._setup();
    this.api = api;
    this.tileSource = tileSource;
    this.tilePixelSize = 256;
    this._drag = null;
    this._bindInteraction();
    if (api && api.getMapTiles) {
      // Refresh visible tiles whenever the view changes.
      this._lastTileKey = '';
    }
    // Always-on frame loop — drives smooth real-time rendering regardless
    // of how often telemetry packets arrive.
    this._rafHandle = null;
    this._rafLoop = this._rafLoop.bind(this);
    this._rafLoop();
  }
  _setup() {
    this._ratio = window.devicePixelRatio || 1;
    // Defer the first size until after layout has settled. getBoundingClientRect
    // returns 0×0 for canvases that haven't been laid out yet, and at
    // construction time the panel may still be hidden by grid auto-rows.
    requestAnimationFrame(() => this._resize());
    // Re-fit whenever the layout changes (single-screen dashboard is fluid).
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

  _rafLoop() {
    const now = performance.now();
    let needsRedraw = false;

    // ---- Interpolate drone position ----
    if (this._posFrom && this._posTarget && this._renderPos) {
      const t = Math.min(1, (now - this._posAnimStarted) / this._posAnimDuration);
      if (t < 1) {
        const e = this._easeOutCubic(t);
        this._renderPos = {
          lat: this._posFrom.lat + (this._posTarget.lat - this._posFrom.lat) * e,
          lon: this._posFrom.lon + (this._posTarget.lon - this._posFrom.lon) * e,
        };
        needsRedraw = true;
      }
    }

    // ---- Interpolate heading ----
    if (this._headingFrom !== undefined && this._headingTarget !== undefined) {
      const t = Math.min(1, (now - this._headingAnimStarted) / this._posAnimDuration);
      if (t < 1) {
        const e = this._easeOutCubic(t);
        let delta = this._headingTarget - this._headingFrom;
        // Normalize delta into [-180, +180]
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        this._renderHeading = (this._headingFrom + delta * e + 360) % 360;
        needsRedraw = true;
      }
    }

    // ---- Interpolate map center (follow mode) ----
    if (this.follow && this._renderCenter && this._centerTarget && this._posTarget) {
      const t = Math.min(1, (now - this._posAnimStarted) / this._posAnimDuration);
      if (t < 1) {
        const e = this._easeOutCubic(t);
        const newCenter = {
          lat: this._renderCenter.lat + (this._centerTarget.lat - this._renderCenter.lat) * e,
          lon: this._renderCenter.lon + (this._centerTarget.lon - this._renderCenter.lon) * e,
        };
        // Only mark dirty if the center actually moved this frame.
        if (newCenter.lat !== this.center?.lat || newCenter.lon !== this.center?.lon) {
          this.center = newCenter;
          needsRedraw = true;
          // Trigger tile fetch when the center crosses into a new tile cell —
          // this is what makes the map look real-time as the drone moves.
          const cx = this._lon2tileX(this.center.lon, this.zoom);
          const cy = this._lat2tileY(this.center.lat, this.zoom);
          const tcx = Math.floor(cx);
          const tcy = Math.floor(cy);
          if (tcx !== this._lastTileCellX || tcy !== this._lastTileCellY) {
            this._lastTileCellX = tcx;
            this._lastTileCellY = tcy;
            // Defer the actual fetch so it doesn't block the rAF draw.
            this._maybeRequestTiles();
          }
        }
      }
    }

    if (needsRedraw) this.draw();

    this._rafHandle = requestAnimationFrame(this._rafLoop);
  }

  // ---- Setters (called from telemetry renderer) ----
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
    this._maybeRequestTiles(true);  // force refresh after home updates
  }
  setPosition(pos) {
    if (!pos) return;
    // First valid position: snap everything to it without animation so the
    // map doesn't slide in from (0,0).
    const isFirstFix = !this._renderPos || !this.position;
    if (isFirstFix) {
      this._renderPos = { lat: pos.lat, lon: pos.lon };
      this._posFrom = { lat: pos.lat, lon: pos.lon };
      this._posTarget = { lat: pos.lat, lon: pos.lon };
      this._renderCenter = { lat: pos.lat, lon: pos.lon };
      this._centerTarget = { lat: pos.lat, lon: pos.lon };
      // Seed the tile-cell latch so the rAF loop's "did we cross a tile"
      // check fires the moment the center moves.
      this._lastTileCellX = Math.floor(this._lon2tileX(pos.lon, this.zoom));
      this._lastTileCellY = Math.floor(this._lat2tileY(pos.lat, this.zoom));
    } else {
      // Subsequent positions: kick off a short interpolation from the
      // *previous rendered* position to the new telemetry target. This is
      // what makes the map feel like Mission Planner — the drone glides
      // smoothly between packet updates.
      const fromLat = this._renderPos.lat;
      const fromLon = this._renderPos.lon;
      // Only animate if the drone actually moved; otherwise leave the
      // existing interpolation state alone (avoids 60 fps redraws with no
      // visible change).
      if (Math.abs(fromLat - pos.lat) > 1e-9 || Math.abs(fromLon - pos.lon) > 1e-9) {
        this._posFrom = { lat: fromLat, lon: fromLon };
        this._posTarget = { lat: pos.lat, lon: pos.lon };
        this._posAnimStarted = performance.now();
        this._centerTarget = { lat: pos.lat, lon: pos.lon };
      }
    }
    this.position = pos;
    if (this.follow && this._renderCenter) {
      // Keep center in sync immediately too (the rAF loop will smooth it).
      this.center = { lat: this._renderCenter.lat, lon: this._renderCenter.lon };
    }
    if (this.track.length > 0) {
      const last = this.track[this.track.length - 1];
      if (Math.abs(last.lat - pos.lat) > 1e-7 || Math.abs(last.lon - pos.lon) > 1e-7) {
        this.track.push({ lat: pos.lat, lon: pos.lon });
        if (this.track.length > MAX_TRACK) this.track.shift();
      }
    } else {
      this.track.push({ lat: pos.lat, lon: pos.lon });
    }
    this._lastPosChangeMs = Date.now();
    // Always re-fetch tiles once we have a real position; the rAF loop
    // will handle subsequent per-frame fetches when the center crosses
    // tile-cell boundaries.
    this._maybeRequestTiles();
    // First fix: the rAF loop won't trigger a draw because the snap has
    // no from→target motion, so paint the frame explicitly so the drone
    // appears on the map immediately.
    if (isFirstFix) this.draw();
  }
  setHeading(deg) {
    const next = deg || 0;
    if (this._renderHeading === undefined || this._headingFrom === undefined) {
      this._renderHeading = next;
      this._headingFrom = next;
      this._headingTarget = next;
      this._headingAnimStarted = 0;
    } else {
      // Pick the shorter arc so we never spin the long way around 359°→1°.
      const from = this._renderHeading;
      const to = next;
      const delta = ((to - from) + 540) % 360 - 180;
      if (Math.abs(delta) > 0.5) {
        this._headingFrom = from;
        this._headingTarget = (from + delta + 360) % 360;
        this._headingAnimStarted = performance.now();
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
      // Re-sync so the next frame centers on the drone instantly.
      this._renderCenter = { lat: this.position.lat, lon: this.position.lon };
      this.center = { ...this._renderCenter };
      this._centerTarget = { ...this._renderCenter };
    }
  }
  setZoom(z) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    this.draw();
    this._maybeRequestTiles();
  }
  setTileSource(src) {
    this.tileSource = src || 'osm';
    this.tileCache.clear();
    this.draw();
    this._maybeRequestTiles();
  }

  // ---- Tile helpers ----
  _lon2tileX(lon, zoom) { return ((lon + 180) / 360) * Math.pow(2, zoom); }
  _lat2tileY(lat, zoom) {
    const rad = (lat * Math.PI) / 180;
    return (
      (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) /
      2 * Math.pow(2, zoom)
    );
  }
  _tileX2lon(x, zoom) { return (x / Math.pow(2, zoom)) * 360 - 180; }
  _tileY2lat(y, zoom) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  _visibleTileRange() {
    const cx = this._lon2tileX(this.center.lon, this.zoom);
    const cy = this._lat2tileY(this.center.lat, this.zoom);
    // Fetch a generous perimeter around the viewport so high-speed moves
    // don't show as blank squares before tiles arrive.
    const tilesAcross = this._w / this.tilePixelSize + 4;
    const tilesDown = this._h / this.tilePixelSize + 4;
    const ratio = this._w / this._h;
    const halfW = Math.ceil(tilesAcross / 2);
    const halfH = Math.ceil(tilesDown / 2);
    return {
      x0: Math.floor(cx - halfW),
      x1: Math.floor(cx + halfW),
      y0: Math.floor(cy - halfH),
      y1: Math.floor(cy + halfH),
      cx, cy,
      ratio,
    };
  }

  async _maybeRequestTiles(force = false) {
    if (!this.api || !this.api.getMapTiles) return;
    if (!this.center) return;
    const r = this._visibleTileRange();
    const key = `${this.zoom}|${r.x0}|${r.y0}|${r.x1}|${r.y1}|${this.tileSource}`;
    if (!force && key === this._lastTileKey) return;
    this._lastTileKey = key;
    const urls = [];
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        urls.push(this._tileUrl(x, y, this.zoom));
      }
    }
    // Kick off a fresh draw immediately so the loading placeholders appear.
    this.draw();
    try {
      const tiles = await this.api.getMapTiles(urls);
      if (!tiles || !tiles.length) return;
      tiles.forEach((t) => {
        if (!t || !t.url || !t.dataUrl) return;
        const img = new Image();
        img.onload = () => { this.tileCache.set(t.url, img); this.draw(); };
        img.onerror = () => { /* tile remains missing; grid fallback shows */ };
        img.src = t.dataUrl;
        // Don't cache a not-yet-loaded image; it'll be added on load.
      });
      this.draw();
    } catch (_) { /* ignore */ }
  }

  _tileUrl(x, y, z) {
    // Per-tile URL with the actual z/x/y substituted. The main process
    // matches the prefix (osm://, arcgis://sat/) to know which provider
    // to use, then expands to a real HTTPS path.
    if (this.tileSource === 'satellite') {
      return `arcgis://sat/${z}/${y}/${x}`;
    }
    return `osm://${z}/${x}/${y}`;
  }

  // ---- Drawing ----
  _project(lon, lat) {
    const r = this._visibleTileRange();
    const tileX = this._lon2tileX(lon, this.zoom);
    const tileY = this._lat2tileY(lat, this.zoom);
    const px = (tileX - r.cx) * this.tilePixelSize + this._w / 2;
    const py = (tileY - r.cy) * this.tilePixelSize + this._h / 2;
    return { x: px, y: py };
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this._w;
    const h = this._h;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    // Distinct map background so the panel reads as "a map" instead of
    // blending into the page bg.
    ctx.fillStyle = '#0b1a2e';
    ctx.fillRect(0, 0, w, h);

    if (!this.center && !this.position && !this.home) {
      this._drawEmpty(ctx, w, h);
      this._drawHud(ctx, w, h);
      this._drawScaleBar(ctx, w, h);
      return;
    }

    if (!this.center) {
      this.center = (this.position && { lat: this.position.lat, lon: this.position.lon }) ||
        (this.home && { lat: this.home.lat, lon: this.home.lon });
    }

    // tiles
    const tiles = this._visibleTileRange();
    this._drawTiles(ctx, tiles);
    // grid fallback (so it's still useful when offline)
    this._drawGrid(ctx, w, h, tiles);

    // geofence
    if (this.geofence.length > 1) this._drawGeofence(ctx);

    // home
    if (this.home && (this.home.lat || this.home.lon)) this._drawHome(ctx);

    // mission waypoints
    if (this.missionWaypoints.length > 0) this._drawMission(ctx);

    // track
    if (this.track.length > 1) this._drawTrack(ctx);

    // other aircraft
    this.otherAircraft.forEach((a) => this._drawAircraft(ctx, a));

    // drone
    if (this.position) this._drawDrone(ctx);

    // hud
    this._drawHud(ctx, w, h);
    this._drawScaleBar(ctx, w, h);
  }

  _drawTiles(ctx, r) {
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        const url = this._tileUrl(x, y, this.zoom);
        const img = this.tileCache.get(url);
        const px = (x - r.cx) * this.tilePixelSize + this._w / 2;
        const py = (y - r.cy) * this.tilePixelSize + this._h / 2;
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, px, py, this.tilePixelSize, this.tilePixelSize);
        } else {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.fillRect(px, py, this.tilePixelSize, this.tilePixelSize);
        }
      }
    }
  }

  _drawGrid(ctx, w, h, r) {
    // Visible lat/lon grid overlay so the map is readable even when tiles
    // haven't loaded.
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.lineWidth = 1;
    const gridPx = 60;
    const offsetX = (this._w / 2) - r.cx * this.tilePixelSize;
    const offsetY = (this._h / 2) - r.cy * this.tilePixelSize;
    for (let x = (offsetX % gridPx); x < w; x += gridPx) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = (offsetY % gridPx); y < h; y += gridPx) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // Stronger axis cross
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.32)';
    ctx.beginPath();
    ctx.moveTo(0, this._h / 2); ctx.lineTo(w, this._h / 2);
    ctx.moveTo(this._w / 2, 0); ctx.lineTo(this._w / 2, h);
    ctx.stroke();
    ctx.restore();
  }

  _drawHome(ctx) {
    const { x, y } = this._project(this.home.lon, this.home.lat);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = '11px JetBrains Mono';
    ctx.fillStyle = '#fde68a';
    ctx.fillText('HOME', x + 10, y + 4);
  }

  _drawTrack(ctx) {
    if (!this.track.length) return;
    ctx.lineWidth = 2;
    // fading tail: draw segments with decreasing opacity as age increases.
    const n = this.track.length;
    for (let i = 1; i < n; i++) {
      const a = this.track[i - 1];
      const b = this.track[i];
      const age = 1 - (n - i) / Math.max(50, n);
      const alpha = Math.max(0.15, Math.min(0.95, age));
      ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      const p1 = this._project(a.lon, a.lat);
      const p2 = this._project(b.lon, b.lat);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  _drawMission(ctx) {
    if (this.missionWaypoints.length < 1) return;
    // leg lines
    ctx.lineWidth = 1.4;
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
      ctx.fillStyle = isCurrent ? '#fbbf24' : '#22c55e';
      ctx.beginPath(); ctx.arc(x, y, isCurrent ? 6 : 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isCurrent ? 'rgba(251, 191, 36, 0.6)' : 'rgba(34, 197, 94, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '10px JetBrains Mono';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(`WP${i + 1}`, x + 8, y - 8);
      if (wp.alt !== undefined) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
        ctx.fillText(`${Math.round(wp.alt)}m`, x + 8, y + 4);
      }
    });
  }

  _drawGeofence(ctx) {
    if (this.geofence.length < 3) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
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
    // Use the *interpolated* position and heading so the drone glides
    // smoothly between telemetry packets instead of teleporting.
    const pos = this._renderPos || this.position;
    const heading = this._renderHeading ?? this.heading;
    if (!pos) return;
    const { x, y } = this._project(pos.lon, pos.lat);
    // heading vector
    const headingRad = ((heading || 0) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(headingRad) * 36, y - Math.cos(headingRad) * 36);
    ctx.stroke();
    // accuracy ring
    const acc = Math.max(8, Math.min(60, this.position.accuracy_m || 0));
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.18)';
    ctx.beginPath(); ctx.arc(x, y, acc, 0, Math.PI * 2); ctx.stroke();
    // plane icon
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(headingRad);
    this._drawPlaneIcon(ctx);
    ctx.restore();
    // label
    ctx.font = '11px JetBrains Mono';
    ctx.fillStyle = '#bbf7d0';
    ctx.fillText('UAV', x + 12, y + 14);
    if (this.position.alt_rel_m !== undefined) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.fillText(`${Math.round(this.position.alt_rel_m)}m`, x + 12, y + 26);
    }
  }

  _drawPlaneIcon(ctx) {
    ctx.fillStyle = '#22c55e';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    // fuselage
    ctx.moveTo(0, -10);
    ctx.lineTo(2, -2);
    ctx.lineTo(9, 0); // right wingtip
    ctx.lineTo(2, 1);
    ctx.lineTo(3, 7); // tail boom
    ctx.lineTo(-3, 7);
    ctx.lineTo(-2, 1);
    ctx.lineTo(-9, 0); // left wingtip
    ctx.lineTo(-2, -2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  _drawAircraft(ctx, a) {
    const { x, y } = this._project(a.lon, a.lat);
    const headingRad = ((a.heading || 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(headingRad);
    ctx.fillStyle = a.friendly ? '#fbbf24' : '#f97316';
    ctx.strokeStyle = '#0f172a';
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
    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
    const altStr = a.alt !== undefined ? `${Math.round(a.alt)}m` : '';
    const spdStr = a.speed !== undefined ? `${Math.round(a.speed)}m/s` : '';
    ctx.fillText([altStr, spdStr].filter(Boolean).join(' · '), x + 10, y + 8);
  }

  _drawEmpty(ctx, w, h) {
    // Big compass rose so the empty map is visually alive.
    const cx = w / 2;
    const cy = h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
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
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
    ctx.font = '13px Inter';
    ctx.fillText('Awaiting GPS fix…', cx, cy + 4);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  _drawScaleBar(ctx, w, h) {
    if (!this.center) return;
    // Compute a friendly meters-per-pixel scale from the current zoom.
    const metersPerPixel = 156543.03 * Math.cos((this.center.lat || 0) * Math.PI / 180) / Math.pow(2, this.zoom);
    // pick a bar length that maps to ~80–120 px
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

  _drawHud(ctx, w, h) {
    const lines = [];
    if (this.center) {
      lines.push(`Lat ${this.center.lat.toFixed(6)}°`);
      lines.push(`Lon ${this.center.lon.toFixed(6)}°`);
    }
    lines.push(`Zoom ${this.zoom}`);
    lines.push(`WP ${this.missionWaypoints.length}`);
    if (this.otherAircraft.length) lines.push(`Other ${this.otherAircraft.length}`);
    ctx.save();
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
    lines.forEach((l, i) => ctx.fillText(l, w - 12, 14 + i * 12));
    ctx.textAlign = 'start';
    // follow toggle
    ctx.fillStyle = this.follow ? 'rgba(34, 197, 94, 0.9)' : 'rgba(148, 163, 184, 0.7)';
    ctx.fillText(this.follow ? '● FOLLOW' : '○ FREE', 12, 14);
    ctx.restore();
  }

  // ---- Interaction ----
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
      last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      this.follow = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      // pan by pixel / tile
      const metersPerPixel = 156543.03 * Math.cos((this.center.lat || 0) * Math.PI / 180) / Math.pow(2, this.zoom);
      const dLon = (dx * metersPerPixel) / (111111 * Math.cos((this.center.lat || 0) * Math.PI / 180));
      const dLat = -(dy * metersPerPixel) / 111111;
      this.center = {
        lat: this.center.lat + dLat,
        lon: this.center.lon - dLon,
      };
      this.draw();
      this._maybeRequestTiles();
    });
    const endDrag = () => { last = null; };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', endDrag);
    c.addEventListener('dblclick', () => {
      // dblclick re-centers on the drone
      if (this.position) {
        this.center = { lat: this.position.lat, lon: this.position.lon };
        this._renderCenter = { ...this.center };
        this._centerTarget = { ...this.center };
      }
      this.follow = true;
      this.draw();
    });
  }
}
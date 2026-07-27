import { fmt, setText, setState } from './format.js';
import { Horizon } from './horizon.js';
import { MapView } from './map.js';
import { Compass } from './compass.js';
import { serializeTrackKML, parseTrackFile } from './track-log.js';

const api = window.aerogcs;

const els = {
  portSelect: document.getElementById('port-select'),
  baudSelect: document.getElementById('baud-select'),
  connectBtn: document.getElementById('connect-btn'),
  refreshBtn: document.getElementById('refresh-ports'),
  diag: document.getElementById('diag'),
  envInfo: document.getElementById('env-info'),
  saveLogBtn: document.getElementById('save-log'),
  missionBar: document.getElementById('mission-bar'),
  mapTileSource: document.getElementById('map-tile-source'),
  mapZoomIn: document.getElementById('map-zoom-in'),
  mapZoomOut: document.getElementById('map-zoom-out'),
  mapRecenter: document.getElementById('map-recenter'),
  mapQuickCache: document.getElementById('map-quick-cache'),
  mapOfflineBtn: document.getElementById('map-download-offline'),
  mapOrientation: document.getElementById('map-orientation'),
  mapSaveTrack: document.getElementById('map-save-track'),
  mapLoadTrack: document.getElementById('map-load-track'),
  mapCaptureTrack: document.getElementById('map-capture-track'),
  mapRulerClear: document.getElementById('mp-ruler-clear'),
  mapCtxMenu: document.getElementById('map-ctxmenu'),
  mpLayerToggles: document.querySelectorAll('[data-map-layer]'),
  mpTabs: document.querySelectorAll('[data-mp-tab]'),
  offlinePanel: document.getElementById('offline-panel'),
  offlineLat: document.getElementById('offline-lat'),
  offlineLon: document.getElementById('offline-lon'),
  offlineRadius: document.getElementById('offline-radius'),
  offlineRadiusValue: document.getElementById('offline-radius-value'),
  offlineMinZoom: document.getElementById('offline-min-zoom'),
  offlineMaxZoom: document.getElementById('offline-max-zoom'),
  offlineSource: document.getElementById('offline-source'),
  offlineUseDrone: document.getElementById('offline-use-drone'),
  offlineUseMap: document.getElementById('offline-use-map'),
  offlineEstimate: document.getElementById('offline-estimate'),
  offlineStart: document.getElementById('offline-start'),
  offlineCancel: document.getElementById('offline-cancel'),
  offlineProgress: document.getElementById('offline-progress'),
  offlineProgressFill: document.getElementById('offline-progress-fill'),
  offlineProgressText: document.getElementById('offline-progress-text'),
  offlineStatus: document.getElementById('offline-status'),
};

const horizon = new Horizon(document.getElementById('horizon'));
const mapView = new MapView(document.getElementById('map'), { api });
// compass still references its canvas, but we no longer render it; keep null-safe
const compassCanvas = document.getElementById('compass');
const compass = compassCanvas ? new Compass(compassCanvas) : null;

let lastSnapshot = null;
let lastHeartbeatMs = 0;
let missionStartMs = Date.now();

// --------------------------- Connection lifecycle ---------------------------

async function refreshPorts() {
  try {
    const result = await api.listPorts();
    const ports = (result && result.ports) || [];
    const error = result && result.error;
    els.portSelect.innerHTML = '';
    if (!ports.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No serial ports found';
      els.portSelect.appendChild(opt);
      setText(
        'diag',
        error
          ? `Port scan failed: ${error}. Type the COM path manually.`
          : 'No serial ports found.',
      );
      return;
    }
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.path;
      const label = p.friendlyName && p.friendlyName !== p.path
        ? `${p.path} — ${p.friendlyName}${p.manufacturer ? ' (' + p.manufacturer + ')' : ''}`
        : `${p.path}${p.manufacturer ? ' — ' + p.manufacturer : ''}`;
      opt.textContent = label;
      els.portSelect.appendChild(opt);
    }
    if (error) {
      setText('diag', `Warning: native serialport unavailable (${error}). Showing fallback list.`);
    } else {
      setText('diag', `Detected ${ports.length} port(s).`);
    }
  } catch (err) {
    setText('diag', `Port scan error: ${err.message}`);
  }
}

async function setConnectedUi(connected, path, baud) {
  if (connected) {
    els.connectBtn.dataset.state = 'connected';
    els.connectBtn.textContent = 'Disconnect';
    els.connectBtn.disabled = false;
    els.portSelect.disabled = true;
    els.baudSelect.disabled = true;
  } else {
    els.connectBtn.dataset.state = 'disconnected';
    els.connectBtn.textContent = 'Connect';
    els.connectBtn.disabled = false;
    els.portSelect.disabled = false;
    els.baudSelect.disabled = false;
  }
}

async function toggleConnect() {
  const state = els.connectBtn.dataset.state;
  if (state === 'connected') {
    await disconnect();
  } else if (state !== 'connecting') {
    await connect();
  }
}

function selectedPort() {
  return (els.portSelect.value || '').trim();
}

async function connect() {
  els.connectBtn.dataset.state = 'connecting';
  els.connectBtn.textContent = 'Connecting…';
  els.connectBtn.disabled = true;
  try {
    const res = await api.connect({
      path: selectedPort(),
      baudRate: parseInt(els.baudSelect.value, 10),
    });
    if (res && res.ok) {
      await setConnectedUi(true, res.path, parseInt(els.baudSelect.value, 10));
      missionStartMs = Date.now();
      setText('diag', `Connected to ${res.path}`);
    } else {
      await setConnectedUi(false);
      setText('diag', `Connect failed: ${res && res.error ? res.error : 'unknown error'}`);
    }
  } catch (err) {
    await setConnectedUi(false);
    setText('diag', `Connect error: ${err.message}`);
  }
}

async function disconnect() {
  els.connectBtn.dataset.state = 'connecting';
  els.connectBtn.textContent = 'Disconnecting…';
  els.connectBtn.disabled = true;
  try {
    await api.disconnect();
  } catch (_) { /* ignore */ }
  await setConnectedUi(false);
  setText('diag', 'Disconnected.');
}

els.connectBtn.addEventListener('click', toggleConnect);
els.refreshBtn.addEventListener('click', refreshPorts);

// Map controls
els.mapTileSource.addEventListener('change', () => {
  mapView.setTileSource(els.mapTileSource.value);
});
els.mapZoomIn.addEventListener('click', () => mapView.setZoom(mapView.zoom + 1));
els.mapZoomOut.addEventListener('click', () => mapView.setZoom(mapView.zoom - 1));
els.mapRecenter.addEventListener('click', () => {
  if (lastSnapshot) {
    mapView.setFollow(true);
    // Sync the smoothed render-center so the next RAF tick paints at
    // the vehicle, not at the panned-away position.
    mapView.setCenter(lastSnapshot.lat, lastSnapshot.lon, { keepFollow: true });
  }
});

// ---- MP toolbar wiring ----
els.mapOrientation.addEventListener('click', () => {
  const next = mapView.orientation === 'up' ? 'north' : 'up';
  mapView.setOrientation(next);
  els.mapOrientation.textContent = next === 'up' ? 'TRACK UP' : 'NORTH UP';
  els.mapOrientation.classList.toggle('is-active', next === 'up');
  const ol = document.getElementById('map-orientation-label');
  if (ol) ol.textContent = next === 'up' ? 'Track Up' : 'North Up';
});

let _recordingTrack = false;
els.mapCaptureTrack.addEventListener('click', () => {
  _recordingTrack = !_recordingTrack;
  els.mapCaptureTrack.classList.toggle('is-active', _recordingTrack);
  els.mapCaptureTrack.textContent = _recordingTrack ? '■ Stop' : '● Track';
});

els.mapSaveTrack.addEventListener('click', async () => {
  if (!api.trackLog) {
    setText('diag', 'Track log IPC unavailable.');
    return;
  }
  const track = mapView.getTrack();
  if (!track.length) { setText('diag', 'Track is empty.'); return; }
  const payload = {
    format: 'kml',
    name: `track-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    kml: serializeTrackKML(track, mapView.home, mapView.missionWaypoints),
  };
  const res = await api.trackLog.save(payload);
  setText('diag', res && res.ok ? `Saved track: ${res.file}` : `Track save failed: ${(res && res.error) || 'unknown'}`);
});

els.mapLoadTrack.addEventListener('click', async () => {
  if (!api.trackLog) return;
  const res = await api.trackLog.load();
  if (!res || !res.ok) return;
  try {
    const parsed = parseTrackFile(res.format, res.content);
    if (parsed.track && parsed.track.length) {
      mapView.setTrack(parsed.track);
      setText('diag', `Loaded ${parsed.track.length} track points.`);
    } else {
      setText('diag', 'Loaded file had no track points.');
    }
  } catch (err) {
    setText('diag', `Track load error: ${err.message}`);
  }
});

els.mapRulerClear.addEventListener('click', () => mapView.clearRuler());

// Layer toggles
els.mpLayerToggles.forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.mapLayer;
    const active = !btn.classList.contains('is-active');
    btn.classList.toggle('is-active', active);
    mapView.setLayer(name, active);
  });
});

// Side tabs (purely visual for now — Mission Planner–style chrome)
els.mpTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.mpTabs.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
  });
});

// Context menu actions
els.mapCtxMenu.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.ctxAction;
    if (action === 'cancel' || action === 'fly-to') {
      mapView.hideContextMenu();
      return;
    }
    if (action === 'set-home') {
      mapView.setHomeAtCursor();
      if (lastSnapshot) lastSnapshot.home = mapView.home;
    } else if (action === 'center') {
      const c = mapView.getContextMenuCoords();
      if (c) { mapView.setCenter(c.lat, c.lon); mapView.draw(); }
    } else if (action === 'add-waypoint') {
      const wp = mapView.addWaypointAtCursor();
      if (wp) _missionWaypoints = [..._missionWaypoints, wp];
    } else if (action === 'ruler') {
      mapView.setLayer('ruler', true);
      // Activate matching toggle button
      const t = document.querySelector('[data-map-layer="ruler"]');
      if (t) t.classList.add('is-active');
      const coords = mapView.getContextMenuCoords();
      if (coords) { mapView._ruler.start = coords; mapView._updateRulerHud?.(); }
    }
    mapView.hideContextMenu();
  });
});

// Hide ctxmenu on outside click
document.addEventListener('click', (e) => {
  if (els.mapCtxMenu && !els.mapCtxMenu.contains(e.target) && !els.mapCtxMenu.hidden) {
    mapView.hideContextMenu();
  }
});

api.onLinkStatus(async (s) => {
  if (s.connected) await setConnectedUi(true, s.path, s.baud);
  else await setConnectedUi(false);
});

api.onRaw((msg) => {
  if (msg && msg.name) {
    lastHeartbeatMs = Date.now();
  }
});

// --------------------------- Helpers ---------------------------

function cardinal(deg) {
  if (deg == null || isNaN(deg)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.round(norm / 45) % 8;
  return dirs[idx];
}

// --------------------------- Rendering ---------------------------

function renderStatusStrip(s) {
  setText('val-mode', s.flight_mode || '—');
  setText('val-vehicle', s.vehicle_type || '—');

  setText('val-armed', s.armed ? 'ARMED' : 'DISARMED');
  setState('card-armed', s.armed ? 'armed' : 'disarmed');
  setText('val-mav', String(s.mavlink_version || 0));

  const fix = s.gps_fix || 'NO_GPS';
  setText('val-fix', fix);
  setText('val-sats', String(s.sats || 0));
  setText('val-hdop-mini', fmt.num(s.hdop, 1));
  setState(
    'card-gps',
    fix === '3D_FIX' || fix === 'RTK_FIXED' || fix === 'RTK_FLOAT' || fix === 'DGPS' ? 'ok' : 'failsafe'
  );

  const pct = Math.max(0, Math.min(100, s.battery_remaining_pct || 0));
  setText('val-volt-mini', fmt.v(s.battery_voltage_v));
  setText('val-batt-pct', `${Math.round(pct)}%`);

  setText('val-link-mini', `${s.link_quality || 0}%`);
  setText('val-rssi-mini', `${s.rssi ?? '—'} dBm`);
  setState('card-datalink', (s.link_quality || 0) >= 50 ? 'ok' : 'failsafe');
}

function renderAttitude(s) {
  horizon.update({
    roll_deg: s.roll_deg || 0,
    pitch_deg: s.pitch_deg || 0,
    yaw_deg: s.yaw_deg || 0,
  });

  // Side readout (small mono column)
  setText('val-roll', fmt.deg(s.roll_deg));
  setText('val-pitch', fmt.deg(s.pitch_deg));
  setText('val-yaw', `${fmt.int(s.yaw_deg)}°`);
  setText('val-rollrate', fmt.deg(s.roll_rate_dps));
  setText('val-pitchrate', fmt.deg(s.pitch_rate_dps));
  setText('val-yawrate', fmt.deg(s.yaw_rate_dps));

  // Extra flight data readout
  setText('val-alt-readout', fmt.num(s.alt_rel_m || 0, 2) + ' m');
  setText('val-gspeed', fmt.num(s.ground_speed_m_s || 0, 2) + ' m/s');
  setText('val-vspeed', fmt.num(s.vertical_speed_m_s || 0, 2) + ' m/s');
  setText('val-dwp', s.distance_to_next_m > 0 ? fmt.m(s.distance_to_next_m) : '—');
  setText('val-dmav', s.distance_to_home_m > 0 ? fmt.m(s.distance_to_home_m) : '—');
  setText('val-heading-readout', `${fmt.int(s.heading_deg || 0)}°`);

  // HUD overlay boxes
  const air = s.air_speed_m_s || s.ground_speed_m_s || 0;
  const alt = s.alt_rel_m || 0;
  const hdg = s.heading_deg || 0;
  setText('val-airspeed', fmt.num(air, 1));
  setText('val-alt-big', fmt.num(alt, 1));
  setText('val-heading-big', `${fmt.int(hdg)}°`);
  setText('val-heading-cardinal', cardinal(hdg));
  setText('val-fix-2', s.gps_fix || 'NO_GPS');
}

function renderGps(s) {
  mapView.setHome(s.home);
  mapView.setPosition({
    lat: s.lat,
    lon: s.lon,
    alt_rel_m: s.alt_rel_m,
    accuracy_m: s.gps_accuracy_m,
  });
  mapView.setHeading(s.heading_deg);
}

function renderBattery(s) {
  const pct = Math.max(0, Math.min(100, s.battery_remaining_pct || 0));
  setText('val-batt-pct-2', String(Math.round(pct)));
  // Only show voltage if it's a real reading (positive number). 0 means we
  // haven't received a SYS_STATUS or BATTERY_STATUS yet.
  setText('val-volt', s.battery_voltage_v > 0 ? fmt.v(s.battery_voltage_v) : '—');
  setText('val-volt-mini', s.battery_voltage_v > 0 ? fmt.v(s.battery_voltage_v) : '—');
  setText('val-curr', s.battery_current_a > 0 ? fmt.a(s.battery_current_a) : '—');
  setText('val-power', s.battery_power_w > 0 ? fmt.w(s.battery_power_w) : '—');
  setText('val-consumed', fmt.mah(s.battery_consumed_mah));
  setText('val-btemp', fmt.temp(s.battery_temp_c));
  setText('val-flight', s.flight_time_remaining_min ? `${s.flight_time_remaining_min} min` : '—');
  setText('val-bhealth', s.battery_health || 'UNKNOWN');

  // Voltage bar (orange in reference)
  const fill = document.getElementById('battery-fill');
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', pct < 30 && pct >= 15);
    fill.classList.toggle('crit', pct < 15);
  }

  // Per-cell rendering: read s.battery_cell_volts_v if available,
  // otherwise mark each row as missing.
  const cellsHost = document.getElementById('battery-cells');
  if (cellsHost) {
    const cells = Array.isArray(s.battery_cell_volts_v) ? s.battery_cell_volts_v : null;
    [...cellsHost.querySelectorAll('.cell-row')].forEach((row) => {
      const idx = parseInt(row.querySelector('.cell-value')?.dataset.cell || '-1', 10);
      const target = row.querySelector('.cell-value');
      if (cells && idx >= 0 && idx < cells.length && cells[idx] != null && !isNaN(cells[idx])) {
        target.textContent = `${fmt.num(cells[idx], 2)}V`;
        row.classList.remove('missing');
      } else {
        target.textContent = '—';
        row.classList.add('missing');
      }
    });
  }
}

function renderRadio(s) {
  setText('val-rssi', s.rssi != null ? `${s.rssi} dBm` : '—');
  setText('val-remrssi', s.remrssi != null ? `${s.remrssi} dBm` : '—');
  setText('val-noise', s.noise != null ? `${s.noise} dBm` : '—');
  setText('val-remnoise', s.remnoise != null ? `${s.remnoise} dBm` : '—');
  setText('val-rxerr', String(s.rxerrors || 0));
  setText('val-latency', s.latency_ms ? `${s.latency_ms} ms` : '—');
  setText('val-link', `Link ${s.link_quality || 0}%`);

  // Packet loss = 100 - link_quality (rough heuristic; real pkt-loss comes
  // from the radio telemetry stream)
  const loss = Math.max(0, Math.min(100, 100 - (s.link_quality || 0)));
  setText('val-pktloss', `${fmt.num(loss, 1)}%`);
  const pktFill = document.getElementById('pktloss-fill');
  if (pktFill) {
    pktFill.style.width = `${loss}%`;
    if (loss < 5) {
      pktFill.className = 'bar-fill bar-cyan';
    } else if (loss < 20) {
      pktFill.className = 'bar-fill low';
    } else {
      pktFill.className = 'bar-fill crit';
    }
  }
}

function renderImu(s) {
  const accel = s.imu_accel || [null, null, null];
  const gyro = s.imu_gyro || [null, null, null];
  const mag = s.imu_mag || [null, null, null];
  const vibe = s.imu_vibration || [null, null, null];

  const v = (x) => (x == null || isNaN(x)) ? '—' : fmt.num(x, 2);
  setText('val-accel-x', v(accel[0]));
  setText('val-accel-y', v(accel[1]));
  setText('val-accel-z', v(accel[2]));
  setText('val-gyro-r', v(gyro[0]));
  setText('val-gyro-p', v(gyro[1]));
  setText('val-gyro-y', v(gyro[2]));
  setText('val-mag-x', v(mag[0]));
  setText('val-mag-y', v(mag[1]));
  setText('val-mag-z', v(mag[2]));
  // Priority row at top — Vibe, IMU T, Pressure
  setText('val-vibe', `${v(vibe[0])} / ${v(vibe[1])} / ${v(vibe[2])}`);
  setText('val-imu-temp', typeof s.imu_temp_c === 'number' && s.imu_temp_c !== 0 ? fmt.temp(s.imu_temp_c) : '—');
  setText('val-pressure', typeof s.pressure_hpa === 'number' && s.pressure_hpa > 0 ? fmt.pressure(s.pressure_hpa) : '—');
}

function renderMission(s) {
  setText('val-cwp', String(s.current_waypoint || 0));
  setText('val-twp', String(s.total_waypoints || 0));
  setText('val-dnext', fmt.m(s.distance_to_next_m));
  setText('val-eta-wp', s.eta_to_waypoint_s ? `${fmt.int(s.eta_to_waypoint_s)} s` : '—');
  const pct = s.mission_progress_pct || 0;
  if (els.missionBar) els.missionBar.style.width = `${pct}%`;
  setText('val-progress', `${pct}%`);
  const elapsed = Date.now() - missionStartMs;
  setText('val-mission-time', fmt.ms_time(elapsed));
  setText(
    'val-mission-state',
    s.mission && s.mission.running ? 'Running' : (s.mission && s.mission.completed ? 'Completed' : 'Idle')
  );
}

function render(s) {
  if (!s) return;
  lastSnapshot = s;
  // Wrap each panel render so a bug in one doesn't kill the others.
  const safe = (label, fn) => {
    try { fn(s); }
    catch (err) { console.error(`[render] ${label} failed:`, err); }
  };
  safe('status', renderStatusStrip);
  safe('attitude', renderAttitude);
  safe('gps', renderGps);
  safe('battery', renderBattery);
  safe('radio', renderRadio);
  safe('imu', renderImu);
  safe('mission', renderMission);
  safe('mapHud', renderMapHud);

  const age = lastHeartbeatMs ? Date.now() - lastHeartbeatMs : Infinity;
  setText('diag', `Packets: ${s.packet_count || 0} · Last HB: ${age > 9999 ? '—' : age + 'ms'} · V: ${fmt.num(s.battery_voltage_v, 2)}V · RSSI: ${s.rssi ?? '—'} · Session: ${fmt.ms_time(Date.now() - missionStartMs)}`);
}

let _currentWpIndex = 0;
let _missionWaypoints = [];
let _firstTelemetryLogged = false;
let _telemetryCount = 0;
api.onTelemetry((s) => {
  _telemetryCount += 1;
  if (!_firstTelemetryLogged && s) {
    _firstTelemetryLogged = true;
    console.log('[AERO-GCS ALPHA] first telemetry packet received',
      `flight_mode=${s.flight_mode}`, `volt=${s.battery_voltage_v}`,
      `rssi=${s.rssi}`, `lat=${s.lat}`, `lon=${s.lon}`);
  }
  if (_telemetryCount % 50 === 0) {
    console.log(`[AERO-GCS ALPHA] ${_telemetryCount} telemetry packets processed`);
  }
  try {
    render(s);
  } catch (err) {
    console.error('[render] fatal in render():', err);
  }
  if (s && typeof s.current_waypoint === 'number' && s.current_waypoint !== _currentWpIndex) {
    _currentWpIndex = s.current_waypoint;
    _refreshMissionHighlight();
  }
});

api.onMission((wps) => {
  if (Array.isArray(wps)) {
    _missionWaypoints = wps.map((w, i) => ({ ...w }));
    _refreshMissionHighlight();
  }
});

function _refreshMissionHighlight() {
  if (_missionWaypoints.length === 0) {
    mapView.setMissionWaypoints([]);
    return;
  }
  const decorated = _missionWaypoints.map((w, i) => ({ ...w, index: i === _currentWpIndex ? i : -1 }));
  mapView.setMissionWaypoints(decorated);
}

// Populate the MP HUD blocks (right column) and the bottom-right compass.
function renderMapHud(s) {
  setText('hud-mode', s.flight_mode || '—');
  setText('hud-armed', s.armed ? 'ARMED' : 'DISARMED');
  setText('hud-batt',
    s.battery_voltage_v > 0 ? `${fmt.num(s.battery_voltage_v, 2)}V · ${Math.round(Math.max(0, Math.min(100, s.battery_remaining_pct || 0)))}%` : '—');
  setText('hud-link', `${s.link_quality || 0}%${s.rssi != null ? ` · ${s.rssi}dBm` : ''}`);
  setText('hud-gps', `${s.gps_fix || 'NO_GPS'} · ${s.sats || 0}s`);

  setText('hud-lat', s.lat != null ? `${s.lat.toFixed(6)}°` : '—');
  setText('hud-lon', s.lon != null ? `${s.lon.toFixed(6)}°` : '—');
  setText('hud-alt', s.alt_rel_m != null ? `${fmt.num(s.alt_rel_m, 1)} m` : '—');
  setText('hud-alt-abs', s.alt_msl_m != null ? `${fmt.num(s.alt_msl_m, 1)} m` : '—');
  setText('hud-speed', s.ground_speed_m_s != null ? `${fmt.num(s.ground_speed_m_s, 1)} m/s` : '—');
  setText('hud-heading', `${fmt.int(s.heading_deg || 0)}°`);

  const compassHdg = document.getElementById('mp-compass-hdg');
  if (compassHdg) compassHdg.textContent = `${fmt.int(s.heading_deg || 0)}°`;
  const rose = document.getElementById('mp-compass-rose');
  if (rose) {
    const rot = -((s.heading_deg || 0));
    // Use the rendered heading for buttery-smooth compass motion.
    const rendered = mapView._renderHeading ?? s.heading_deg ?? 0;
    rose.style.transform = `rotate(${(-rendered).toFixed(2)}deg)`;
  }
}

api.onAdsb((list) => {
  if (Array.isArray(list)) mapView.setOtherAircraft(list);
});

// --------------------------- Save log ---------------------------

els.saveLogBtn.addEventListener('click', async () => {
  if (!lastSnapshot) return;
  const res = await api.saveLog(`session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`, lastSnapshot);
  if (res && res.ok) {
    setText('diag', `Saved log: ${res.file}`);
  } else {
    setText('diag', `Save failed: ${res && res.error ? res.error : 'unknown'}`);
  }
});

// --------------------------- Boot ---------------------------

(async function boot() {
  await refreshPorts();
  const info = await api.info();
  setText('env-info', `Electron ${info.electron} · Node ${info.node} · Chrome ${info.chrome}${info.mock ? ' · mock' : ''}`);
  try {
    const opts = Array.from(els.portSelect.options).map((o) => `${o.value}|${o.textContent}`);
    console.log('[AERO-GCS ALPHA] ports:', JSON.stringify(opts));
  } catch (_) { /* ignore */ }
  // Ensure the panels resize once the layout settles.
  horizon._setup?.();
  compass?._setup?.();
  mapView._resize();
  setTimeout(() => {
    horizon._setup?.();
    compass?._setup?.();
    mapView._resize();
  }, 100);
})();

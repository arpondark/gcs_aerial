import { fmt, setText, setState } from './format.js';
import { Horizon } from './horizon.js';
import { MapView } from './map.js';
import { Compass } from './compass.js';

const api = window.aerogcs;

const els = {
  portSelect: document.getElementById('port-select'),
  baudSelect: document.getElementById('baud-select'),
  connectBtn: document.getElementById('connect-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  refreshBtn: document.getElementById('refresh-ports'),
  connPill: document.getElementById('conn-pill'),
  connStatus: document.getElementById('conn-status'),
  diag: document.getElementById('diag'),
  envInfo: document.getElementById('env-info'),
  saveLogBtn: document.getElementById('save-log'),
  missionBar: document.getElementById('mission-bar'),
  mapTileSource: document.getElementById('map-tile-source'),
  mapZoomIn: document.getElementById('map-zoom-in'),
  mapZoomOut: document.getElementById('map-zoom-out'),
  mapRecenter: document.getElementById('map-recenter'),
};

const horizon = new Horizon(document.getElementById('horizon'));
const mapView = new MapView(document.getElementById('map'), { api });
const compass = new Compass(document.getElementById('compass'));

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
          ? `Port scan failed: ${error}. Type the COM path manually or use MOCK.`
          : 'No serial ports found. Type the COM path manually or use MOCK.',
      );
      return;
    }
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.path;
      const label = p.path === 'MOCK'
        ? p.friendlyName
        : p.friendlyName && p.friendlyName !== p.path
          ? `${p.path} — ${p.friendlyName}${p.manufacturer ? ' (' + p.manufacturer + ')' : ''}`
          : `${p.path}${p.manufacturer ? ' — ' + p.manufacturer : ''}`;
      opt.textContent = label;
      els.portSelect.appendChild(opt);
    }
    if (error) {
      setText(
        'diag',
        `Warning: native serialport unavailable (${error}). Showing fallback list.`,
      );
    } else {
      setText('diag', `Detected ${ports.length} port(s).`);
    }
  } catch (err) {
    setText('diag', `Port scan error: ${err.message}`);
  }
}

async function setConnectedUi(connected, path, baud) {
  if (connected) {
    els.connPill.dataset.state = 'online';
    els.connStatus.textContent = `Connected · ${path}${baud ? ' @ ' + baud : ''}`;
    els.connectBtn.disabled = true;
    els.disconnectBtn.disabled = false;
    els.portSelect.disabled = true;
    els.baudSelect.disabled = true;
  } else {
    els.connPill.dataset.state = 'offline';
    els.connStatus.textContent = 'Disconnected';
    els.connectBtn.disabled = false;
    els.disconnectBtn.disabled = false;
    els.portSelect.disabled = false;
    els.baudSelect.disabled = false;
  }
}

function selectedPort() {
  return (els.portSelect.value || '').trim();
}

async function connect() {
  els.connPill.dataset.state = 'connecting';
  els.connStatus.textContent = 'Connecting…';
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
  await api.disconnect();
  await setConnectedUi(false);
  setText('diag', 'Disconnected.');
}

els.connectBtn.addEventListener('click', connect);
els.disconnectBtn.addEventListener('click', disconnect);
els.refreshBtn.addEventListener('click', refreshPorts);

// Map controls
els.mapTileSource.addEventListener('change', () => {
  mapView.setTileSource(els.mapTileSource.value);
});
els.mapZoomIn.addEventListener('click', () => mapView.setZoom(mapView.zoom + 1));
els.mapZoomOut.addEventListener('click', () => mapView.setZoom(mapView.zoom - 1));
els.mapRecenter.addEventListener('click', () => {
  if (lastSnapshot) {
    mapView.center = { lat: lastSnapshot.lat, lon: lastSnapshot.lon };
    mapView.setFollow(true);
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

// --------------------------- Rendering ---------------------------

function renderStatusStrip(s) {
  setText('val-mode', s.flight_mode || '—');
  setText('val-vehicle', s.vehicle_type || '—');
  setText('val-mav', String(s.mavlink_version || 0));

  setText('val-armed', s.armed ? 'ARMED' : 'DISARMED');
  setState('card-armed', s.armed ? 'armed' : 'disarmed');

  setText('val-status', s.system_status || '—');
  setState('card-vehicle', (s.system_status === 'CRITICAL' || s.system_status === 'EMERGENCY') ? 'failsafe' : 'ok');

  setText('val-ekf', s.ekf_healthy ? 'Healthy' : 'Degraded');
  setState('card-ekf', s.ekf_healthy ? 'ok' : 'failsafe');

  setText('val-fix', s.gps_fix || 'NO_GPS');
  setText('val-sats', String(s.sats || 0));
  setState('card-gps', (s.gps_fix === '3D_FIX' || s.gps_fix === 'RTK_FIXED' || s.gps_fix === 'RTK_FLOAT' || s.gps_fix === 'DGPS') ? 'ok' : 'failsafe');

  const fs = s.failsafe || {};
  document.querySelectorAll('.fs-grid span').forEach((el) => {
    const key = el.dataset.fs;
    el.dataset.active = String(!!fs[key]);
  });
  const anyFs = !!(fs.battery || fs.rc || fs.gps);
  setState('card-failsafe', anyFs ? 'failsafe' : 'ok');

  setText('val-mission', s.mission && s.mission.running ? 'Running' : (s.mission && s.mission.completed ? 'Completed' : 'Idle'));
  setText('val-wp', String(s.current_waypoint || 0));
  setText('val-wp-total', String(s.total_waypoints || 0));
  setState('card-mission', s.mission && s.mission.completed ? 'completed' : (s.mission && s.mission.running ? 'running' : 'idle'));
}

function renderAttitude(s) {
  horizon.update({
    roll_deg: s.roll_deg || 0,
    pitch_deg: s.pitch_deg || 0,
    yaw_deg: s.yaw_deg || 0,
  });
  setText('val-roll', fmt.deg(s.roll_deg));
  setText('val-pitch', fmt.deg(s.pitch_deg));
  setText('val-yaw', `${fmt.int(s.yaw_deg)}°`);
  setText('val-rollrate', fmt.deg(s.roll_rate_dps));
  setText('val-pitchrate', fmt.deg(s.pitch_rate_dps));
  setText('val-yawrate', fmt.deg(s.yaw_rate_dps));
}

function renderGps(s) {
  setText('val-lat', fmt.lat(s.lat));
  setText('val-lon', fmt.lon(s.lon));
  setText('val-alt-msl', fmt.m(s.alt_msl_m));
  setText('val-alt-rel', fmt.m(s.alt_rel_m));
  setText('val-gspeed', fmt.ms(s.ground_speed_m_s));
  setText('val-aspeed', fmt.ms(s.air_speed_m_s));
  setText('val-vspeed', fmt.ms(s.vertical_speed_m_s));
  setText('val-heading', fmt.deg(s.heading_deg));
  setText('val-cog', fmt.deg(s.cog_deg));
  setText('val-dop', `${fmt.num(s.hdop, 2)} / ${fmt.num(s.vdop, 2)}`);
  setText('val-sats-2', String(s.sats || 0));
  setText('val-gacc', fmt.m(s.gps_accuracy_m));
  setText('val-home', s.home && s.home.lat ? `${fmt.lat(s.home.lat)} ${fmt.lon(s.home.lon)}` : '—');
  setText('val-dist', fmt.m(s.distance_to_home_m));
  setText('val-bearing', `${fmt.int(s.bearing_to_home_deg)}°`);
  setText('val-eta', s.eta_to_home_s ? `${fmt.int(s.eta_to_home_s)} s` : '—');
  setText('val-fix-2', s.gps_fix || 'NO_GPS');

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
  setText('val-batt-pct', `${Math.round(pct)}%`);
  setText('val-volt', fmt.v(s.battery_voltage_v));
  setText('val-curr', fmt.a(s.battery_current_a));
  setText('val-remaining', `${Math.round(pct)}%`);
  setText('val-consumed', fmt.mah(s.battery_consumed_mah));
  setText('val-power', fmt.w(s.battery_power_w));
  setText('val-btemp', fmt.temp(s.battery_temp_c));
  setText('val-flight', s.flight_time_remaining_min ? `${s.flight_time_remaining_min} min` : '—');
  setText('val-bhealth', s.battery_health || 'UNKNOWN');

  const fill = document.getElementById('battery-fill');
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', pct < 30 && pct >= 15);
    fill.classList.toggle('crit', pct < 15);
  }

  // 6-cell rendering (optional - host may be omitted in compact layouts)
  const cellsHost = document.getElementById('battery-cells');
  if (cellsHost) {
    const cells = Math.round((pct / 100) * 6);
    if (cellsHost.childElementCount !== 6) {
      cellsHost.innerHTML = '';
      for (let i = 0; i < 6; i++) {
        const d = document.createElement('div');
        cellsHost.appendChild(d);
      }
    }
    [...cellsHost.children].forEach((c, i) => {
      c.classList.remove('active', 'low', 'crit');
      if (i < cells) {
        if (pct < 15) c.classList.add('crit');
        else if (pct < 30) c.classList.add('low');
        else c.classList.add('active');
      }
    });
  }
}

function renderRadio(s) {
  setText('val-rssi', `${s.rssi}`);
  setText('val-remrssi', `${s.remrssi}`);
  setText('val-noise', `${s.noise}`);
  setText('val-remnoise', `${s.remnoise}`);
  setText('val-rxerr', String(s.rxerrors || 0));
  setText('val-latency', s.latency_ms ? `${s.latency_ms} ms` : '—');
  setText('val-link', `Link ${s.link_quality || 0}%`);
}

function renderImu(s) {
  const accel = s.imu_accel || [0, 0, 0];
  const gyro = s.imu_gyro || [0, 0, 0];
  const mag = s.imu_mag || [0, 0, 0];
  const vibe = s.imu_vibration || [0, 0, 0];
  setText('val-accel', `${accel.map((v) => fmt.num(v, 2)).join(' / ')}`);
  setText('val-gyro', `${gyro.map((v) => fmt.num(v, 2)).join(' / ')}`);
  setText('val-mag', `${mag.map((v) => fmt.num(v, 2)).join(' / ')}`);
  setText('val-vibe', `${vibe.map((v) => fmt.num(v, 2)).join(' / ')}`);
  setText('val-imu-temp', fmt.temp(s.imu_temp_c));
}

function renderBarometer(s) {
  setText('val-pressure', fmt.pressure(s.pressure_hpa));
}

function renderMission(s) {
  setText('val-cwp', String(s.current_waypoint || 0));
  setText('val-twp', String(s.total_waypoints || 0));
  setText('val-dnext', fmt.m(s.distance_to_next_m));
  setText('val-eta-wp', s.eta_to_waypoint_s ? `${fmt.int(s.eta_to_waypoint_s)} s` : '—');
  const pct = s.mission_progress_pct || 0;
  els.missionBar.style.width = `${pct}%`;
  setText('val-progress', `${pct}%`);
  const elapsed = Date.now() - missionStartMs;
  setText('val-mission-time', fmt.ms_time(elapsed));
  setText('val-mission-state', s.mission && s.mission.running ? 'Running' : (s.mission && s.mission.completed ? 'Completed' : 'Idle'));
}

function renderCompass(s) {
  compass.set({ heading: s.heading_deg || 0, bearing: s.bearing_to_home_deg || 0 });
  setText('val-compass', `${fmt.int(s.heading_deg || 0)}°`);
  setText('val-bearing-2', `${fmt.int(s.bearing_to_home_deg || 0)}°`);
}

function render(s) {
  if (!s) return;
  lastSnapshot = s;
  renderStatusStrip(s);
  renderAttitude(s);
  renderGps(s);
  renderBattery(s);
  renderRadio(s);
  renderImu(s);
  renderBarometer(s);
  renderMission(s);
  renderCompass(s);

  const age = lastHeartbeatMs ? Date.now() - lastHeartbeatMs : Infinity;
  setText('diag', `Packets: ${s.packet_count || 0} · Last HB: ${age > 9999 ? '—' : age + 'ms'} · Session: ${fmt.ms_time(Date.now() - missionStartMs)}`);
}

let _currentWpIndex = 0;
let _missionWaypoints = [];
api.onTelemetry((s) => {
  render(s);
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
  // Confirm the populated dropdown is alive in dev-tools.
  try {
    const opts = Array.from(els.portSelect.options).map((o) => `${o.value}|${o.textContent}`);
    console.log('[UIU Aerial Robotics GCP] ports:', JSON.stringify(opts));
  } catch (_) { /* ignore */ }
  // Ensure the panels resize once the layout settles. The ResizeObservers
  // attached in each component will pick up subsequent changes.
  horizon._setup?.();
  compass._setup?.();
  mapView._resize();
  setTimeout(() => {
    horizon._setup?.();
    compass._setup?.();
    mapView._resize();
  }, 100);
})();
'use strict';

const { EventEmitter } = require('node:events');

const DEFAULTS = {
  // Flight status
  flight_mode: 'UNKNOWN',
  system_status: 'UNKNOWN',
  armed: false,
  vehicle_type: 'UNKNOWN',
  mavlink_version: 0,
  ekf_healthy: true,
  gps_fix: 'NO_GPS',
  failsafe: { battery: false, rc: false, gps: false },
  mission: { running: false, completed: false, current: 0, total: 0 },

  // GPS / nav
  lat: 0,
  lon: 0,
  alt_msl_m: 0,
  alt_rel_m: 0,
  ground_speed_m_s: 0,
  air_speed_m_s: 0,
  vertical_speed_m_s: 0,
  heading_deg: 0,
  cog_deg: 0,
  sats: 0,
  hdop: 99,
  vdop: 99,
  gps_accuracy_m: 0,
  home: { lat: 0, lon: 0, alt_m: 0 },

  // Attitude
  roll_deg: 0,
  pitch_deg: 0,
  yaw_deg: 0,
  roll_rate_dps: 0,
  pitch_rate_dps: 0,
  yaw_rate_dps: 0,

  // Battery
  battery_voltage_v: 0,
  battery_current_a: 0,
  battery_remaining_pct: 0,
  battery_consumed_mah: 0,
  battery_power_w: 0,
  battery_temp_c: 0,
  battery_health: 'UNKNOWN',
  flight_time_remaining_min: 0,

  // Radio / telemetry
  rssi: 0,
  remrssi: 0,
  noise: 0,
  remnoise: 0,
  rxerrors: 0,
  latency_ms: 0,

  // IMU
  imu_accel: [0, 0, 0],
  imu_gyro: [0, 0, 0],
  imu_mag: [0, 0, 0],
  imu_vibration: [0, 0, 0],
  imu_temp_c: 0,

  // Barometer
  pressure_hpa: 0,
  temperature_c: 0,
  baro_alt_m: 0,

  // Mission
  current_waypoint: 0,
  total_waypoints: 0,
  distance_to_next_m: 0,
  eta_to_waypoint_s: 0,
  mission_progress_pct: 0,

  // Diagnostics
  last_heartbeat_ms: 0,
  packet_count: 0,
  link_quality: 0,
};

class TelemetryStore extends EventEmitter {
  constructor() {
    super();
    this._state = JSON.parse(JSON.stringify(DEFAULTS));
    this._lastSentAt = 0;
  }

  reset() {
    this._state = JSON.parse(JSON.stringify(DEFAULTS));
    this._lastSentAt = 0;
    this.emit('update', this._snapshot());
  }

  apply(msg) {
    if (!msg || !msg.decoded) return;
    this._state.packet_count += 1;
    this._state.last_heartbeat_ms = Date.now();
    const d = msg.decoded;
    switch (msg.msgId) {
      case 0: this._applyHeartbeat(d); break;
      case 1: this._applySysStatus(d); break;
      case 24: this._applyGps(d); break;
      case 27: this._applyImu(d); break;
      case 29: this._applyPressure(d); break;
      case 30: this._applyAttitude(d); break;
      case 33: this._applyGlobalPosition(d); break;
      case 42: this._applyMission(d); break;
      case 74: this._applyHud(d); break;
      case 109: this._applyRadio(d); break;
      case 147: this._applyBattery(d); break;
      case 242: this._applyHome(d); break;
      default: break;
    }

    // derived values
    const home = this._state.home;
    const dist = this._haversine(this._state.lat, this._state.lon, home.lat, home.lon);
    this._state.distance_to_home_m = dist;
    this._state.bearing_to_home_deg = this._bearing(this._state.lat, this._state.lon, home.lat, home.lon);
    this._state.battery_power_w = this._state.battery_voltage_v * this._state.battery_current_a;
    if (this._state.battery_current_a > 0.1) {
      this._state.flight_time_remaining_min = Math.max(
        0,
        Math.round((this._state.battery_remaining_pct / 100) * (this._state.battery_consumed_mah / Math.max(0.1, this._state.battery_current_a) * 60)),
      );
    }
    if (this._state.ground_speed_m_s > 0.5) {
      this._state.eta_to_home_s = Math.round(this._state.distance_to_home_m / this._state.ground_speed_m_s);
    } else {
      this._state.eta_to_home_s = 0;
    }
    if (this._state.total_waypoints > 0) {
      this._state.mission_progress_pct = Math.min(
        100,
        Math.round((this._state.current_waypoint / this._state.total_waypoints) * 100),
      );
    }

    // throttle snapshot emission to ~10 Hz
    const now = Date.now();
    if (now - this._lastSentAt >= 100) {
      this._lastSentAt = now;
      this.emit('update', this._snapshot());
    }
    this.emit('raw', msg);
  }

  _snapshot() {
    return JSON.parse(JSON.stringify(this._state));
  }

  _applyHeartbeat(d) {
    this._state.flight_mode = d.flight_mode;
    this._state.vehicle_type = d.type;
    this._state.system_status = d.system_status;
    this._state.armed = d.armed;
    this._state.mavlink_version = d.mavlink_version;
    this._state.ekf_healthy = this._state.sats >= 8;
  }

  _applySysStatus(d) {
    if (typeof d.voltage_v === 'number') this._state.battery_voltage_v = d.voltage_v;
    if (typeof d.current_a === 'number') this._state.battery_current_a = d.current_a;
    if (typeof d.remaining_pct === 'number') this._state.battery_remaining_pct = d.remaining_pct;
    this._state.failsafe.battery = d.remaining_pct < 20;
  }

  _applyGps(d) {
    this._state.gps_fix = d.fix;
    this._state.sats = d.sats;
    this._state.hdop = d.eph || 99;
    this._state.vdop = d.epv || 99;
    this._state.gps_accuracy_m = Math.max(d.eph || 0, d.epv || 0);
    this._state.ekf_healthy = (d.sats >= 8) && ['3D_FIX', 'DGPS', 'RTK_FLOAT', 'RTK_FIXED'].includes(d.fix);
    this._state.failsafe.gps = d.sats < 6;
    if (typeof d.lat === 'number' && typeof d.lon === 'number') {
      this._state.lat = d.lat;
      this._state.lon = d.lon;
    }
    this._state.cog_deg = d.cog || 0;
  }

  _applyImu(d) {
    if (d.accel) this._state.imu_accel = d.accel;
    if (d.gyro) this._state.imu_gyro = d.gyro;
    if (d.mag) this._state.imu_mag = d.mag;
    this._state.imu_vibration = [
      Math.abs(this._state.imu_accel[0]) > 30 ? 1 : 0,
      Math.abs(this._state.imu_accel[1]) > 30 ? 1 : 0,
      Math.abs(this._state.imu_accel[2]) > 30 ? 1 : 0,
    ];
  }

  _applyPressure(d) {
    this._state.pressure_hpa = d.pressure_hpa;
    this._state.temperature_c = d.temperature_c;
    const sea_hpa = 1013.25;
    this._state.baro_alt_m = ((Math.pow(sea_hpa / d.pressure_hpa, 1 / 5.257) - 1) * (this._state.temperature_c + 273.15)) / 0.0065;
  }

  _applyAttitude(d) {
    this._state.roll_deg = d.roll_deg;
    this._state.pitch_deg = d.pitch_deg;
    this._state.yaw_deg = (d.yaw_deg + 360) % 360;
    this._state.roll_rate_dps = this._radToDeg(d.roll_rate);
    this._state.pitch_rate_dps = this._radToDeg(d.pitch_rate);
    this._state.yaw_rate_dps = this._radToDeg(d.yaw_rate);
  }

  _applyGlobalPosition(d) {
    this._state.lat = d.lat;
    this._state.lon = d.lon;
    this._state.alt_msl_m = d.alt_msl_mm / 1000;
    this._state.alt_rel_m = d.alt_rel_mm / 1000;
    this._state.ground_speed_m_s = Math.hypot(d.vx_cm_s, d.vy_cm_s) / 100;
    this._state.vertical_speed_m_s = -d.vz_cm_s / 100;
    this._state.heading_deg = d.heading;
  }

  _applyHud(d) {
    if (typeof d.airspeed_m_s === 'number') this._state.air_speed_m_s = d.airspeed_m_s;
    if (typeof d.groundspeed_m_s === 'number') this._state.ground_speed_m_s = d.groundspeed_m_s;
    if (typeof d.heading === 'number') this._state.heading_deg = d.heading;
    if (typeof d.alt_m === 'number') this._state.alt_rel_m = d.alt_m;
    if (typeof d.climb_m_s === 'number') this._state.vertical_speed_m_s = d.climb_m_s;
    if (typeof d.throttle === 'number') this._state.throttle_pct = Math.round((d.throttle / 100) * 100);
  }

  _applyMission(d) {
    this._state.mission.current = d.seq;
    this._state.current_waypoint = d.seq;
    this._state.mission.running = d.seq < (this._state.total_waypoints || 1);
    this._state.mission.completed = d.seq >= (this._state.total_waypoints || 1);
    if (this._state.total_waypoints > 0) {
      this._state.distance_to_next_m = Math.max(0, Math.round(this._state.distance_to_home_m * (1 - d.seq / Math.max(1, this._state.total_waypoints))));
    }
    if (this._state.ground_speed_m_s > 0.5) {
      this._state.eta_to_waypoint_s = Math.round(this._state.distance_to_next_m / this._state.ground_speed_m_s);
    }
  }

  _applyRadio(d) {
    this._state.rssi = d.rssi;
    this._state.remrssi = d.remrssi;
    this._state.noise = d.noise;
    this._state.remnoise = d.remnoise;
    this._state.rxerrors = d.rxerrors;
    this._state.link_quality = Math.max(0, Math.min(100, Math.round(((255 - d.noise) / 255) * 100)));
  }

  _applyBattery(d) {
    if (typeof d.current === 'number') this._state.battery_current_a = d.current;
    if (typeof d.consumed_mah === 'number') this._state.battery_consumed_mah = d.consumed_mah;
    if (typeof d.voltage_v === 'number') this._state.battery_voltage_v = d.voltage_v;
    if (typeof d.temperature_c === 'number') this._state.battery_temp_c = d.temperature_c;
    if (typeof d.remaining_pct === 'number') this._state.battery_remaining_pct = d.remaining_pct;
  }

  _applyHome(d) {
    this._state.home = { lat: d.lat, lon: d.lon, alt_m: d.alt_m };
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  _bearing(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const λ1 = toRad(lon1);
    const λ2 = toRad(lon2);
    const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
      Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
  }

  _radToDeg(r) { return r * 57.2957795; }
}

module.exports = TelemetryStore;
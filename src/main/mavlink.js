'use strict';

/*
 * Lightweight MAVLink v1/v2 decoder for ArduPilot.
 *
 * Implements framing to pull fields used by the GCS
 * panels from HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT, GPS_RAW_INT,
 * SYS_STATUS, VFR_HUD, MISSION_CURRENT, MISSION_REQUEST,
 * MISSION_ITEM_REACHED, RADIO_STATUS, RAW_IMU, HIL_GPS, SCALED_PRESSURE,
 * BATTERY_STATUS and HOME_POSITION messages.
 */

const MAV_TYPES = {
  0: 'GENERIC', 1: 'FIXED_WING', 2: 'QUADROTOR', 3: 'COAXIAL', 4: 'HELICOPTER',
  6: 'AIRSHIP', 10: 'GROUND_ROVER', 11: 'SURFACE_BOAT', 12: 'SUBMARINE',
  13: 'HEXAROTOR', 14: 'OCTOROTOR', 15: 'TRICOPTER', 16: 'FLAPPING_WING',
  17: 'KITE', 18: 'ONBOARD_CONTROLLER', 19: 'VTOL_TAILSITTER_DUOROTOR',
  20: 'VTOL_TAILSITTER_QUADROTOR', 21: 'VTOL_TILTROTOR', 22: 'VTOL_FIXEDROTOR',
  23: 'VTOL_TAILSITTER', 24: 'VTOL_TILTWING', 25: 'VTOL_RESERVED5',
};

const COPTER_MODES = new Proxy({
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  9: 'LAND',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
  25: 'SYSTEMID',
  26: 'AUTOROTATE',
  27: 'AUTOROTATE',
}, {
  get(target, key) {
    if (key in target) return target[key];
    return `MODE_${key}`;
  },
});

const SYS_STATE = {
  0: 'UNINIT', 1: 'BOOTING', 2: 'CALIBRATING', 3: 'STANDBY', 4: 'ACTIVE',
  5: 'CRITICAL', 6: 'EMERGENCY', 7: 'POWEROFF', 8: 'FLIGHT_TERMINATION',
};

const FIX = { 0: 'NO_GPS', 1: 'NO_FIX', 2: '2D_FIX', 3: '3D_FIX', 4: 'DGPS', 5: 'RTK_FLOAT', 6: 'RTK_FIXED', 7: 'STATIC', 8: 'PPP' };

const MAV_DIALECT = {
  0: 0, // HEARTBEAT
  1: 1, // SYS_STATUS
  24: 24, // GPS_RAW_INT
  27: 27, // RAW_IMU
  28: 28, // MISSION_REQUEST
  29: 29, // SCALED_PRESSURE
  30: 30, // ATTITUDE
  32: 32, // LOCAL_POSITION_NED
  33: 33, // GLOBAL_POSITION_INT
  35: 35, // RC_CHANNELS_RAW
  36: 36, // MISSION_ITEM_REACHED
  42: 42, // MISSION_CURRENT
  43: 43, // MISSION_REQUEST_LIST
  44: 44, // MISSION_ITEM
  51: 51, // MISSION_REQUEST_INT
  65: 65, // RC_CHANNELS
  73: 73, // MANUAL_CONTROL
  74: 74, // VFR_HUD
  109: 109, // RADIO_STATUS
  113: 113, // HIL_GPS
  116: 116, // SCALED_IMU2
  124: 124, // GPS2_RAW
  129: 129, // SCALED_IMU3
  147: 147, // BATTERY_STATUS
  241: 241, // VIBRATION
  242: 242, // HOME_POSITION
};

class MAVLink {
  constructor({ onMessage } = {}) {
    this._onMessage = onMessage || (() => {});
    this._buffer = Buffer.alloc(0);
  }

  parse(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 8) {
      const packet = this._consumePacket();
      if (!packet) break;
      this._onMessage(packet);
    }
  }

  _consumePacket() {
    const b = this._buffer;
    let startIdx = -1;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0xfe || b[i] === 0xfd) { startIdx = i; break; }
    }
    if (startIdx < 0) {
      this._buffer = Buffer.alloc(0);
      return null;
    }
    if (startIdx > 0) this._buffer = b.slice(startIdx);

    const magic = this._buffer[0];
    let headerLen, payloadLen, incompatFlags = 0, compatFlags = 0, seq, sysId, compId, msgId;
    let offset;
    if (magic === 0xfe) {
      // MAVLink v1
      if (this._buffer.length < 6) return null;
      payloadLen = this._buffer[1];
      seq = this._buffer[2];
      sysId = this._buffer[3];
      compId = this._buffer[4];
      msgId = this._buffer[5];
      headerLen = 6;
      offset = 6;
    } else {
      // MAVLink v2
      if (this._buffer.length < 12) return null;
      payloadLen = this._buffer[1];
      incompatFlags = this._buffer[2];
      compatFlags = this._buffer[3];
      seq = this._buffer[4];
      sysId = this._buffer[5];
      compId = this._buffer[6];
      msgId = this._buffer.readUInt16LE(7);
      headerLen = 10;
      offset = 10;
    }

    if (payloadLen > 255) {
      this._buffer = this._buffer.slice(1);
      return this._consumePacket();
    }

    const total = headerLen + payloadLen + 2; // + CRC
    if (this._buffer.length < total) {
      return null;
    }

    const payload = this._buffer.slice(offset, offset + payloadLen);
    const beforeDecode = this._buffer;

    let decoded;
    try {
      decoded = this._decode(msgId, payload);
    } catch (err) {
      console.warn(`[mavlink] decode failed for msgId=${msgId} len=${payloadLen}: ${err.message}`);
      this._buffer = beforeDecode.slice(1);
      return this._consumePacket();
    }

    this._buffer = beforeDecode.slice(total);

    return {
      magic, seq, sysId, compId, msgId,
      incompatFlags, compatFlags,
      payload,
      name: this._name(msgId),
      decoded,
    };
  }

  _name(id) {
    return MAV_DIALECT[id] !== undefined ? `MSG_${id}` : `UNKNOWN_${id}`;
  }

  _decode(msgId, p) {
    switch (msgId) {
      case 0: return this._heartbeat(p);
      case 1: return this._sysStatus(p);
      case 24:
      case 113:
      case 124: return this._gpsRaw(p);
      case 27: return this._rawImu(p);
      case 28: return { seq: p.length >= 2 ? p.readUInt16LE(0) : 0 };
      case 29: return this._scaledPressure(p);
      case 30: return this._attitude(p);
      case 33: return this._globalPosition(p);
      case 36: return { seq: p.length >= 2 ? p.readUInt16LE(0) : 0 };
      case 42: return { seq: p.length >= 2 ? p.readUInt16LE(0) : 0, total: null };
      case 65: return this._rcChannels(p);
      case 74: return this._vfrHud(p);
      case 109: return this._radio(p);
      case 147: return this._battery(p);
      case 241: return this._vibration(p);
      case 242: return this._home(p);
      default: return { raw: p };
    }
  }

  _heartbeat(p) {
    if (!p || p.length < 6) return { raw: p };
    return {
      custom_mode: p.length >= 4 ? p.readUInt32LE(0) : 0,
      type: p.length >= 5 ? (MAV_TYPES[p[4]] || `TYPE_${p[4]}`) : 'GENERIC',
      autopilot: p.length >= 6 ? p[5] : 0,
      base_mode: p.length >= 7 ? p[6] : 0,
      system_status: p.length >= 8 ? (SYS_STATE[p[7]] || `STATE_${p[7]}`) : 'UNINIT',
      mavlink_version: p.length >= 9 ? p[8] : 0,
      armed: p.length >= 7 ? !!(p[6] & 0x80) : false,
      flight_mode: p.length >= 4 ? (COPTER_MODES[p.readUInt32LE(0)] || 'UNKNOWN') : 'UNKNOWN',
    };
  }

  _sysStatus(p) {
    if (!p || p.length < 14) return { raw: p };
    return {
      load: p.length >= 14 ? p.readUInt16LE(12) / 10 : 0,
      voltage_v: p.length >= 16 ? p.readUInt16LE(14) / 1000 : 0,
      current_a: p.length >= 18 ? p.readInt16LE(16) / 100 : 0,
      remaining_pct: p.length >= 19 ? p.readInt8(18) : -1,
      drop_vcomm: p.length >= 21 ? p.readUInt16LE(19) : 0,
      errors_comm: p.length >= 23 ? p.readUInt16LE(21) : 0,
    };
  }

  _gpsRaw(p) {
    if (!p || p.length < 18) return { raw: p };
    const ephVal = p.length >= 23 ? p.readUInt16LE(21) : 65535;
    const epvVal = p.length >= 25 ? p.readUInt16LE(23) : 65535;
    const velVal = p.length >= 27 ? p.readUInt16LE(25) : 65535;
    const cogVal = p.length >= 29 ? p.readUInt16LE(27) : 65535;
    const lat = p.length >= 13 ? p.readInt32LE(9) / 1e7 : 0;
    const lon = p.length >= 17 ? p.readInt32LE(13) / 1e7 : 0;
    if (lat < -85.0511 || lat > 85.0511 || lon < -180 || lon > 180) return { raw: p };
    return {
      fix: p.length >= 9 ? (FIX[p[8]] || 'UNKNOWN') : 'UNKNOWN',
      sats: p.length >= 30 ? p[29] : 0,
      lat,
      lon,
      alt_mm: p.length >= 21 ? p.readInt32LE(17) : 0,
      eph: ephVal === 65535 ? 99 : ephVal / 100,
      epv: epvVal === 65535 ? 99 : epvVal / 100,
      vel_cm_s: velVal === 65535 ? 0 : velVal / 100,
      cog: cogVal === 65535 ? 0 : cogVal / 100,
    };
  }

  _rawImu(p) {
    if (!p || p.length < 18) return { raw: p };
    const result = {
      accel: [p.readInt16LE(0) / 1000, p.readInt16LE(2) / 1000, p.readInt16LE(4) / 1000],
      gyro: [p.readInt16LE(6) / 1000, p.readInt16LE(8) / 1000, p.readInt16LE(10) / 1000],
      mag: [p.readInt16LE(12) / 1000, p.readInt16LE(14) / 1000, p.readInt16LE(16) / 1000],
    };
    if (p.length >= 20) {
      const rawTemp = p.readInt16LE(18);
      if (rawTemp !== 0x7fff && rawTemp !== -32768) {
        result.temperature_c = rawTemp / 100;
      }
    }
    return result;
  }

  _scaledPressure(p) {
    if (!p || p.length < 14) return { raw: p };
    return {
      pressure_hpa: p.readFloatLE(4),
      diff_pressure: p.readFloatLE(8),
      temperature_c: p.readInt16LE(12) / 100,
    };
  }

  _attitude(p) {
    if (!p || p.length < 28) return { raw: p };
    return {
      roll_deg: this._radToDeg(p.readFloatLE(4)),
      pitch_deg: this._radToDeg(p.readFloatLE(8)),
      yaw_deg: this._radToDeg(p.readFloatLE(12)),
      roll_rate: p.readFloatLE(16),
      pitch_rate: p.readFloatLE(20),
      yaw_rate: p.readFloatLE(24),
    };
  }

  _globalPosition(p) {
    if (!p || p.length < 28) return { raw: p };
    const lat = p.readInt32LE(4) / 1e7;
    const lon = p.readInt32LE(8) / 1e7;
    if (lat < -85.0511 || lat > 85.0511 || lon < -180 || lon > 180) return { raw: p };
    return {
      lat,
      lon,
      alt_msl_mm: p.readInt32LE(12),
      alt_rel_mm: p.readInt32LE(16),
      vx_cm_s: p.readInt16LE(20),
      vy_cm_s: p.readInt16LE(22),
      vz_cm_s: p.readInt16LE(24),
      heading: p.readUInt16LE(26) / 100,
    };
  }

  _rcChannels(p) {
    if (!p || p.length < 2) return { raw: p };
    return {
      chan1: p.length >= 2 ? p.readUInt16LE(0) : 0,
      chan2: p.length >= 4 ? p.readUInt16LE(2) : 0,
      chan3: p.length >= 6 ? p.readUInt16LE(4) : 0,
      chan4: p.length >= 8 ? p.readUInt16LE(6) : 0,
      chan5: p.length >= 10 ? p.readUInt16LE(8) : 0,
      chan6: p.length >= 12 ? p.readUInt16LE(10) : 0,
      chan7: p.length >= 14 ? p.readUInt16LE(12) : 0,
      chan8: p.length >= 16 ? p.readUInt16LE(14) : 0,
      rssi: p.length >= 21 ? p[20] : 0,
    };
  }

  _vfrHud(p) {
    if (!p || p.length < 16) return { raw: p };
    return {
      airspeed_m_s: p.readFloatLE(0),
      groundspeed_m_s: p.readFloatLE(4),
      alt_m: p.readFloatLE(8),
      climb_m_s: p.readFloatLE(12),
      heading: p.length >= 18 ? p.readInt16LE(16) : 0,
      throttle: p.length >= 20 ? p.readUInt16LE(18) : 0,
    };
  }

  _radio(p) {
    if (!p || p.length < 8) return { raw: p };
    return {
      rssi: p[0],
      remrssi: p[1],
      txbuf: p[2],
      noise: p[3],
      remnoise: p[4],
      rxerrors: p.length >= 7 ? p.readUInt16LE(5) : 0,
      fixed: p.length >= 8 ? p[7] : 0,
    };
  }

  _vibration(p) {
    if (!p || p.length < 20) return { raw: p };
    return {
      vibration_x: p.readFloatLE(8),
      vibration_y: p.readFloatLE(12),
      vibration_z: p.readFloatLE(16),
    };
  }

  _battery(p) {
    if (!p || p.length < 4) return { raw: p };
    const cells = [];
    if (p.length >= 24) {
      for (let i = 0; i < 10; i++) {
        if (4 + i * 2 + 1 < p.length) {
          const v = p.readUInt16LE(4 + i * 2);
          if (v === 0xffff || v === 0) continue;
          cells.push(v / 1000);
        }
      }
    }
    const result = {
      current: p.length >= 2 ? p.readInt16LE(0) / 100 : 0,
      consumed_mah: p.length >= 4 ? p.readUInt16LE(2) : 0,
      cell_volts_v: cells,
    };
    if (p.length >= 28) result.remaining_pct = p.readInt8(27);
    return result;
  }

  _home(p) {
    if (!p || p.length < 12) return { raw: p };
    return {
      lat: p.readInt32LE(0) / 1e7,
      lon: p.readInt32LE(4) / 1e7,
      alt_mm: p.readInt32LE(8),
    };
  }

  _radToDeg(rad) {
    return (rad * 180) / Math.PI;
  }
}

module.exports = MAVLink;
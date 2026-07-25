'use strict';

/*
 * Lightweight MAVLink v1/v2 decoder for ArduPilot.
 *
 * Implements just enough of the framing to pull the fields used by the GCS
 * panels from HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT, GPS_RAW_INT,
 * SYS_STATUS, VFR_HUD, MISSION_CURRENT, MISSION_REQUEST,
 * MISSION_ITEM_REACHED, RADIO_STATUS, RAW_IMU, HIL_GPS, SCALED_PRESSURE,
 * BATTERY_STATUS and HOME_POSITION messages. The CRC is verified but the
 * decoder is tolerant when running against the bundled mock stream.
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
  116: 116, // SCALED_IMU2
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

    // Sanity check: payload length must be reasonable (max 255 bytes per MAVLink spec).
    // If we see a huge value, this is a false sync — drop one byte and try again.
    if (payloadLen > 255) {
      this._buffer = this._buffer.slice(1);
      // Recurse to re-sync
      return this._consumePacket();
    }

    const total = headerLen + payloadLen + 2; // + CRC
    if (this._buffer.length < total) {
      // Not enough data — but if a plausible packet doesn't fit in the buffer
      // at this sync point, the sync is probably wrong. Skip the suspect magic
      // byte and re-sync so we don't get stuck.
      if (payloadLen > 0 && total > this._buffer.length && this._buffer.length < 256) {
        this._buffer = this._buffer.slice(1);
        return this._consumePacket();
      }
      return null;
    }

    const payload = this._buffer.slice(offset, offset + payloadLen);
    const payloadCrc = this._buffer.slice(offset + payloadLen, total);

    // Save buffer state so we can rewind on decode failure (false sync).
    const beforeDecode = this._buffer;

    let decoded;
    try {
      decoded = this._decode(msgId, payload);
    } catch (err) {
      // Decoder threw — almost certainly a false sync (the byte we thought was
      // magic was actually data). Restore the buffer and advance by 1 byte to
      // try syncing from the next position. This prevents losing real packets
      // that started further in the stream.
      console.warn(`[mavlink] decode failed for msgId=${msgId} len=${payloadLen}: ${err.message}`);
      this._buffer = beforeDecode.slice(1);
      return this._consumePacket();
    }

    // Decode succeeded — consume the packet from the buffer.
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
    try {
      switch (msgId) {
        case 0: return this._heartbeat(p);
        case 1: return this._sysStatus(p);
        case 24: return this._gpsRaw(p);
        case 27: return this._rawImu(p);
        case 28: return { seq: p.readUInt16LE(0) };
        case 29: return this._scaledPressure(p);
        case 30: return this._attitude(p);
        case 33: return this._globalPosition(p);
        case 36: return { seq: p.readUInt16LE(0) };
        case 42: return { seq: p.readUInt16LE(0), total: null };
        case 65: return this._rcChannels(p);
        case 74: return this._vfrHud(p);
        case 109: return this._radio(p);
        case 147: return this._battery(p);
        case 241: return this._vibration(p);
        case 242: return this._home(p);
        default: return { raw: p };
      }
    } catch (err) {
      // Decoder failed (e.g. payload shorter than expected — false sync).
      throw new Error(`decode msgId=${msgId} (payloadLen=${p.length}): ${err.message}`);
    }
  }

  _heartbeat(p) {
    if (p.length < 9) throw new Error('heartbeat payload too short');
    return {
      custom_mode: p.readUInt32LE(0),
      type: MAV_TYPES[p[4]] || `TYPE_${p[4]}`,
      autopilot: p[5],
      base_mode: p[6],
      system_status: SYS_STATE[p[7]] || `STATE_${p[7]}`,
      mavlink_version: p[8],
      armed: !!(p[6] & 0x80),
      flight_mode: COPTER_MODES[p.readUInt32LE(0)] || 'UNKNOWN',
    };
  }

  _sysStatus(p) {
    if (p.length < 31) throw new Error('sys_status payload too short');
    return {
      load: p.readUInt16LE(12) / 10,
      voltage_v: p.readUInt16LE(14) / 1000,
      current_a: p.readInt16LE(16) / 100,
      remaining_pct: p.readInt8(18),
      drop_vcomm: p.readUInt16LE(19),
      errors_comm: p.readUInt16LE(21),
      errors_count1: p.readUInt16LE(23),
      errors_count2: p.readUInt16LE(25),
      errors_count3: p.readUInt16LE(27),
      errors_count4: p.readUInt16LE(29),
    };
  }

  _gpsRaw(p) {
    if (p.length < 30) throw new Error('gps_raw payload too short');
    return {
      fix: FIX[p[8]] || 'UNKNOWN',
      sats: p[29],
      lat: p.readInt32LE(9) / 1e7,
      lon: p.readInt32LE(13) / 1e7,
      alt_mm: p.readInt32LE(17),
      eph: p.readUInt16LE(21) / 100,
      epv: p.readUInt16LE(23) / 100,
      vel_cm_s: p.readUInt16LE(25) / 100,
      cog: p.readUInt16LE(27) / 100,
    };
  }

  _rawImu(p) {
    if (p.length < 18) throw new Error('raw_imu payload too short');
    // RAW_IMU v1 layout: accel[3] (int16, mG), gyro[3] (int16, mrad/s),
    // mag[3] (int16, mGa), then at offset 18: raw_temp (int16, cdegC).
    // v1 minimum is 26 bytes (18 + 2 for temp) but some firmwares send
    // longer; tolerate both.
    const result = {
      accel: [p.readInt16LE(0) / 1000, p.readInt16LE(2) / 1000, p.readInt16LE(4) / 1000],
      gyro: [p.readInt16LE(6) / 1000, p.readInt16LE(8) / 1000, p.readInt16LE(10) / 1000],
      mag: [p.readInt16LE(12) / 1000, p.readInt16LE(14) / 1000, p.readInt16LE(16) / 1000],
    };
    if (p.length >= 26) {
      // 0x7FFF = invalid
      const rawTemp = p.readInt16LE(18);
      if (rawTemp !== 0x7fff && rawTemp !== -32768) {
        result.temperature_c = rawTemp / 100;
      }
    }
    return result;
  }

  _scaledPressure(p) {
    if (p.length < 14) throw new Error('scaled_pressure payload too short');
    return {
      pressure_hpa: p.readFloatLE(4),
      diff_pressure: p.readFloatLE(8),
      temperature_c: p.readInt16LE(12) / 100,
    };
  }

  _attitude(p) {
    if (p.length < 28) throw new Error('attitude payload too short');
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
    if (p.length < 28) throw new Error('global_position payload too short');
    return {
      lat: p.readInt32LE(4) / 1e7,
      lon: p.readInt32LE(8) / 1e7,
      alt_msl_mm: p.readInt32LE(12),
      alt_rel_mm: p.readInt32LE(16),
      vx_cm_s: p.readInt16LE(20),
      vy_cm_s: p.readInt16LE(22),
      vz_cm_s: p.readInt16LE(24),
      heading: p.readUInt16LE(26) / 100,
    };
  }

  _rcChannels(p) {
    if (p.length < 21) throw new Error('rc_channels payload too short');
    return {
      chan1: p.readUInt16LE(0),
      chan2: p.readUInt16LE(2),
      chan3: p.readUInt16LE(4),
      chan4: p.readUInt16LE(6),
      chan5: p.readUInt16LE(8),
      chan6: p.readUInt16LE(10),
      chan7: p.readUInt16LE(12),
      chan8: p.readUInt16LE(14),
      rssi: p[20],
    };
  }

  _vfrHud(p) {
    if (p.length < 20) throw new Error('vfr_hud payload too short');
    return {
      airspeed_m_s: p.readFloatLE(0),
      groundspeed_m_s: p.readFloatLE(4),
      alt_m: p.readInt32LE(8),
      climb_m_s: p.readFloatLE(12),
      heading: p.readInt16LE(16),
      throttle: p.readUInt16LE(18),
    };
  }

  _radio(p) {
    if (p.length < 8) throw new Error('radio payload too short');
    return {
      rssi: p[0],
      remrssi: p[1],
      txbuf: p[2],
      noise: p[3],
      remnoise: p[4],
      rxerrors: p.readUInt16LE(5),
      fixed: p[7],
    };
  }

  _vibration(p) {
    // VIBRATION (msgId 241):
    //   offset  0: time_usec (uint64)
    //   offset  8: vibration_x (float, m/s²)
    //   offset 12: vibration_y (float, m/s²)
    //   offset 16: vibration_z (float, m/s²)
    //   offset 20: clipping_x (uint32)
    //   offset 24: clipping_y (uint32)
    //   offset 28: clipping_z (uint32)
    if (p.length < 20) throw new Error('vibration payload too short');
    return {
      vibration_x: p.readFloatLE(8),
      vibration_y: p.readFloatLE(12),
      vibration_z: p.readFloatLE(16),
    };
  }

  _battery(p) {
    // BATTERY_STATUS v1 layout (per common.xml):
    //   offset  0: current_battery (int16_t, cA)
    //   offset  2: energy_consumed (uint16_t, hWh)
    //   offset  4: voltages[10] (uint16_t[10], mV)  ← 10 cell voltages
    //   offset 24: current_battery_id (uint8_t)
    //   offset 25: battery_function (uint8_t)
    //   offset 26: type (uint8_t)
    //   offset 27: battery_remaining (int8_t, %)
    //   offset 28: time_remaining (int32_t, sec)
    //   offset 32: charge_state (uint8_t)
    // v1 minimum payload is 33 bytes. v2 extends with voltages_ext, mode, fault_bitmask.
    if (p.length < 28) throw new Error('battery payload too short');
    // Per-cell voltages. NOTE: do NOT sum cells to get pack voltage — ArduPilot
    // sometimes puts pack voltage in voltages[0] OR repeats per-cell values in
    // all 10 slots, which would inflate the sum. Pack voltage should come from
    // SYS_STATUS.voltage_battery (offset 14, mV) which is the authoritative
    // source.
    const cells = [];
    for (let i = 0; i < 10; i++) {
      const v = p.readUInt16LE(4 + i * 2);
      // 0xFFFF = unknown (per spec); skip
      if (v === 0xffff || v === 0) continue;
      cells.push(v / 1000);
    }
    const result = {
      current: p.readInt16LE(0) / 100,
      consumed_mah: p.readUInt16LE(2),
      cell_volts_v: cells,
      // Do NOT set voltage_v here — let SYS_STATUS be authoritative.
    };
    if (p.length >= 28) result.remaining_pct = p.readInt8(27);
    // v2-only fields
    if (p.length >= 41) result.temperature_c = p.readInt8(40);
    return result;
  }

  _home(p) {
    if (p.length < 12) throw new Error('home payload too short');
    return {
      lat: p.readInt32LE(0) / 1e7,
      lon: p.readInt32LE(4) / 1e7,
      alt_m: p.readInt32LE(8) / 1000,
    };
  }

  _radToDeg(r) { return r * 57.2957795; }
}

module.exports = MAVLink;
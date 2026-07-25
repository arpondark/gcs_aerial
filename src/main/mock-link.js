'use strict';

const { EventEmitter } = require('node:events');

// Build a small demo mission around the mock position so the map has
// something to draw even before the user flies anything.
const HOME_LAT = 23.7806;
const HOME_LON = 90.4074;
function buildMission() {
  // Square survey pattern, ~120 m sides, 30 m altitude.
  const off = 0.001; // ~110 m at this latitude
  return [
    { lat: HOME_LAT, lon: HOME_LON, alt: 30, name: 'Home' },
    { lat: HOME_LAT + off, lon: HOME_LON, alt: 30, name: 'Takeoff' },
    { lat: HOME_LAT + off, lon: HOME_LON + off, alt: 30, name: 'WP3' },
    { lat: HOME_LAT, lon: HOME_LON + off, alt: 30, name: 'WP4' },
    { lat: HOME_LAT, lon: HOME_LON, alt: 0, name: 'Land' },
  ];
}

class MockLink extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._t0 = 0;
    this._path = 'MOCK';
    this._seq = 0;
    this._mission = buildMission();
  }

  async open() {
    this._t0 = Date.now();
    this.emit('status', { connected: true, path: this._path, baud: 0 });
    this._timer = setInterval(() => this._tick(), 100);
    // Push mission + traffic once on connect so the map populates immediately.
    setTimeout(() => {
      this.emit('mission', this._mission);
      this.emit('adsb', this._adsbSnapshot(0));
    }, 200);
  }

  _adsbSnapshot(t) {
    // Two friendly synthetic aircraft orbiting the home position so the
    // "other aircraft" overlay has something to draw.
    return [
      {
        callsign: 'BGD-101',
        type: 'adsb',
        lat: HOME_LAT + 0.003 + 0.0008 * Math.sin(t * 0.2),
        lon: HOME_LON + 0.001 + 0.0006 * Math.cos(t * 0.2),
        alt: 320,
        speed: 28,
        heading: ((t * 6) % 360),
        friendly: false,
      },
      {
        callsign: 'UIU-2',
        type: 'uav',
        lat: HOME_LAT - 0.0015 + 0.0004 * Math.cos(t * 0.5),
        lon: HOME_LON + 0.0022 + 0.0004 * Math.sin(t * 0.5),
        alt: 65,
        speed: 9,
        heading: ((t * 30) % 360),
        friendly: true,
      },
    ];
  }

  _tick() {
    const t = (Date.now() - this._t0) / 1000;
    this.emit('data', this._heartbeat(t));
    this.emit('data', this._attitude(t));
    this.emit('data', this._globalPosition(t));
    if (Math.floor(t * 10) % 5 === 0) {
      this.emit('data', this._gps(t));
      this.emit('data', this._sysStatus(t));
      this.emit('data', this._vfrHud(t));
      this.emit('data', this._missionFrame(t));
      this.emit('data', this._radio(t));
      this.emit('data', this._pressure(t));
      this.emit('adsb', this._adsbSnapshot(t));
    }
  }

  _frame(payload, msgId) {
    const header = Buffer.from([
      0xfe,
      payload.length,
      this._seq++ & 0xff,
      1, // system id
      1, // component id
      msgId & 0xff,
    ]);
    // Two CRC trailer bytes; the lightweight decoder ignores them.
    return Buffer.concat([header, payload, Buffer.from([0, 0])]);
  }

  _heartbeat(t) {
    // custom_mode(4) + type(1) + autopilot(1) + base_mode(1) + system_status(1) + mavlink_version(1) = 9
    const p = Buffer.alloc(9);
    p.writeUInt32LE(4, 0);  // GUIDED
    p.writeUInt8(2, 4);    // MAV_TYPE_QUADROTOR
    p.writeUInt8(3, 5);    // MAV_AUTOPILOT_ARDUPILOTMEGA
    p.writeUInt8(0x81, 6); // base_mode: armed + custom mode enabled
    p.writeUInt8(4, 7);    // MAV_STATE_ACTIVE
    p.writeUInt8(3, 8);    // MAVLink v2
    return this._frame(p, 0);
  }

  _attitude(t) {
    // time_boot_ms(4) + roll/pitch/yaw/rate/rate/rate floats = 28
    const p = Buffer.alloc(28);
    p.writeUInt32LE(Math.round(t * 1000), 0);
    p.writeFloatLE(0.14 * Math.sin(t * 0.7), 4);
    p.writeFloatLE(0.08 * Math.cos(t * 0.5), 8);
    p.writeFloatLE(((t * 20) % 360) * Math.PI / 180, 12);
    p.writeFloatLE(0.1 * Math.cos(t * 0.7), 16);
    p.writeFloatLE(-0.04 * Math.sin(t * 0.5), 20);
    p.writeFloatLE(0.35, 24);
    return this._frame(p, 30);
  }

  _globalPosition(t) {
    // 28 bytes
    const p = Buffer.alloc(28);
    p.writeUInt32LE(Math.round(t * 1000), 0);
    p.writeInt32LE(Math.round((23.7806 + Math.sin(t * 0.05) * 0.0008) * 1e7), 4);
    p.writeInt32LE(Math.round((90.4074 + Math.cos(t * 0.05) * 0.0008) * 1e7), 8);
    p.writeInt32LE(Math.round((50 + Math.sin(t * 0.2) * 10) * 1000), 12);
    p.writeInt32LE(Math.round((20 + Math.sin(t * 0.2) * 8) * 1000), 16);
    p.writeInt16LE(Math.round(1450 + Math.sin(t) * 50), 20);
    p.writeInt16LE(Math.round(Math.cos(t) * 50), 22);
    p.writeInt16LE(Math.round(-Math.sin(t * 0.4) * 35), 24);
    p.writeUInt16LE(Math.round(((t * 20) % 360) * 100), 26);
    return this._frame(p, 33);
  }

  _gps(t) {
    // 30 bytes base (no MAVLink 2 extensions)
    const p = Buffer.alloc(30);
    p.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 0);
    p.writeUInt8(3, 8); // fix_type = 3D_FIX
    p.writeInt32LE(Math.round(23.7806 * 1e7), 9);
    p.writeInt32LE(Math.round(90.4074 * 1e7), 13);
    p.writeInt32LE(50000, 17);
    p.writeUInt16LE(85, 21);
    p.writeUInt16LE(120, 23);
    p.writeUInt16LE(1450, 25);
    p.writeUInt16LE(Math.round(((t * 20) % 360) * 100), 27);
    p.writeUInt8(14, 29);
    return this._frame(p, 24);
  }

  _sysStatus(t) {
    // 31 bytes base
    const p = Buffer.alloc(31);
    p.writeUInt32LE(0xffffffff, 0);
    p.writeUInt32LE(0xffffffff, 4);
    p.writeUInt32LE(0, 8);
    p.writeUInt16LE(450, 12);     // load 45.0%
    p.writeUInt16LE(Math.max(9800, 12100 - Math.round(t * 3)), 14); // mV
    p.writeInt16LE(460, 16);      // 4.6 A in cA
    p.writeInt8(Math.max(0, Math.round(87 - t * 0.08)), 18); // %
    return this._frame(p, 1);
  }

  _vfrHud(t) {
    // 20 bytes
    const p = Buffer.alloc(20);
    p.writeFloatLE(14.7 + Math.sin(t * 0.3) * 0.5, 0);
    p.writeFloatLE(14.5 + Math.cos(t * 0.3) * 0.4, 4);
    p.writeInt16LE(Math.round((t * 20) % 360), 8);
    p.writeUInt16LE(52, 10);
    p.writeFloatLE(20 + Math.sin(t * 0.2) * 8, 12);
    p.writeFloatLE(Math.sin(t * 0.5) * 0.4, 16);
    return this._frame(p, 74);
  }

  _missionFrame(t) {
    const p = Buffer.alloc(2);
    p.writeUInt16LE(Math.floor(t / 8) % 6, 0);
    return this._frame(p, 42);
  }

  _radio(t) {
    // 9 bytes
    const p = Buffer.alloc(9);
    p.writeUInt8(Math.round(180 + Math.sin(t * 0.4) * 15), 0); // rssi
    p.writeUInt8(Math.round(170 + Math.cos(t * 0.4) * 12), 1); // remrssi
    p.writeUInt8(95, 2);   // txbuf
    p.writeUInt8(90, 3);   // noise
    p.writeUInt8(80, 4);   // remnoise
    p.writeUInt16LE(0, 5); // rxerrors
    p.writeUInt16LE(0, 7); // fixed
    return this._frame(p, 109);
  }

  _pressure(t) {
    // 14 bytes base
    const p = Buffer.alloc(14);
    p.writeUInt32LE(Math.round(t * 1000), 0);
    p.writeFloatLE(1007.2 + Math.sin(t * 0.2) * 0.4, 4);
    p.writeFloatLE(0.08, 8);
    p.writeInt16LE(2950, 12); // 29.5 C
    return this._frame(p, 29);
  }

  async write() {}
  async close() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.emit('status', { connected: false, path: this._path });
  }
  isOpen() { return !!this._timer; }
  path() { return this._path; }
  baud() { return 0; }
}

module.exports = MockLink;

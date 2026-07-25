'use strict';

const { EventEmitter } = require('node:events');
const portFinder = require('./port-finder');

class SerialLink extends EventEmitter {
  constructor() {
    super();
    this._port = null;
    this._reader = null;
    this._writer = null;
    this._path = null;
    this._baud = 0;
    this._useSerialport = true;
  }

  /**
   * List available serial ports.
   *
   * We first try the native `serialport` package; if it loads but returns
   * an empty list (which can happen on some Electron + N-API combinations),
   * or if it fails to load at all, we fall back to a pure-JS enumerator
   * (WMI on Windows, /dev on POSIX).
   */
  static async list() {
    let ports = [];
    let error = null;

    try {
      const { SerialPort } = require('serialport');
      const list = await SerialPort.list();
      ports = list.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        productId: p.productId || '',
        vendorId: p.vendorId || '',
        friendlyName: p.friendlyName || p.path,
        pnpId: p.pnpId || '',
        serialNumber: p.serialNumber || '',
      }));
    } catch (err) {
      error = 'serialport load failed: ' + (err && err.message ? err.message : String(err));
    }

    // Always augment (or replace) with the JS enumerator so the user
    // always sees their USB devices, even when the native binding misbehaves.
    try {
      const fallback = await portFinder.list();
      if (fallback.ok && fallback.ports.length) {
        const seen = new Set(ports.map((p) => p.path));
        for (const p of fallback.ports) {
          if (!p || !p.path) continue;
          if (!seen.has(p.path)) {
            ports.push(p);
            seen.add(p.path);
          }
        }
      } else if (ports.length === 0 && !error) {
        error = fallback.error || 'no ports detected';
      }
    } catch (e) {
      if (!error) error = 'port-finder failed: ' + (e && e.message ? e.message : String(e));
    }

    return { ok: ports.length > 0, ports, error };
  }

  async open({ path: portPath, baudRate = 57600 } = {}) {
    if (!portPath) throw new Error('port path is required');
    const { SerialPort } = require('serialport');
    this._path = portPath;
    this._baud = baudRate;
    this._port = new SerialPort({
      path: portPath,
      baudRate,
      autoOpen: false,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      lock: false,
    });
    await new Promise((resolve, reject) => {
      this._port.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    this.emit('status', { connected: true, path: this._path, baud: this._baud });
    this._port.on('data', (chunk) => this.emit('data', chunk));
    this._port.on('close', () => {
      this.emit('status', { connected: false, path: this._path, baud: this._baud });
    });
    this._port.on('error', (err) => {
      this.emit('status', { connected: false, error: err.message });
    });
  }

  async write(bytes) {
    if (!this._port || !this._port.writable) return;
    return new Promise((resolve, reject) => {
      this._port.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close() {
    if (!this._port) return;
    return new Promise((resolve) => {
      try {
        this._port.close(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  isOpen() {
    return !!this._port && this._port.isOpen;
  }

  path() { return this._path; }
  baud() { return this._baud; }
}

module.exports = SerialLink;
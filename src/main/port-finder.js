'use strict';

const { spawn } = require('node:child_process');
const { execSync } = require('node:child_process');

/**
 * Lightweight, dependency-free enumeration of serial / COM ports.
 *
 * - Windows: query WMI via PowerShell (returns friendlyName, manufacturer,
 *   pnpId, etc. — same fields `serialport` would return).
 * - macOS:   glob /dev/tty.* (excluding the debug consoles).
 * - Linux:   glob /dev/tty* and /dev/serial/by-id/* (when present).
 *
 * Always returns a stable shape: [{ path, manufacturer, friendlyName,
 * vendorId, productId, pnpId, serialNumber }].
 */

function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(cmd, args, { ...opts, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: '', stderr: '' });
      return;
    }
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    proc.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function listWindows() {
  // Query WMI for serial/COM ports. We use CIM instances so we don't depend
  // on the older Win32_SerialPort provider being present.
  const ps = [
    "Get-CimInstance Win32_SerialPort |",
    "Select-Object DeviceID,Name,Description,Manufacturer,PNPDeviceID |",
    "ConvertTo-Json -Compress",
  ].join(' ');
  const result = await execCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!result.ok || !result.stdout) return [];
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return []; }
  if (!parsed) return [];
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed
    .filter((p) => p && p.DeviceID)
    .map((p) => {
      const path = String(p.DeviceID).toUpperCase().startsWith('COM') ? p.DeviceID : null;
      if (!path) return null;
      const pnpId = p.PNPDeviceID || '';
      const vidMatch = pnpId.match(/VID_([0-9A-Fa-f]{4})/);
      const pidMatch = pnpId.match(/PID_([0-9A-Fa-f]{4})/);
      const snMatch = pnpId.match(/\\([0-9A-Za-z]{6,})\\?$/);
      return {
        path,
        manufacturer: p.Manufacturer || '',
        friendlyName: p.Name || p.Description || p.DeviceID,
        vendorId: vidMatch ? vidMatch[1] : '',
        productId: pidMatch ? pidMatch[1] : '',
        serialNumber: snMatch ? snMatch[1] : '',
        pnpId,
      };
    })
    .filter(Boolean);
}

function listPosix() {
  // Used as a fallback only. The real work on Linux/macOS is done by glob below.
  return [];
}

async function listUnix() {
  const { readdir } = require('node:fs/promises');
  const out = [];
  // macOS / Linux serial devices
  const dirs = ['/dev'];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('tty.') || entry.startsWith('ttyUSB') || entry.startsWith('ttyACM')) {
        out.push({
          path: `${dir}/${entry}`,
          friendlyName: entry,
          manufacturer: '',
          vendorId: '',
          productId: '',
        });
      }
    }
  }
  // Linux by-id (pretty friendly names)
  try {
    const entries = await readdir('/dev/serial/by-id');
    for (const e of entries) {
      const target = `/dev/serial/by-id/${e}`;
      // The symlink target is the real /dev/tty* path.
      try {
        const real = execSync(`readlink -f ${target}`).toString().trim();
        if (!out.find((p) => p.path === real)) {
          out.push({ path: real, friendlyName: e, manufacturer: '', vendorId: '', productId: '' });
        }
      } catch { /* ignore */ }
    }
  } catch { /* not linux, or no symlinks */ }
  return out;
}

async function list() {
  try {
    if (process.platform === 'win32') {
      const ports = await listWindows();
      return { ok: true, ports, error: null };
    }
    const ports = await listUnix();
    return { ok: true, ports, error: null };
  } catch (err) {
    return { ok: false, ports: [], error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { list };

// Number formatters, shared across panels.
export const fmt = {
  num: (v, digits = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '—'),
  int: (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v).toString() : '—'),
  lat: (v) => (typeof v === 'number' ? `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(6)}°` : '—'),
  lon: (v) => (typeof v === 'number' ? `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(6)}°` : '—'),
  deg: (v) => (typeof v === 'number' ? `${v.toFixed(1)}°` : '—'),
  m: (v) => (typeof v === 'number' ? `${v.toFixed(1)} m` : '—'),
  ms: (v) => (typeof v === 'number' ? `${v.toFixed(1)} m/s` : '—'),
  v: (v) => (typeof v === 'number' ? `${v.toFixed(2)} V` : '—'),
  a: (v) => (typeof v === 'number' ? `${v.toFixed(2)} A` : '—'),
  w: (v) => (typeof v === 'number' ? `${v.toFixed(1)} W` : '—'),
  pct: (v) => (typeof v === 'number' ? `${v.toFixed(0)}%` : '—'),
  mah: (v) => (typeof v === 'number' ? `${Math.round(v)} mAh` : '—'),
  temp: (v) => (typeof v === 'number' ? `${v.toFixed(1)} °C` : '—'),
  pressure: (v) => (typeof v === 'number' ? `${v.toFixed(1)} hPa` : '—'),
  sat: (v) => (typeof v === 'number' ? `${v}` : '—'),
  ms_time: (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },
};

export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function setState(id, state) {
  const el = document.getElementById(id);
  if (el) el.dataset.state = state;
}

export function setAttr(selector, attr, value) {
  const el = document.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

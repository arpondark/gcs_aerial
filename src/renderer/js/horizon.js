// Artificial horizon (attitude indicator). Uses HTML canvas; rotates the
// ground/sky pair by roll and offsets vertically by pitch.

export class Horizon {
  constructor(canvas) {
    this.canvas = canvas;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this._setup();
    // Re-fit when the layout changes (single-screen layout is fluid).
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._setup());
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => this._setup());
    }
  }
  _setup() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this._ctx = this.canvas.getContext('2d');
    this._ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this._w = rect.width;
    this._h = rect.height;
    this.draw();
  }
  update({ roll_deg, pitch_deg, yaw_deg }) {
    this.roll = roll_deg;
    this.pitch = pitch_deg;
    this.yaw = yaw_deg;
    this.draw();
  }
  draw() {
    const ctx = this._ctx;
    if (!ctx) return;
    const w = this._w;
    const h = this._h;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 6;
    if (r <= 0) return;
    // Scale geometry to radius so a small canvas still looks correct.
    const s = Math.max(0.4, r / 100);

    // Transparent clear so the host div's sky/ground gradient shows through.
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((this.roll * Math.PI) / 180);

    // pitch offset
    const pitchPx = (this.pitch / 90) * r;

    // horizon line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r, pitchPx);
    ctx.lineTo(r, pitchPx);
    ctx.stroke();

    // pitch ticks
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = `${Math.max(7, Math.round(10 * s))}px JetBrains Mono`;
    const tickLen = 20 * s;
    const tickShort = 12 * s;
    for (let p = -30; p <= 30; p += 10) {
      if (p === 0) continue;
      const y = pitchPx + (p / 90) * r;
      ctx.beginPath();
      ctx.moveTo(-tickLen, y);
      ctx.lineTo(tickLen, y);
      ctx.stroke();
      ctx.fillText(`${p}°`, tickLen + 4, y + 3);
      ctx.fillText(`${p}°`, -tickLen - 18, y + 3);
    }
    ctx.restore();

    // aircraft symbol (static on top)
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = Math.max(1.5, 2 * s);
    const wingLen = 38 * s;
    const wingInner = 10 * s;
    const fuse = 6 * s;
    ctx.beginPath();
    ctx.moveTo(cx - wingLen, cy);
    ctx.lineTo(cx - wingInner, cy);
    ctx.moveTo(cx + wingInner, cy);
    ctx.lineTo(cx + wingLen, cy);
    ctx.moveTo(cx, cy - fuse);
    ctx.lineTo(cx, cy + fuse);
    ctx.stroke();

    // outer ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // roll arc + pointer
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(0, 0, r - 14 * s, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.rotate((this.roll * Math.PI) / 180);
    ctx.strokeStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -(r - 14 * s));
    ctx.stroke();
    ctx.restore();

    // heading strip at top — cardinal letters scroll with yaw
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = `${Math.max(8, Math.round(10 * s))}px JetBrains Mono`;
    const headings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    ctx.save();
    ctx.translate(cx, 14 * s);
    const stripR = Math.min(r * 0.55, 60 * s);
    for (let i = 0; i < headings.length; i++) {
      const angle = (i * 45 - this.yaw) * Math.PI / 180;
      const x = Math.sin(angle) * stripR;
      ctx.fillText(headings[i], x - 8 * s, 0);
    }
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(cx - 5 * s, 6 * s);
    ctx.lineTo(cx + 5 * s, 6 * s);
    ctx.lineTo(cx, 14 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
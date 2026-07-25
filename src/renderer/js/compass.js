// Compass dial canvas with home bearing indicator.
export class Compass {
  constructor(canvas) {
    this.canvas = canvas;
    this.heading = 0;
    this.bearing = 0;
    this._setup();
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
  set({ heading, bearing }) {
    this.heading = heading;
    this.bearing = bearing;
    this.draw();
  }
  draw() {
    const ctx = this._ctx;
    if (!ctx) return;
    const w = this._w;
    const h = this._h;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 4;
    if (r <= 0) return;
    // Scale all geometry proportionally to radius so a small canvas still looks right.
    const s = r / 100;
    ctx.clearRect(0, 0, w, h);

    // outer ring
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // ticks
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-this.heading * Math.PI) / 180);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.7)';
    ctx.fillStyle = 'rgba(248, 250, 252, 0.85)';
    ctx.font = `${Math.max(8, Math.round(10 * s))}px JetBrains Mono`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 36; i++) {
      const angle = (i * 10) * Math.PI / 180;
      const major = i % 9 === 0;
      const tickIn = r - (major ? 10 * s : 5 * s);
      const tickOut = r;
      const x1 = Math.sin(angle) * tickIn;
      const y1 = -Math.cos(angle) * tickIn;
      const x2 = Math.sin(angle) * tickOut;
      const y2 = -Math.cos(angle) * tickOut;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (major) {
        const label = ['N', 'E', 'S', 'W'][i / 9];
        ctx.fillText(label, Math.sin(angle) * (r - 18 * s), -Math.cos(angle) * (r - 18 * s));
      }
    }
    ctx.restore();

    // home bearing
    const home = this.bearing;
    const angle = ((home - this.heading) * Math.PI) / 180;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(angle) * (r - 4 * s), cy - Math.cos(angle) * (r - 4 * s));
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(cx + Math.sin(angle) * (r - 4 * s), cy - Math.cos(angle) * (r - 4 * s), Math.max(2, 3 * s), 0, Math.PI * 2);
    ctx.fill();

    // center fixed pointer
    ctx.fillStyle = '#0ea5e9';
    const ps = Math.max(3, 5 * s);
    ctx.beginPath();
    ctx.moveTo(cx - ps, cy - 1.4 * ps);
    ctx.lineTo(cx + ps, cy - 1.4 * ps);
    ctx.lineTo(cx, cy + ps);
    ctx.closePath();
    ctx.fill();
  }
}
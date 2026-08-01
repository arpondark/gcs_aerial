// Half-circle voltmeter gauge with tick marks, label, and animated needle.
// Range: 0V — 27V (covers 6S LiPo). Default needle rests at 0 (uninitialized).

function setupHiDPI(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

export class VoltGauge {
  constructor(canvas, { min = 0, max = 27, color = '#ffb77d' } = {}) {
    this.canvas = canvas;
    this.min = min;
    this.max = max;
    this.color = color;
    this.value = 0;
    this._angle = this._valueToAngle(0);
    this._targetAngle = this._angle;
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this._draw(); });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._resize(); this._draw(); });
      this._ro.observe(canvas);
    }
    this._animate();
  }

  _valueToAngle(v) {
    // Half circle: -180°..0°  (0V at far left, maxV at far right)
    const t = Math.max(0, Math.min(1, (v - this.min) / (this.max - this.min)));
    return Math.PI + t * Math.PI; // 180°..360° (in canvas convention: left to right)
  }

  setValue(v) {
    if (v == null || isNaN(v)) return;
    this.value = v;
    this._targetAngle = this._valueToAngle(v);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { ctx, w, h } = setupHiDPI(this.canvas);
    this._w = w;
    this._h = h;
    this._ctx = ctx;
  }

  _animate() {
    // Critically-damped interpolation toward target.
    const k = 0.18;
    this._angle += (this._targetAngle - this._angle) * k;
    this._draw();
    requestAnimationFrame(() => this._animate());
  }

  _draw() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const w = this._w;
    const h = this._h;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h * 0.92;
    const radius = Math.min(w * 0.45, h * 0.85);

    // Background arc (faded)
    ctx.strokeStyle = 'rgba(255, 183, 125, 0.18)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    // Tick marks
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = `500 9px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const ticks = 11; // 0..10 over 0..27V
    for (let i = 0; i < ticks; i++) {
      const a = Math.PI + (i / (ticks - 1)) * Math.PI;
      const inner = radius - 16;
      const outer = radius - 4;
      const isMajor = i % 2 === 0;
      ctx.lineWidth = isMajor ? 1.5 : 1;
      ctx.strokeStyle = isMajor ? 'rgba(255, 183, 125, 0.85)' : 'rgba(255, 255, 255, 0.4)';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();

      if (isMajor) {
        const label = Math.round((this.min + (i / (ticks - 1)) * (this.max - this.min))).toString();
        const lr = radius - 26;
        ctx.fillText(label, cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
      }
    }

    // "V" label under gauge center
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `600 11px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.fillText('V', cx, cy + 18);

    // Needle
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this._angle) * (radius - 8), cy + Math.sin(this._angle) * (radius - 8));
    ctx.stroke();

    // Needle pivot
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Filled arc up to current value
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, this._angle);
    ctx.stroke();
  }
}

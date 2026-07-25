// Lightweight streaming line chart. Avoids any external dependency and
// keeps a rolling buffer of N samples. Renders a glowing current pulse
// (Real-Time Monitoring style: faded history + current accent).

const HISTORY = 180; // ~3 minutes at 1Hz

function setupHiDPI(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

export class StreamChart {
  constructor(canvas, { color = '#22c55e', fill = true } = {}) {
    this.canvas = canvas;
    this.color = color;
    this.fill = fill;
    this.buffer = [];
    this._resize();
    window.addEventListener('resize', () => this._resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
  }
  push(value) {
    this.buffer.push(value);
    if (this.buffer.length > HISTORY) this.buffer.shift();
    this.draw();
  }
  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { ctx, w, h } = setupHiDPI(this.canvas);
    this._w = w;
    this._h = h;
    this._ctx = ctx;
  }
  draw() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const w = this._w;
    const h = this._h;
    ctx.clearRect(0, 0, w, h);
    if (this.buffer.length < 2) return;

    // axis
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const min = Math.min(...this.buffer);
    const max = Math.max(...this.buffer);
    const range = Math.max(0.0001, max - min);
    const pad = 6;

    const stepX = (w - pad * 2) / Math.max(1, this.buffer.length - 1);
    const yFor = (v) => h - pad - ((v - min) / range) * (h - pad * 2);

    // history gradient
    if (this.fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `${this.color}55`);
      grad.addColorStop(1, `${this.color}00`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(pad, h - pad);
      this.buffer.forEach((v, i) => {
        const x = pad + i * stepX;
        const y = yFor(v);
        if (i === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo(pad + (this.buffer.length - 1) * stepX, h - pad);
      ctx.closePath();
      ctx.fill();
    }

    // line (faded older samples)
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass === 0 ? 1 : 2;
      ctx.strokeStyle = pass === 0 ? `${this.color}55` : this.color;
      ctx.beginPath();
      this.buffer.forEach((v, i) => {
        const x = pad + i * stepX;
        const y = yFor(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // current pulse dot
    const last = this.buffer[this.buffer.length - 1];
    const lx = pad + (this.buffer.length - 1) * stepX;
    const ly = yFor(last);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `${this.color}55`;
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

export class AttitudeTrailChart extends StreamChart {
  pushSample(roll, pitch) {
    this.buffer.push({ roll, pitch });
    if (this.buffer.length > HISTORY) this.buffer.shift();
    this.draw();
  }
  draw() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const w = this._w;
    const h = this._h;
    ctx.clearRect(0, 0, w, h);
    if (this.buffer.length < 2) return;

    // center line
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const stepX = w / Math.max(1, this.buffer.length - 1);
    const yFor = (deg) => h / 2 - (deg / 45) * (h / 2 - 4);

    const drawSeries = (key, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      this.buffer.forEach((s, i) => {
        const x = i * stepX;
        const y = yFor(s[key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries('roll', '#22c55e');
    drawSeries('pitch', '#f59e0b');
  }
}

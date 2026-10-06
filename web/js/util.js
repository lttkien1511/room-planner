// Small shared helpers. All document units are centimetres; the 3D scene uses metres (M).
export const M = 0.01;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round(v * 10) / 10;
export const snapTo = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const normDeg = (d) => ((d % 360) + 360) % 360;

// IDs must not depend on crypto.randomUUID: it is missing on plain-http LAN origins.
export const uid = (prefix = 'x') =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function fmtLen(cm) {
  return cm >= 100 ? (cm / 100).toFixed(2).replace('.', ',') + ' m' : Math.round(cm) + ' cm';
}

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    s += x1 * z2 - x2 * z1;
  }
  return Math.abs(s) / 2; // cm^2
}

export const fmtArea = (cm2) => (cm2 / 10000).toFixed(2).replace('.', ',') + ' m²';

/** Offset a simple polygon inwards by d (mitred corners). Used for interior room area. */
export function insetPolygon(pts, d) {
  const n = pts.length;
  if (n < 3 || d <= 0) return pts;
  let a2 = 0;
  for (let i = 0; i < n; i++) a2 += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const sgn = a2 >= 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz) || 1;
    return { px: p[0] - (dz / len) * sgn * d, pz: p[1] + (dx / len) * sgn * d, dx, dz };
  });
  return pts.map((_, i) => {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const det = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(det) < 1e-9) return [B.px, B.pz];
    const t = ((B.px - A.px) * B.dz - (B.pz - A.pz) * B.dx) / det;
    return [A.px + A.dx * t, A.pz + A.dz * t];
  });
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return wrapped;
}

export class Emitter {
  constructor() {
    this._fns = new Set();
  }
  on(fn) {
    this._fns.add(fn);
    return () => this._fns.delete(fn);
  }
  emit(...args) {
    for (const fn of this._fns) fn(...args);
  }
}

// Tiny DOM builder: h('button', {class:'x', text:'Hi', on:{click:fn}}, child...)
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

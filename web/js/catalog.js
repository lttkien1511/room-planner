// Furniture catalogue. Every item is a handful of primitives merged into ONE geometry
// (vertex colours, no textures), so a whole room costs only a few dozen draw calls.
//
// Local frame (cm): origin = centre of the footprint on the floor, +x right, +y up,
// +z = FRONT of the item, -z = back (the side that goes against a wall).
// Part colours: 'main' = the item's user colour, 'dark' / 'darker' / 'light' = shades of
// it, or a fixed '#rrggbb'.
import * as THREE from '../vendor/three.bundle.js';
import { M } from './util.js';

// ---- part constructors (y is the bottom of the part unless noted) -------------------
// `rd` (box only) = corner-rounding radius in cm, 0 = sharp. `w1`/`d1` (box only) = width/depth
// at the TOP face — omit (or set equal to `w`/`d`) for a plain prism, smaller for a tapered
// blade/petal shape, larger for a flared one. Both together (rd>0 AND tapered) round the
// tapered shape's own horizontal outline at each end (see buildRoundedTaperedBox) — an organic
// leaf/petal silhouette instead of a rectangle's sharp corners, without rounding the (usually
// thin, barely-visible) edge where the part's front meets its back.
//
// `tilt`/`roty` (box/cylinder/sphere) let an otherwise axis-aligned part lean like a real branch
// or petal instead of always standing bolt upright: `tilt` (degrees) leans it away from vertical,
// `roty` (degrees) picks WHICH horizontal direction it leans toward (and, at tilt=0, just spins
// it in place — the only thing `roty` alone ever did before). Together they work like a compass:
// same tilt + roty stepped round 0..360 across a set of parts fans them out in a circle (petals,
// fern fronds) — see geometryForPart for the rotate order this relies on. For box/cylinder BOTH
// pivot around the part's own BASE (its `y` point), not its centre, so a ring of parts all keep
// their base at the same spot as they fan out, like they're all growing from one point; sphere
// pivots around its own centre (it has no base — `y` is already its centre).
// None of this changes any built-in call below (all omit the new params, defaulting to "no
// taper/lean"); only the block-builder ("Tự tạo đồ vật") and hand-authored custom-item templates
// use it.
const B = (x, y, z, w, h, d, c = 'main', rd = 0, w1 = w, d1 = d, roty = 0, tilt = 0) => ({ k: 'b', x, y, z, w, h, d, c, rd, w1, d1, roty, tilt });
const C = (x, y, z, r, h, c = 'main', rt = r, roty = 0, tilt = 0) => ({ k: 'c', x, y, z, r, h, c, rt, roty, tilt });
const Z = (x, yc, z, r, len, c = 'main') => ({ k: 'z', x, y: yc, z, r, h: len, c }); // cylinder along Z, y = centre
// `ry`/`rz` (default = `r`) let the sphere become an ellipsoid — e.g. a flattened flower/fruit
// blob instead of a perfect ball; `roty`/`tilt` only have a visible effect when rx≠rz.
const S = (x, yc, z, r, c = 'main', ry = r, rz = r, roty = 0, tilt = 0) => ({ k: 's', x, y: yc, z, r, c, ry, rz, roty, tilt });

const METAL = '#b9c1c9';
const WOOD = '#7a5a44';
const BLACK = '#26282b';

export const CATEGORIES = [
  { id: 'basic', name: 'Cơ bản' },
  { id: 'bed', name: 'Phòng ngủ' },
  { id: 'living', name: 'Phòng khách' },
  { id: 'work', name: 'Ăn uống & làm việc' },
  { id: 'kitchen', name: 'Bếp' },
  { id: 'bath', name: 'Phòng tắm' },
  { id: 'deco', name: 'Trang trí' },
];

// Part kinds usable by the visual block-builder ("Tự tạo đồ vật"). 'z' (cylinder lying along Z,
// used by a couple of built-in parts like the washer's drum) is deliberately not offered there —
// it needs a lying-vs-standing toggle the editor doesn't have yet.
export const EDITABLE_PART_KINDS = [
  { k: 'b', label: 'Hộp' },
  { k: 'c', label: 'Trụ' },
  { k: 's', label: 'Cầu' },
  { k: 'm', label: 'Lưới' },
];

export const MESH_MAX_GRID = 8; // per axis — keeps a single mesh part's triangle count small

function bed(w, d, h, pillows) {
  const legH = 10, baseH = 20, matH = 22;
  const top = legH + baseH;
  const p = [
    B(-(w / 2 - 5), 0, d / 2 - 5, 6, legH, 6, '#4a382b'), B(w / 2 - 5, 0, d / 2 - 5, 6, legH, 6, '#4a382b'),
    B(-(w / 2 - 5), 0, -(d / 2 - 5), 6, legH, 6, '#4a382b'), B(w / 2 - 5, 0, -(d / 2 - 5), 6, legH, 6, '#4a382b'),
    B(0, legH, 0, w, baseH, d, WOOD),
    B(0, top, 3, w - 4, matH, d - 8, '#f2f1ee'),
    B(0, legH + baseH + 8, d / 2 - d * 0.31 - 2, w - 2, 17, d * 0.62, 'main'),
    B(0, legH, -d / 2 + 2.5, w, Math.max(10, h - legH), 5, WOOD),
  ];
  const pw = pillows > 1 ? w / 2 - 9 : w - 22;
  for (let i = 0; i < pillows; i++) {
    const px = pillows > 1 ? (i === 0 ? -1 : 1) * (w / 4) : 0;
    p.push(B(px, top + matH, -d / 2 + 24, pw, 8, 34, '#ffffff'));
  }
  return p;
}

function sofa(w, d, h, seats) {
  const uw = w - 32;
  const cw = uw / seats;
  const p = [
    B(-(w / 2 - 6), 0, d / 2 - 6, 5, 10, 5, '#3b3b3b'), B(w / 2 - 6, 0, d / 2 - 6, 5, 10, 5, '#3b3b3b'),
    B(-(w / 2 - 6), 0, -(d / 2 - 6), 5, 10, 5, '#3b3b3b'), B(w / 2 - 6, 0, -(d / 2 - 6), 5, 10, 5, '#3b3b3b'),
    B(0, 10, 0, w, 22, d, 'main'),
    B(0, 32, -d / 2 + 8, w, Math.max(20, h - 32), 16, 'main'),
    B(-(w / 2 - 8), 32, 8, 16, 18, d - 16, 'dark'), B(w / 2 - 8, 32, 8, 16, 18, d - 16, 'dark'),
  ];
  for (let i = 0; i < seats; i++) {
    const cx = -uw / 2 + cw * (i + 0.5);
    p.push(B(cx, 32, 8, cw - 1.5, 12, d - 18, 'light'));
    p.push(B(cx, 44, -d / 2 + 21, cw - 1.5, Math.max(10, h - 50), 10, 'light'));
  }
  return p;
}

function bookshelf(w, d, h) {
  const p = [
    B(-(w / 2 - 1.5), 0, 0, 3, h, d), B(w / 2 - 1.5, 0, 0, 3, h, d),
    B(0, 0, 0, w, 3, d), B(0, h - 3, 0, w, 3, d),
    B(0, 0, -d / 2 + 0.75, w, h, 1.5, 'dark'),
  ];
  const rows = 5;
  const palette = ['#c0504d', '#4f81bd', '#9bbb59', '#e5b25d', '#8064a2', '#4bacc6', '#d98f59'];
  for (let i = 1; i < rows; i++) p.push(B(0, (i * h) / rows, 0, w - 6, 2.5, d - 2));
  for (let r = 0; r < rows - 1; r++) {
    const y = (r * h) / rows + 3 + (r > 0 ? 0 : 0);
    let x = -w / 2 + 6;
    let n = 0;
    while (x < w / 2 - 10 && n < 9) {
      const bw = 3 + ((r * 7 + n * 5) % 5);
      const bh = (h / rows) * (0.55 + (((r + n) * 3) % 4) * 0.1);
      p.push(B(x + bw / 2, y, -1, bw, Math.min(bh, h / rows - 5), d - 8, palette[(r * 3 + n) % palette.length]));
      x += bw + 0.6;
      n++;
    }
  }
  return p;
}

function chair(w, d, h) {
  const seatY = h * 0.5;
  const l = 3.5;
  return [
    B(-(w / 2 - 3), 0, d / 2 - 3, l, seatY, l, 'dark'), B(w / 2 - 3, 0, d / 2 - 3, l, seatY, l, 'dark'),
    B(-(w / 2 - 3), 0, -(d / 2 - 3), l, h, l, 'dark'), B(w / 2 - 3, 0, -(d / 2 - 3), l, h, l, 'dark'),
    B(0, seatY - 4, 0, w, 4, d, 'main'),
    B(0, seatY + 8, -d / 2 + 2, w - 6, h - seatY - 14, 2.5, 'main'),
    B(0, h - 6, -d / 2 + 2, w, 4, 3.5, 'dark'),
  ];
}

function legsTable(w, d, h, topT, legS = 6) {
  return [
    B(0, h - topT, 0, w, topT, d, 'main'),
    B(-(w / 2 - legS), 0, d / 2 - legS, legS, h - topT, legS, 'dark'), B(w / 2 - legS, 0, d / 2 - legS, legS, h - topT, legS, 'dark'),
    B(-(w / 2 - legS), 0, -(d / 2 - legS), legS, h - topT, legS, 'dark'), B(w / 2 - legS, 0, -(d / 2 - legS), legS, h - topT, legS, 'dark'),
  ];
}

function plant(w, d, h) {
  const r = Math.min(w, d) / 2;
  const potH = h * 0.2;
  const rimH = potH * 0.22;
  const trunkTop = potH + h * 0.3;
  const parts = [
    C(0, 0, 0, r * 0.6, potH - rimH, '#a4694a', r * 0.68),
    C(0, potH - rimH, 0, r * 0.74, rimH, '#8a5a3c'),
    C(0, potH, 0, r * 0.1, trunkTop - potH, '#6b4a33', r * 0.06),
    S(0, trunkTop + h * 0.2, 0, r * 0.95, 'main', r * 0.8, r * 0.95),
  ];
  const sideAngles = [20, 110, 200, 290];
  const sideShades = ['dark', 'light', 'main', 'dark'];
  for (let i = 0; i < sideAngles.length; i++) {
    const a = (sideAngles[i] * Math.PI) / 180;
    const spread = r * 0.5;
    const rad = r * (0.55 + 0.08 * (i % 2));
    parts.push(S(
      Math.cos(a) * spread, trunkTop + h * (0.05 + 0.04 * (i % 2)), Math.sin(a) * spread,
      rad, sideShades[i], rad * 0.85, rad * 0.95, sideAngles[i], 22,
    ));
  }
  return parts;
}

const kitchenCounter = '#d3cfc6';

export const CATALOG = [
  // ---- basic -----------------------------------------------------------------------
  { id: 'box', cat: 'basic', name: 'Khối hộp', size: [100, 100, 100], color: '#b8c2cc', parts: (w, d, h) => [B(0, 0, 0, w, h, d)] },
  { id: 'cylinder', cat: 'basic', name: 'Trụ tròn', size: [60, 60, 100], color: '#b8c2cc', parts: (w, d, h) => [C(0, 0, 0, Math.min(w, d) / 2, h, 'main')] },
  {
    id: 'rug', cat: 'basic', name: 'Thảm', size: [200, 140, 2], color: '#b5651d',
    parts: (w, d, h) => [B(0, 0, 0, w, h, d, 'main'), B(0, 0, 0, Math.max(1, w - 16), h + 0.4, Math.max(1, d - 16), 'light')],
  },
  // ---- bedroom ---------------------------------------------------------------------
  { id: 'bed-double', cat: 'bed', name: 'Giường đôi', size: [160, 200, 100], color: '#7f9bb8', parts: (w, d, h) => bed(w, d, h, 2) },
  { id: 'bed-single', cat: 'bed', name: 'Giường đơn', size: [100, 200, 90], color: '#9bb38a', parts: (w, d, h) => bed(w, d, h, 1) },
  {
    id: 'nightstand', cat: 'bed', name: 'Táp đầu giường', size: [45, 40, 50], color: '#a67c5b',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h, d), B(0, h * 0.08, d / 2, w - 4, h * 0.4, 1, 'light'), B(0, h * 0.52, d / 2, w - 4, h * 0.4, 1, 'light'),
      B(0, h * 0.26, d / 2 + 1, 8, 1.5, 1.5, 'darker'), B(0, h * 0.7, d / 2 + 1, 8, 1.5, 1.5, 'darker'),
    ],
  },
  {
    id: 'wardrobe', cat: 'bed', name: 'Tủ quần áo', size: [120, 60, 200], color: '#c9b79c',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h, d), B(-w / 4, 4, d / 2, w / 2 - 3, h - 8, 1, 'light'), B(w / 4, 4, d / 2, w / 2 - 3, h - 8, 1, 'light'),
      B(-3, h * 0.5, d / 2 + 1, 1.5, 22, 1.5, 'darker'), B(3, h * 0.5, d / 2 + 1, 1.5, 22, 1.5, 'darker'),
    ],
  },
  // ---- living room -----------------------------------------------------------------
  { id: 'sofa', cat: 'living', name: 'Sofa 3 chỗ', size: [200, 90, 85], color: '#6f7f91', parts: (w, d, h) => sofa(w, d, h, 3) },
  { id: 'armchair', cat: 'living', name: 'Ghế bành', size: [90, 90, 85], color: '#b07a4f', parts: (w, d, h) => sofa(w, d, h, 1) },
  {
    id: 'coffee-table', cat: 'living', name: 'Bàn trà', size: [100, 55, 40], color: '#c8a27a',
    parts: (w, d, h) => [...legsTable(w, d, h, 4, 4), B(0, h * 0.25, 0, w - 12, 2, d - 12, 'dark')],
  },
  {
    id: 'tv-stand', cat: 'living', name: 'Kệ TV', size: [160, 40, 50], color: '#8b6b52',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h, d), B(-w / 4, 4, d / 2, w / 2 - 6, h - 10, 1, 'light'), B(w / 4, 4, d / 2, w / 2 - 6, h - 10, 1, 'light'),
      B(-w / 4 + 12, h * 0.55, d / 2 + 1, 6, 1.5, 1.5, 'darker'), B(w / 4 - 12, h * 0.55, d / 2 + 1, 6, 1.5, 1.5, 'darker'),
    ],
  },
  {
    id: 'tv', cat: 'living', name: 'TV', size: [110, 20, 65], color: '#1c1e21', y: 50,
    parts: (w, d, h) => [
      B(0, 0, 0, Math.min(40, w * 0.4), 2, d, '#2b2d31'), B(0, 2, 0, 6, 8, 4, '#2b2d31'),
      B(0, 10, 0, w, h - 10, 3.5, 'main'), B(0, 11.5, 1.9, w - 4, h - 13, 0.5, '#33414f'),
    ],
  },
  { id: 'bookshelf', cat: 'living', name: 'Kệ sách', size: [80, 30, 180], color: '#a67c5b', parts: bookshelf },
  // ---- dining & work ---------------------------------------------------------------
  { id: 'dining-table', cat: 'work', name: 'Bàn ăn', size: [150, 80, 75], color: '#b98d62', parts: (w, d, h) => legsTable(w, d, h, 4, 7) },
  { id: 'chair', cat: 'work', name: 'Ghế', size: [45, 45, 90], color: '#c4a17a', parts: chair },
  {
    id: 'desk', cat: 'work', name: 'Bàn làm việc', size: [140, 60, 75], color: '#c9b08a',
    parts: (w, d, h) => [
      B(0, h - 3, 0, w, 3, d), B(-w / 2 + 21, 0, 0, 40, h - 3, d - 4, 'light'),
      B(-w / 2 + 21, (h - 3) * 0.33, d / 2 - 1.6, 36, 0.8, 0.6, 'darker'), B(-w / 2 + 21, (h - 3) * 0.66, d / 2 - 1.6, 36, 0.8, 0.6, 'darker'),
      B(w / 2 - 2, 0, 0, 3, h - 3, d - 4, 'dark'),
      B(18.75, h * 0.35, -d / 2 + 3, Math.max(1, w - 44.5), h * 0.55, 1.5, 'dark'),
    ],
  },
  {
    id: 'office-chair', cat: 'work', name: 'Ghế xoay', size: [60, 60, 95], color: '#3c4650',
    parts: (w, d, h) => {
      const sy = h * 0.44;
      return [
        C(0, 2, 0, Math.min(w, d) * 0.4, 3, '#222428'), C(0, 5, 0, 4, sy - 5, '#3a3d42'),
        B(0, sy, 2, w * 0.8, 6, d * 0.78, 'main'),
        B(0, sy + 6, -d * 0.4 + 2, w * 0.74, h - sy - 6, 5, 'main'),
        B(-(w * 0.4), sy + 6, 2, 3, 14, d * 0.5, 'dark'), B(w * 0.4, sy + 6, 2, 3, 14, d * 0.5, 'dark'),
      ];
    },
  },
  // ---- kitchen ---------------------------------------------------------------------
  {
    id: 'kitchen-base', cat: 'kitchen', name: 'Tủ bếp dưới', size: [60, 60, 85], color: '#e4e0d8',
    parts: (w, d, h) => [
      B(0, 0, -2, w - 2, 8, d - 8, '#2c2c2c'), B(0, 8, 0, w, h - 11, d), B(0, h - 3, 1, w + 0.5, 3, d + 2, kitchenCounter),
      B(0, h - 16, d / 2 + 0.8, w * 0.5, 1.5, 1.5, 'darker'), B(0, h * 0.45, d / 2 + 0.3, w - 4, 0.8, 0.6, 'dark'),
    ],
  },
  {
    id: 'kitchen-wall', cat: 'kitchen', name: 'Tủ bếp trên', size: [60, 35, 70], color: '#e4e0d8', y: 140,
    parts: (w, d, h) => [B(0, 0, 0, w, h, d), B(0, 6, d / 2 + 0.8, w * 0.5, 1.5, 1.5, 'darker'), B(0, h / 2, d / 2 + 0.3, w - 4, 0.8, 0.6, 'dark')],
  },
  {
    id: 'stove', cat: 'kitchen', name: 'Bếp nấu', size: [60, 60, 85], color: '#d9dbde',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h - 3, d), B(0, h - 3, 0, w, 3, d, '#22242a'),
      C(-w * 0.22, h, -d * 0.2, 8, 0.8, '#5a5f66'), C(w * 0.22, h, -d * 0.2, 6.5, 0.8, '#5a5f66'),
      C(-w * 0.22, h, d * 0.22, 6.5, 0.8, '#5a5f66'), C(w * 0.22, h, d * 0.22, 8, 0.8, '#5a5f66'),
      B(0, 8, d / 2 + 0.4, w - 10, h - 30, 0.8, '#2a2a2e'), B(0, h - 18, d / 2 + 2, w - 18, 1.5, 2, METAL),
    ],
  },
  {
    id: 'sink', cat: 'kitchen', name: 'Bồn rửa bếp', size: [80, 60, 85], color: '#e4e0d8',
    parts: (w, d, h) => [
      B(0, 0, -2, w - 2, 8, d - 8, '#2c2c2c'), B(0, 8, 0, w, h - 11, d), B(0, h - 3, 1, w + 0.5, 3, d + 2, kitchenCounter),
      B(-w * 0.12, h, 2, w * 0.5, 0.6, d * 0.62, METAL), C(w * 0.2, h, -d / 2 + 6, 1.3, 14, METAL), B(w * 0.2, h + 12, -d / 2 + 11, 2, 2, 10, METAL),
      B(0, h - 16, d / 2 + 0.8, w * 0.4, 1.5, 1.5, 'darker'),
    ],
  },
  {
    id: 'fridge', cat: 'kitchen', name: 'Tủ lạnh', size: [70, 70, 180], color: '#e6e8eb',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h, d), B(0, h * 0.66, d / 2, w - 1, 0.8, 0.6, '#8f969d'),
      B(-w / 2 + 8, h * 0.72, d / 2 + 1, 2, 22, 2, '#8f969d'), B(-w / 2 + 8, h * 0.3, d / 2 + 1, 2, 40, 2, '#8f969d'),
    ],
  },
  // ---- bathroom --------------------------------------------------------------------
  {
    id: 'toilet', cat: 'bath', name: 'Bồn cầu', size: [40, 70, 75], color: '#f3f5f7',
    parts: (w, d, h) => [
      B(0, 0, -d / 2 + 18, w * 0.55, 22, 26), B(0, 22, d * 0.05, w * 0.9, 18, d * 0.7),
      B(0, 40, d * 0.06, w * 0.85, 2, d * 0.62, 'light'), B(0, 32, -d / 2 + 8, w * 0.9, Math.max(10, h - 32), 14), B(0, h, -d / 2 + 8, 8, 1, 4, METAL),
    ],
  },
  {
    id: 'bathtub', cat: 'bath', name: 'Bồn tắm', size: [170, 75, 55], color: '#f3f5f7',
    parts: (w, d, h) => [B(0, 0, 0, w, h, d), B(0, h, 0, w - 12, 0.5, d - 12, '#c9deea'), C(-w / 2 + 8, h, 0, 1.5, 12, METAL), B(-w / 2 + 8, h + 10, 4, 2, 2, 8, METAL)],
  },
  {
    id: 'shower', cat: 'bath', name: 'Phòng tắm đứng', size: [90, 90, 200], color: '#dfe6ec',
    parts: (w, d, h) => [
      B(0, 0, 0, w, 6, d), B(-(w / 2 - 1), 6, d / 2 - 1, 2, h - 6, 2, '#aab4bd'), B(w / 2 - 1, 6, d / 2 - 1, 2, h - 6, 2, '#aab4bd'),
      B(-(w / 2 - 1), 6, -(d / 2 - 1), 2, h - 6, 2, '#aab4bd'), B(w / 2 - 1, 6, -(d / 2 - 1), 2, h - 6, 2, '#aab4bd'),
      B(0, h - 2, d / 2 - 1, w, 2, 2, '#aab4bd'), B(0, h - 2, -(d / 2 - 1), w, 2, 2, '#aab4bd'),
      B(-(w / 2 - 1), h - 2, 0, 2, 2, d, '#aab4bd'), B(w / 2 - 1, h - 2, 0, 2, 2, d, '#aab4bd'),
      B(0, h - 30, -(d / 2 - 6), 3, 3, 12, METAL),
    ],
  },
  {
    id: 'washbasin', cat: 'bath', name: 'Lavabo', size: [60, 45, 85], color: '#e8e2d8',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h - 3, d), B(0, h - 3, 0, w + 1, 3, d + 1, '#d6d2ca'), B(0, h, 1, w * 0.6, 0.8, d * 0.62, '#f1f5f8'),
      C(0, h, -d / 2 + 7, 1.2, 10, METAL), B(0, h + 8, -d / 2 + 11, 1.5, 1.5, 8, METAL),
    ],
  },
  {
    id: 'washer', cat: 'bath', name: 'Máy giặt', size: [60, 60, 85], color: '#eceef0',
    parts: (w, d, h) => [
      B(0, 0, 0, w, h, d), Z(0, h * 0.45, d / 2, w * 0.34, 1.6, '#c9ced3'), Z(0, h * 0.45, d / 2 + 0.6, w * 0.27, 1.6, '#2f3f4d'),
      B(-w * 0.3, h - 8, d / 2 + 0.3, 14, 4, 0.8, '#8f969d'),
    ],
  },
  // ---- decoration ------------------------------------------------------------------
  {
    id: 'plant', cat: 'deco', name: 'Cây cảnh', size: [40, 40, 120], color: '#4f8f4a',
    parts: plant,
  },
  {
    id: 'floor-lamp', cat: 'deco', name: 'Đèn sàn', size: [35, 35, 160], color: '#f1e3a8',
    parts: (w, d, h) => [
      C(0, 0, 0, Math.min(w, d) * 0.3, 2, '#2f3237'), C(0, 2, 0, 1.2, h - 32, '#2f3237'),
      C(0, h - 32, 0, Math.min(w, d) * 0.5, 30, 'main', Math.min(w, d) * 0.3),
    ],
  },
];

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));

// Items that turn their back to the wall when dragged next to it (everything else keeps its rotation).
const BACK_TO_WALL = new Set([
  'bed-double', 'bed-single', 'nightstand', 'wardrobe', 'sofa', 'tv-stand', 'tv', 'bookshelf', 'desk',
  'kitchen-base', 'kitchen-wall', 'stove', 'sink', 'fridge', 'toilet', 'bathtub', 'washbasin', 'washer',
]);
export const isBackToWall = (type) => BACK_TO_WALL.has(type);

// ---- user-made items ("Tự tạo"), registered at runtime from the server library ----------------
// Same shape as a CATALOG entry (id/cat/name/size/color/parts), so every other module (view,
// interact, model, thumbs) treats a custom item exactly like a built-in one via lookupItem().
export const customItems = new Map();

/** CATALOG_BY_ID lookup extended with registered custom items. */
export function lookupItem(type) {
  return CATALOG_BY_ID[type] || customItems.get(type) || null;
}

/** Register (or update, after editing) a custom item from a server record {id,name,size,color,template,rev}. */
export function registerCustomItem(rec) {
  const entry = {
    id: rec.id, cat: 'custom', name: rec.name, size: rec.size, color: rec.color,
    template: rec.template, rev: rec.rev,
    parts: (w, d, h) => applyTemplate(rec.template, w, d, h),
  };
  customItems.set(rec.id, entry);
  return entry;
}

export function unregisterCustomItem(id) {
  customItems.delete(id);
}

/**
 * Convert a template (fractions of the item's own bounding box, from templateFromParts) back into
 * absolute-cm parts for a given size. Radius-based parts scale off the smaller footprint side —
 * same convention the hand-written catalog entries above use (see e.g. 'cylinder') — so a custom
 * item resizes sensibly instead of turning elliptical.
 */
export function applyTemplate(template, w, d, h) {
  const ref = Math.min(w, d) || 1;
  return (template || []).map((t) => {
    if (t.k === 'm') {
      const rows = Math.max(1, Math.min(MESH_MAX_GRID, Math.round(t.rows) || 3));
      const cols = Math.max(1, Math.min(MESH_MAX_GRID, Math.round(t.cols) || 4));
      const n = (rows + 1) * (cols + 1);
      const fracArr = (f) => (Array.isArray(f) && f.length === n ? f.map((v) => v * ref) : new Array(n).fill(0));
      return {
        k: 'm', x: t.fx * w, y: t.fy * h, z: t.fz * d, c: t.c,
        w: Math.max(0.1, t.fw * w), d: Math.max(0.1, t.fd * d),
        rows, cols, vh: fracArr(t.fvh), vx: fracArr(t.fvx), vz: fracArr(t.fvz),
        roty: t.froty || 0, tilt: t.ftilt || 0,
      };
    }
    if (t.k === 'b') {
      const bw = Math.max(0.1, t.fw * w), bd = Math.max(0.1, t.fd * d);
      return B(
        t.fx * w, t.fy * h, t.fz * d, bw, Math.max(0.1, t.fh * h), bd, t.c,
        Math.max(0, (t.frd || 0) * ref),
        t.fw1 !== undefined ? Math.max(0.1, t.fw1 * w) : bw,
        t.fd1 !== undefined ? Math.max(0.1, t.fd1 * d) : bd,
        t.froty || 0, t.ftilt || 0,
      );
    }
    if (t.k === 'c') return C(t.fx * w, t.fy * h, t.fz * d, Math.max(0.1, t.fr * ref), Math.max(0.1, t.fh * h), t.c, Math.max(0.1, (t.frt ?? t.fr) * ref), t.froty || 0, t.ftilt || 0);
    if (t.k === 's') {
      const r = Math.max(0.1, t.fr * ref);
      return S(
        t.fx * w, t.fy * h, t.fz * d, r, t.c,
        t.fry !== undefined ? Math.max(0.1, t.fry * ref) : r,
        t.frz !== undefined ? Math.max(0.1, t.frz * ref) : r,
        t.froty || 0, t.ftilt || 0,
      );
    }
    return B(0, 0, 0, 1, 1, 1, t.c); // unknown kind (future format?): a small marker box instead of throwing
  });
}

/** Inverse of applyTemplate: absolute-cm parts (from the block-builder) -> a storable template. */
export function templateFromParts(parts, w, d, h) {
  const ref = Math.min(w, d) || 1;
  return parts.map((p) => {
    const t = { k: p.k, fx: p.x / w, fy: p.y / h, fz: p.z / d, c: p.c };
    if (p.k === 'm') {
      t.fw = p.w / w; t.fd = p.d / d;
      t.rows = p.rows; t.cols = p.cols;
      t.fvh = (p.vh || []).map((v) => v / ref);
      t.fvx = (p.vx || []).map((v) => v / ref);
      t.fvz = (p.vz || []).map((v) => v / ref);
      if (p.roty) t.froty = p.roty;
      if (p.tilt) t.ftilt = p.tilt;
    } else if (p.k === 'b') {
      t.fw = p.w / w; t.fh = p.h / h; t.fd = p.d / d;
      if (p.rd) t.frd = p.rd / ref;
      if (p.w1 !== undefined && p.w1 !== p.w) t.fw1 = p.w1 / w;
      if (p.d1 !== undefined && p.d1 !== p.d) t.fd1 = p.d1 / d;
      if (p.roty) t.froty = p.roty;
      if (p.tilt) t.ftilt = p.tilt;
    } else if (p.k === 'c') {
      t.fr = p.r / ref; t.fh = p.h / h;
      if (p.rt !== p.r) t.frt = p.rt / ref;
      if (p.roty) t.froty = p.roty;
      if (p.tilt) t.ftilt = p.tilt;
    } else if (p.k === 's') {
      t.fr = p.r / ref;
      if (p.ry !== undefined && p.ry !== p.r) t.fry = p.ry / ref;
      if (p.rz !== undefined && p.rz !== p.r) t.frz = p.rz / ref;
      if (p.roty) t.froty = p.roty;
      if (p.tilt) t.ftilt = p.tilt;
    }
    return t;
  });
}

const WHITE = new THREE.Color(1, 1, 1);
/** Resolve a part's colour spec ('main'/'dark'/'darker'/'light' or a literal '#rrggbb') against
 * the item's own colour. Exported so the block-builder preview shades parts the same way. */
export function resolveColor(spec, main) {
  const c = new THREE.Color(spec.startsWith('#') ? spec : main);
  if (spec === 'dark') c.multiplyScalar(0.62);
  else if (spec === 'darker') c.multiplyScalar(0.38);
  else if (spec === 'light') c.lerp(WHITE, 0.42);
  return c;
}

const ROUND_SEGMENTS = 6; // per rounded edge — a visible curve, still a handful of triangles

/**
 * A box with all 12 edges/8 corners rounded off by `radius` (must already be clamped to ≤ half
 * the smallest dimension). Built the same way three.js's own BoxGeometry builds its 6 faces (one
 * grid-quad function called 6x with axis indices + sign flips so one winding/index pattern works
 * for every face — see three.js source), except each grid vertex additionally gets pushed out
 * along a spherical profile when it falls within `radius` of an edge or corner: clamp the vertex
 * to the smaller "core" box, then offset by `radius` along the direction from that clamped point
 * back to the original vertex. Two faces meeting at a seam start from the exact same raw box-surface
 * point, so their independently-computed warps land on the same 3D position too — no cracks, even
 * though the two copies (one per face) keep their own flat-vs-curved normal.
 * With radius=0 every vertex is already inside the core box, so this reproduces a plain flat-shaded
 * box exactly (used as a sanity check while building this — see verification notes in the log).
 */
function buildRoundedBox(width, height, depthDim, radius, segments) {
  const half = [width / 2, height / 2, depthDim / 2];
  const inner = half.map((hf) => Math.max(0, hf - radius));
  const positions = [];
  const normals = [];
  const indices = [];
  let vertexCount = 0;

  // u,v = the two axes the face grid sweeps; w = the face's constant (normal) axis. `udir`/`vdir`
  // flip the in-plane coordinates and `depthSigned`'s sign picks +w or -w — together these make
  // the same (a,b,d)/(b,c,d) triangle-index pattern come out front-facing on all 6 faces.
  function facePlane(u, v, w, udir, vdir, planeW, planeH, depthSigned) {
    const segW = planeW / segments, segH = planeH / segments;
    const wHalf = planeW / 2, hHalf = planeH / 2;
    const wSign = depthSigned > 0 ? 1 : -1;
    const wCoord = half[w] * wSign;
    const start = vertexCount;
    for (let iy = 0; iy <= segments; iy++) {
      const y = iy * segH - hHalf;
      for (let ix = 0; ix <= segments; ix++) {
        const x = ix * segW - wHalf;
        const p = [0, 0, 0];
        p[u] = x * udir;
        p[v] = y * vdir;
        p[w] = wCoord;

        const c = [0, 0, 0], d = [0, 0, 0];
        let dl2 = 0;
        for (let k = 0; k < 3; k++) {
          c[k] = Math.max(-inner[k], Math.min(inner[k], p[k]));
          d[k] = p[k] - c[k];
          dl2 += d[k] * d[k];
        }
        let nrm, outp;
        if (dl2 > 1e-9) {
          const dl = Math.sqrt(dl2);
          nrm = [d[0] / dl, d[1] / dl, d[2] / dl];
          outp = [c[0] + nrm[0] * radius, c[1] + nrm[1] * radius, c[2] + nrm[2] * radius];
        } else {
          outp = p;
          nrm = [0, 0, 0];
          nrm[w] = wSign;
        }
        positions.push(outp[0], outp[1], outp[2]);
        normals.push(nrm[0], nrm[1], nrm[2]);
        vertexCount++;
      }
    }
    const row = segments + 1;
    for (let iy = 0; iy < segments; iy++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = start + ix + row * iy;
        const b = start + ix + row * (iy + 1);
        const c2 = start + (ix + 1) + row * (iy + 1);
        const d2 = start + (ix + 1) + row * iy;
        indices.push(a, b, d2, b, c2, d2);
      }
    }
  }

  facePlane(2, 1, 0, -1, -1, depthDim, height, width);   // +x
  facePlane(2, 1, 0, 1, -1, depthDim, height, -width);   // -x
  facePlane(0, 2, 1, 1, 1, width, depthDim, height);     // +y
  facePlane(0, 2, 1, 1, -1, width, depthDim, -height);   // -y
  facePlane(0, 1, 2, 1, -1, width, height, depthDim);    // +z
  facePlane(0, 1, 2, -1, -1, width, height, -depthDim);  // -z

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/**
 * A box whose top face (w1 x d1) can differ from its base (w x d) — a rectangular frustum, both
 * rings centred on the same vertical axis. w1===w && d1===d reproduces a plain box exactly (used
 * as the "no taper" case, though geometryForPart takes the cheaper THREE.BoxGeometry path then
 * instead of calling this at all). Flat per-face normals computed directly from the (possibly
 * slightly sloped, when tapered) face vertices — consistent with this app's flat-shaded,
 * vertex-coloured look, and correct even for a pronounced taper, unlike a hardcoded axis normal.
 */
function buildTaperedBox(w, h, d, w1, d1) {
  // Centred on Y (-h/2..+h/2), like THREE.BoxGeometry/buildRoundedBox — geometryForPart's
  // `pos()` translate assumes a centred part and shifts by +h/2 to land the base at p.y.
  const bx = w / 2, bz = d / 2, tx = w1 / 2, tz = d1 / 2, hh = h / 2;
  const b = [[bx, -hh, bz], [-bx, -hh, bz], [-bx, -hh, -bz], [bx, -hh, -bz]];
  const t = [[tx, hh, tz], [-tx, hh, tz], [-tx, hh, -tz], [tx, hh, -tz]];
  const positions = [], normals = [], indices = [];

  function faceNormal(p0, p1, p2) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }
  function quad(p0, p1, p2, p3) {
    const n = faceNormal(p0, p1, p2);
    const start = positions.length / 3;
    for (const p of [p0, p1, p2, p3]) { positions.push(p[0], p[1], p[2]); normals.push(n[0], n[1], n[2]); }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  quad(b[0], b[1], b[2], b[3]); // bottom (-Y)
  quad(t[0], t[3], t[2], t[1]); // top (+Y)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(b[i], t[i], t[j], b[j]); // 4 sides, outward normal computed per-face
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

const CORNER_SEGMENTS = 4; // per rounded corner of a tapered box — a visibly curved corner, cheap

/** A rounded-rectangle outline (closed loop, 4×(CORNER_SEGMENTS+1) points, each [x,z]) around the
 * origin, half-extents (hx,hz), corner radius clamped to fit. Same corner order as
 * buildTaperedBox's 4-corner ring (+x+z, -x+z, -x-z, +x-z, going the same rotational direction)
 * so a plain box's 4 corners are just this with CORNER_SEGMENTS=0. */
function roundedRectRing(hx, hz, radius) {
  const r = Math.max(0, Math.min(radius, hx, hz));
  const centres = [[hx - r, hz - r, 0], [-(hx - r), hz - r, 90], [-(hx - r), -(hz - r), 180], [hx - r, -(hz - r), 270]];
  const pts = [];
  for (const [cx, cz, a0] of centres) {
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const a = ((a0 + (i * 90) / CORNER_SEGMENTS) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  }
  return pts;
}

/**
 * Combines buildTaperedBox and buildRoundedBox's two looks into one: a tapered prism (base
 * w×d, top w1×d1) whose horizontal OUTLINE has rounded corners instead of sharp ones — the
 * "rounded box" corner treatment applied to each rounded-rect ring's own local half-extents
 * (clamped independently top vs bottom, so a heavily tapered/narrow end never self-intersects)
 * rather than warping the whole surface toward a sphere. Only the outline rounds, not the
 * vertical edge where a thin part's front meets its back — a deliberate simplification: every
 * petal/leaf this is meant for is already thin (small `d`), so that edge barely reads anyway,
 * while the outline is exactly what makes a flat shape look organic instead of rectangular.
 */
function buildRoundedTaperedBox(w, h, d, w1, d1, radius) {
  const hh = h / 2;
  const bottom = roundedRectRing(w / 2, d / 2, radius).map(([x, z]) => [x, -hh, z]);
  const top = roundedRectRing(w1 / 2, d1 / 2, radius).map(([x, z]) => [x, hh, z]);
  const n = bottom.length; // same length both rings — same CORNER_SEGMENTS
  const positions = [], normals = [], indices = [];

  function faceNormal(p0, p1, p2) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    return len > 1e-9 ? [nx / len, ny / len, nz / len] : null; // null = degenerate (zero-area) triangle
  }
  function quad(p0, p1, p2, p3) {
    // Skipped (not emitted) when degenerate — happens where a ring's own corner radius clamps to
    // its full half-extent (a fully round end), landing 2 adjacent ring points on the exact same
    // spot: the quad has zero area, and the 2 neighbouring quads that share that duplicate point
    // still cover the same ground, so skipping it leaves no visible gap.
    const nrm = faceNormal(p0, p1, p2);
    if (!nrm) return;
    const start = positions.length / 3;
    for (const p of [p0, p1, p2, p3]) { positions.push(p[0], p[1], p[2]); normals.push(nrm[0], nrm[1], nrm[2]); }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  function fan(centre, ring, order) {
    const start = positions.length / 3;
    positions.push(centre[0], centre[1], centre[2]);
    for (const p of ring) positions.push(p[0], p[1], p[2]);
    const nrm = faceNormal(centre, order > 0 ? ring[0] : ring[1], order > 0 ? ring[1] : ring[0]) || [0, order > 0 ? 1 : -1, 0]; // both rings are flat (constant Y), so a straight ±Y fallback is always correct here, not just a guess
    for (let i = 0; i <= ring.length; i++) normals.push(nrm[0], nrm[1], nrm[2]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (order > 0) indices.push(start, start + 1 + i, start + 1 + j);
      else indices.push(start, start + 1 + j, start + 1 + i);
    }
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(bottom[i], top[i], top[j], bottom[j]); // same order buildTaperedBox's sides use — outward by construction
  }
  fan([0, -hh, 0], bottom, -1); // bottom cap, -Y — order flipped relative to top so both face outward
  fan([0, hh, 0], top, 1); // top cap, +Y

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/**
 * A rows×cols grid (base footprint w×d, centred like a box's footprint) whose vertices can each be
 * dragged in the block-builder's mesh editor: `vh` bends a vertex off the flat plane (cm, its own
 * local "height"), while `offX`/`offZ` move it within the plane, reshaping the grid's outline —
 * all three length (rows+1)×(cols+1), row-major i.e. index = row*(cols+1)+col. All-zero reproduces
 * a perfectly flat, regular plane sitting exactly at the part's own base (y=0 locally), so it
 * pivots/tilts the same "grows from its base" way box/cylinder parts do, with no extra shift needed.
 * Normals are averaged per vertex (smooth shading) rather than flat per-triangle — this is the
 * whole point of the feature: an organic, softly-curved surface (petal, leaf) instead of facets.
 */
function buildMeshGrid(w, d, cols, rows, vh, offX, offZ) {
  const cols1 = cols + 1, rows1 = rows + 1;
  const positions = [];
  for (let row = 0; row < rows1; row++) {
    const gz = (row / rows - 0.5) * d;
    for (let col = 0; col < cols1; col++) {
      const k = row * cols1 + col;
      positions.push((col / cols - 0.5) * w + offX[k], vh[k], gz + offZ[k]);
    }
  }
  const indices = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const v00 = row * cols1 + col, v10 = v00 + 1, v01 = v00 + cols1, v11 = v01 + 1;
      indices.push(v00, v01, v10, v01, v11, v10); // both give +Y-ish normal on a flat grid (checked by hand)
    }
  }
  const n = positions.length / 3;
  const normals = new Array(n * 3).fill(0);
  const at = (k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]];
  for (let t = 0; t < indices.length; t += 3) {
    const [ia, ib, ic] = [indices[t], indices[t + 1], indices[t + 2]];
    const a = at(ia), b = at(ib), c = at(ic);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // unnormalised: bigger triangles pull harder, natural area weighting
    for (const idx of [ia, ib, ic]) { normals[idx * 3] += nx; normals[idx * 3 + 1] += ny; normals[idx * 3 + 2] += nz; }
  }
  for (let k = 0; k < n; k++) {
    const len = Math.hypot(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]) || 1;
    normals[k * 3] /= len; normals[k * 3 + 1] /= len; normals[k * 3 + 2] /= len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/**
 * Applies tilt+roty like a compass: `rotateZ(tilt)` first leans the part away from vertical (still
 * built centred on Y at this point), THEN `rotateY(roty)` spins that lean around to point in any
 * horizontal direction — so a fixed tilt with roty stepped round 0..360 across several parts fans
 * them out in a circle, all leaning the same amount but in different directions (fern fronds,
 * flower petals). Order matters: swap it and roty would spin the part before it leans, which
 * instead makes every part lean the same COMPASS direction regardless of roty — not what "fan out
 * around a centre" needs.
 */
function tiltAndSpin(g, tilt, roty) {
  if (tilt) g.rotateZ((tilt * Math.PI) / 180);
  if (roty) g.rotateY((roty * Math.PI) / 180);
  return g;
}

/** Build one part's positioned (but uncoloured) geometry, in metres. Caller disposes it. */
export function geometryForPart(p) {
  let g;
  if (p.k === 'b' || p.k === 'c') {
    const h = Math.max(0.1, p.h);
    if (p.k === 'b') {
      const w = Math.max(0.1, p.w), d = Math.max(0.1, p.d);
      const rd = Math.max(0, Math.min(p.rd || 0, w / 2, h / 2, d / 2));
      const w1 = Math.max(0.1, p.w1 ?? w), d1 = Math.max(0.1, p.d1 ?? d);
      const tapered = Math.abs(w1 - w) > 0.01 || Math.abs(d1 - d) > 0.01;
      if (rd > 0.01 && tapered) g = buildRoundedTaperedBox(w * M, h * M, d * M, w1 * M, d1 * M, rd * M);
      else if (rd > 0.01) g = buildRoundedBox(w * M, h * M, d * M, rd * M, ROUND_SEGMENTS);
      else if (tapered) g = buildTaperedBox(w * M, h * M, d * M, w1 * M, d1 * M);
      else g = new THREE.BoxGeometry(w * M, h * M, d * M);
    } else {
      g = new THREE.CylinderGeometry(Math.max(0.1, p.rt) * M, Math.max(0.1, p.r) * M, h * M, 16);
    }
    // Both are built centred (-h/2..+h/2). Shift the base up to the local origin FIRST, so
    // tiltAndSpin below pivots around the base (where it meets its neighbours/the item's frame),
    // not the middle of the part — then place that same base point straight at (p.x,p.y,p.z), no
    // extra +h/2 needed since the shift already happened. tilt=roty=0 (the vast majority of
    // parts, and every one before this feature existed) reduces this to exactly the old behaviour.
    g.translate(0, (h / 2) * M, 0);
    tiltAndSpin(g, p.tilt, p.roty);
    g.translate(p.x * M, p.y * M, p.z * M);
  } else if (p.k === 'z') {
    g = new THREE.CylinderGeometry(p.r * M, p.r * M, p.h * M, 20);
    g.rotateX(Math.PI / 2);
    g.translate(p.x * M, p.y * M, p.z * M);
  } else if (p.k === 'm') {
    const w = Math.max(0.1, p.w), d = Math.max(0.1, p.d);
    const cols = Math.max(1, p.cols | 0), rows = Math.max(1, p.rows | 0);
    const n = (rows + 1) * (cols + 1);
    const arr = (a) => (Array.isArray(a) && a.length === n ? a : new Array(n).fill(0));
    const vh = arr(p.vh), vx = arr(p.vx), vz = arr(p.vz);
    g = buildMeshGrid(w * M, d * M, cols, rows, vh.map((v) => v * M), vx.map((v) => v * M), vz.map((v) => v * M));
    // Already sits at its own base (vh=0 plane = local origin) — no shift needed before pivoting,
    // same as the sphere's own centre-pivot case below.
    tiltAndSpin(g, p.tilt, p.roty);
    g.translate(p.x * M, p.y * M, p.z * M);
  } else {
    const r = Math.max(0.1, p.r), ry = Math.max(0.1, p.ry ?? r), rz = Math.max(0.1, p.rz ?? r);
    g = new THREE.SphereGeometry(1, 12, 8);
    g.scale(r * M, ry * M, rz * M); // unit sphere -> ellipsoid; cheaper than rebuilding per-axis
    tiltAndSpin(g, p.tilt, p.roty); // already centred on its own y=centre — pivots correctly as-is
    g.translate(p.x * M, p.y * M, p.z * M);
  }
  g.deleteAttribute('uv');
  return g;
}

/** Paint a part's geometry with one flat vertex colour (a THREE.Color, see resolveColor). */
export function paintGeometry(g, col) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = col.r;
    arr[i * 3 + 1] = col.g;
    arr[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Build one merged, vertex-coloured BufferGeometry (metres) for an item. */
export function buildItemGeometry(type, w, d, h, color) {
  const entry = lookupItem(type);
  let parts;
  try {
    parts = entry ? entry.parts(w, d, h) : null;
  } catch (err) {
    console.warn('buildItemGeometry: lỗi khi dựng', type, err);
    parts = null;
  }
  if (!parts || !parts.length) parts = [{ k: 'b', x: 0, y: 0, z: 0, w: Math.max(2, w), h: Math.max(2, h), d: Math.max(2, d), c: 'main' }];
  const geos = parts.map((p) => paintGeometry(geometryForPart(p), resolveColor(p.c, color)));
  const merged = THREE.mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/** Default document fields for a freshly placed item. */
export function spawnItem(entry, x = 0, z = 0) {
  return {
    type: entry.id, name: entry.name, x, z, y: entry.y || 0, rot: 0,
    w: entry.size[0], d: entry.size[1], h: entry.size[2], color: entry.color, locked: false,
  };
}

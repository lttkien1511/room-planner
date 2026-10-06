// Document model + undo/redo. The document is plain JSON (cm) so it can be autosaved,
// exported, and stored on the server unchanged.
//
//   doc = { v, settings:{wallHeight,wallThickness,wallColor,floorColor},
//           walls:[{id,a:[x,z],b:[x,z],t,h?}], floors:[{id,pts:[[x,z]..],color}],
//           items:[{id,type,name,x,z,y,rot,w,d,h,color,locked}] }
//
// rot = degrees, clockwise when seen from above. Item -z is its back, +z its front.
import { clamp, clone, uid, Emitter, dist, normDeg, polygonArea, insetPolygon } from './util.js';
import { lookupItem } from './catalog.js';

export const DOC_V = 1;
export const DEFAULTS = { wallHeight: 270, wallThickness: 10, wallColor: '#ece8e1', floorColor: '#d9c9ab' };

export function newDoc() {
  return { v: DOC_V, settings: { ...DEFAULTS }, walls: [], floors: [], items: [] };
}

const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const fin = (v, d, lo, hi) => {
  v = Number(v);
  return Number.isFinite(v) ? clamp(v, lo, hi) : d;
};
const pt = (p) => (Array.isArray(p) && p.length >= 2 ? [fin(p[0], 0, -1e5, 1e5), fin(p[1], 0, -1e5, 1e5)] : null);

/** Validate + normalise any document (import / server / autosave). Never throws. */
export function sanitizeDoc(raw) {
  const doc = newDoc();
  const report = { droppedItems: 0, ok: false };
  if (!raw || typeof raw !== 'object') return { doc, report };
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  doc.settings.wallHeight = fin(s.wallHeight, DEFAULTS.wallHeight, 50, 600);
  doc.settings.wallThickness = fin(s.wallThickness, DEFAULTS.wallThickness, 2, 100);
  doc.settings.wallColor = isHex(s.wallColor) ? s.wallColor.toLowerCase() : DEFAULTS.wallColor;
  doc.settings.floorColor = isHex(s.floorColor) ? s.floorColor.toLowerCase() : DEFAULTS.floorColor;

  const used = new Set();
  const idOf = (v, prefix) => {
    let id = typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v) ? v : uid(prefix);
    while (used.has(id)) id = uid(prefix);
    used.add(id);
    return id;
  };

  for (const w of (Array.isArray(raw.walls) ? raw.walls : []).slice(0, 2000)) {
    const a = pt(w?.a), b = pt(w?.b);
    if (!a || !b) continue;
    const wall = { id: idOf(w.id, 'w'), a, b, t: fin(w.t, doc.settings.wallThickness, 2, 100) };
    if (w.h != null) wall.h = fin(w.h, doc.settings.wallHeight, 20, 600);
    doc.walls.push(wall);
  }
  for (const f of (Array.isArray(raw.floors) ? raw.floors : []).slice(0, 200)) {
    const pts = (Array.isArray(f?.pts) ? f.pts : []).slice(0, 500).map(pt).filter(Boolean);
    if (pts.length < 3) continue;
    doc.floors.push({ id: idOf(f.id, 'f'), pts, color: isHex(f.color) ? f.color.toLowerCase() : doc.settings.floorColor });
  }
  for (const it of (Array.isArray(raw.items) ? raw.items : []).slice(0, 3000)) {
    const entry = lookupItem(it?.type);
    if (!entry) {
      report.droppedItems++; // unknown built-in id, or a custom item deleted/not-yet-loaded from the library
      continue;
    }
    doc.items.push({
      id: idOf(it.id, 'i'),
      type: entry.id,
      name: typeof it.name === 'string' ? it.name.slice(0, 60) : entry.name,
      x: fin(it.x, 0, -1e5, 1e5), z: fin(it.z, 0, -1e5, 1e5), y: fin(it.y, entry.y || 0, 0, 1000),
      rot: normDeg(fin(it.rot, 0, -1e5, 1e5)),
      w: fin(it.w, entry.size[0], 2, 3000), d: fin(it.d, entry.size[1], 2, 3000), h: fin(it.h, entry.size[2], 0.5, 1000),
      color: isHex(it.color) ? it.color.toLowerCase() : entry.color,
      locked: !!it.locked,
    });
  }
  report.ok = true;
  return { doc, report };
}

export const wallLength = (w) => dist(w.a, w.b);

const near = (p, q) => Math.abs(p[0] - q[0]) < 0.6 && Math.abs(p[1] - q[1]) < 0.6;

/** Wall length between the inner faces: a wall end that meets another wall loses t/2. */
export function wallInnerLength(doc, w) {
  const t = w.t ?? doc.settings.wallThickness;
  let len = wallLength(w);
  for (const end of [w.a, w.b]) {
    if (doc.walls.some((o) => o !== w && (near(o.a, end) || near(o.b, end)))) len -= t / 2;
  }
  return Math.max(0, len);
}

/** Room area (cm²) measured to the inner wall faces; floors are stored on the wall centre-lines. */
export function floorInnerArea(doc, f) {
  const ts = doc.walls.filter((w) => f.pts.some((p) => near(p, w.a) || near(p, w.b))).map((w) => w.t ?? doc.settings.wallThickness);
  const t = ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : 0;
  return polygonArea(insetPolygon(f.pts, t / 2));
}

export class Store extends Emitter {
  constructor() {
    super();
    this.reset(newDoc());
  }

  /** Replace the whole document (new / open / import). Clears history. */
  reset(doc) {
    this.doc = doc;
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this._base = JSON.stringify(doc);
    this.emit('reset');
    this.emit('doc', 'reset');
    this.emit('select');
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Announce a live (uncommitted) change, e.g. while dragging. */
  touch() { this.emit('doc', 'live'); }

  /** Record the current state as an undo step. Returns false if nothing changed. */
  commit() {
    const s = JSON.stringify(this.doc);
    if (s === this._base) return false;
    this.undoStack.push(this._base);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this._base = s;
    this.redoStack.length = 0;
    this.emit('doc', 'commit');
    return true;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._base);
    this._base = this.undoStack.pop();
    this.doc = JSON.parse(this._base);
    this._fixSelection();
    this.emit('doc', 'undo');
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._base);
    this._base = this.redoStack.pop();
    this.doc = JSON.parse(this._base);
    this._fixSelection();
    this.emit('doc', 'redo');
  }

  _fixSelection() {
    if (this.sel && !this.find(this.sel.kind, this.sel.id)) this.sel = null;
    this.emit('select');
  }

  select(kind, id) {
    const next = kind ? { kind, id } : null;
    if (JSON.stringify(next) === JSON.stringify(this.sel)) return;
    this.sel = next;
    this.emit('select');
  }

  // ---- lookups ----
  list(kind) { return kind === 'item' ? this.doc.items : kind === 'wall' ? this.doc.walls : this.doc.floors; }
  find(kind, id) { return this.list(kind).find((o) => o.id === id) || null; }
  get selected() { return this.sel ? this.find(this.sel.kind, this.sel.id) : null; }

  // ---- mutations (callers commit() when the user action is complete) ----
  addItem(fields) {
    const it = { id: uid('i'), ...fields };
    this.doc.items.push(it);
    this.touch();
    return it;
  }

  addWall(a, b, t, h) {
    const w = { id: uid('w'), a: [...a], b: [...b], t: t ?? this.doc.settings.wallThickness };
    if (h != null) w.h = h;
    this.doc.walls.push(w);
    this.touch();
    return w;
  }

  addFloor(pts, color) {
    const f = { id: uid('f'), pts: pts.map((p) => [...p]), color: color || this.doc.settings.floorColor };
    this.doc.floors.push(f);
    this.touch();
    return f;
  }

  removeSelected() {
    if (!this.sel) return false;
    const list = this.list(this.sel.kind);
    const i = list.findIndex((o) => o.id === this.sel.id);
    if (i < 0) return false;
    list.splice(i, 1);
    this.sel = null;
    this.emit('select');
    this.touch();
    return this.commit();
  }

  /** Move every wall end / floor corner sitting at `from` to `to` (keeps rooms closed). */
  moveCorner(from, to) {
    const near = (p) => Math.abs(p[0] - from[0]) < 0.6 && Math.abs(p[1] - from[1]) < 0.6;
    for (const w of this.doc.walls) {
      if (near(w.a)) w.a = [...to];
      if (near(w.b)) w.b = [...to];
    }
    for (const f of this.doc.floors) f.pts = f.pts.map((p) => (near(p) ? [...to] : p));
  }

  /** Replace/add a rectangular room: interior w x d (cm), walls centred on its outline. */
  addRoomRect(w, d, t, h, replace) {
    if (replace) {
      this.doc.walls = [];
      this.doc.floors = [];
    }
    const hw = w / 2, hd = d / 2, o = t / 2;
    const c = [[-hw - o, -hd - o], [hw + o, -hd - o], [hw + o, hd + o], [-hw - o, hd + o]];
    for (let i = 0; i < 4; i++) this.addWall(c[i], c[(i + 1) % 4], t);
    this.addFloor(c); // same corners as the walls, so dragging a corner moves the floor too
    this.doc.settings.wallThickness = t;
    this.doc.settings.wallHeight = h;
    this.touch();
    return this.commit();
  }

  duplicateSelected() {
    const src = this.sel?.kind === 'item' ? this.selected : null;
    if (!src) return null;
    const copy = { ...clone(src), id: uid('i'), x: src.x + 30, z: src.z + 30 };
    this.doc.items.push(copy);
    this.select('item', copy.id);
    this.touch();
    this.commit();
    return copy;
  }

  /** Bounding box of everything, in cm: {minX,maxX,minZ,maxZ,maxY} or null if empty. */
  bounds() {
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: 0 };
    const add = (x, z) => {
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    };
    for (const w of this.doc.walls) { add(...w.a); add(...w.b); b.maxY = Math.max(b.maxY, w.h ?? this.doc.settings.wallHeight); }
    for (const f of this.doc.floors) for (const p of f.pts) add(...p);
    for (const it of this.doc.items) {
      const r = Math.hypot(it.w, it.d) / 2;
      add(it.x - r, it.z - r);
      add(it.x + r, it.z + r);
      b.maxY = Math.max(b.maxY, (it.y || 0) + it.h);
    }
    return Number.isFinite(b.minX) ? b : null;
  }
}

// Data/session layer for "Tự tạo đồ vật" (the visual block-builder dialog). Pure part algebra
// here; 3D rendering is blockeditor-view.js, pointer handling is blockeditor-interact.js.
//
// A part while editing is absolute cm, same fields as catalog.js's part shape plus a local `id`
// (for list/selection — never sent to the server). y = base for box/cylinder, y = centre for
// sphere — matching catalog.js's own convention, so parts render identically once saved.
import { Emitter, uid, clamp } from './util.js';
import { applyTemplate, templateFromParts, MESH_MAX_GRID } from './catalog.js';

export const MAX_PARTS = 200;
const MESH_DEFAULT_ROWS = 3, MESH_DEFAULT_COLS = 4;
const clampSize = (v) => clamp(v, 1, 600);
const clampSpan = (v) => clamp(v, -900, 900);

export function newPart(kind, box) {
  const [w, d, h] = box;
  const id = uid('p');
  if (kind === 'c') return { id, k: 'c', x: 0, y: 0, z: 0, r: Math.min(w, d) * 0.18, rt: Math.min(w, d) * 0.18, h: h * 0.5, c: 'main', roty: 0, tilt: 0 };
  if (kind === 's') { const r = Math.min(w, d, h) * 0.18; return { id, k: 's', x: 0, y: h * 0.5, z: 0, r, ry: r, rz: r, roty: 0, tilt: 0, c: 'main' }; }
  if (kind === 'm') {
    const rows = MESH_DEFAULT_ROWS, cols = MESH_DEFAULT_COLS;
    const n = (rows + 1) * (cols + 1);
    return { id, k: 'm', x: 0, y: 0, z: 0, w: w * 0.5, d: d * 0.5, rows, cols, vh: new Array(n).fill(0), vx: new Array(n).fill(0), vz: new Array(n).fill(0), roty: 0, tilt: 0, c: 'main' };
  }
  const bw = w * 0.5, bd = d * 0.5;
  return { id, k: 'b', x: 0, y: 0, z: 0, w: bw, h: h * 0.4, d: bd, c: 'main', rd: 0, w1: bw, d1: bd, roty: 0, tilt: 0 };
}

export const clonePart = (p) => ({ ...p, id: uid('p') });

/** Part's own axis-aligned bounds in cm: {minX,maxX,minY,maxY,minZ,maxZ}. */
export function partBounds(p) {
  if (p.k === 'b') return { minX: p.x - p.w / 2, maxX: p.x + p.w / 2, minY: p.y, maxY: p.y + p.h, minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2 };
  if (p.k === 'c') {
    const r = Math.max(p.r, p.rt);
    return { minX: p.x - r, maxX: p.x + r, minY: p.y, maxY: p.y + p.h, minZ: p.z - r, maxZ: p.z + r };
  }
  if (p.k === 'm') {
    const vh = p.vh && p.vh.length ? p.vh : [0];
    const vx = p.vx && p.vx.length ? p.vx : [0];
    const vz = p.vz && p.vz.length ? p.vz : [0];
    const halfW = p.w / 2 + Math.max(0, ...vx.map(Math.abs));
    const halfD = p.d / 2 + Math.max(0, ...vz.map(Math.abs));
    return { minX: p.x - halfW, maxX: p.x + halfW, minY: p.y + Math.min(0, ...vh), maxY: p.y + Math.max(0, ...vh), minZ: p.z - halfD, maxZ: p.z + halfD };
  }
  return { minX: p.x - p.r, maxX: p.x + p.r, minY: p.y - p.r, maxY: p.y + p.r, minZ: p.z - p.r, maxZ: p.z + p.r };
}

// ---------- mesh vertex helpers (pure algebra — no three.js needed) --------------------------
// Same rotateZ(tilt)-then-rotateY(roty) transform geometryForPart applies to the whole mesh in
// catalog.js's tiltAndSpin, done here on a single point/direction instead of a geometry buffer —
// used to place a vertex's drag handle and to know which world-space axis dragging it moves along.
function rotatePoint(x, y, z, tiltDeg, rotyDeg) {
  const t = (tiltDeg * Math.PI) / 180, r = (rotyDeg * Math.PI) / 180;
  const x1 = x * Math.cos(t) - y * Math.sin(t), y1 = x * Math.sin(t) + y * Math.cos(t), z1 = z;
  const x2 = x1 * Math.cos(r) + z1 * Math.sin(r), z2 = -x1 * Math.sin(r) + z1 * Math.cos(r);
  return [x2, y1, z2];
}

/** Inverse of rotatePoint (rotateZ(tilt) then rotateY(roty) is an orthonormal transform, so its
 * inverse is undo-Y-then-undo-Z with negated angles) — turns a world-space offset back into the
 * mesh's own local frame, used to recover a dragged vertex's new local x/z from a world hit point. */
function unrotatePoint(x2, y2, z2, tiltDeg, rotyDeg) {
  const t = (tiltDeg * Math.PI) / 180, r = (rotyDeg * Math.PI) / 180;
  const x1 = x2 * Math.cos(r) - z2 * Math.sin(r), z1 = x2 * Math.sin(r) + z2 * Math.cos(r), y1 = y2;
  const x = x1 * Math.cos(t) + y1 * Math.sin(t), y = -x1 * Math.sin(t) + y1 * Math.cos(t);
  return [x, y, z1];
}

/** A mesh vertex's local (x,z) slot in the regular grid (before its own vx/vz offset) — the "rest
 * position" that resizeMeshGrid/flattenMesh reset back to. */
function meshGridSlot(p, i) {
  const cols1 = p.cols + 1;
  const col = i % cols1, row = Math.floor(i / cols1);
  return [(col / p.cols - 0.5) * p.w, (row / p.rows - 0.5) * p.d];
}

/** World position (cm) of mesh part `p`'s vertex `i` (row-major, matches buildMeshGrid's indexing) —
 * its regular grid slot plus its own in-plane (vx/vz) and height (vh) offsets. */
export function meshVertexPos(p, i) {
  const [gx, gz] = meshGridSlot(p, i);
  const lx = gx + (p.vx ? p.vx[i] : 0), lz = gz + (p.vz ? p.vz[i] : 0), ly = p.vh[i];
  const [wx, wy, wz] = rotatePoint(lx, ly, lz, p.tilt || 0, p.roty || 0);
  return [p.x + wx, p.y + wy, p.z + wz];
}

/** World-space unit direction a vertex moves along as its height (vh[i]) increases, and the normal
 * of the plane a free X/Z (in-mesh-plane) drag happens in — the same for every vertex of a part,
 * since tilt/roty rotate the whole mesh rigidly. */
export function meshNormalDir(p) {
  const [x, y, z] = rotatePoint(0, 1, 0, p.tilt || 0, p.roty || 0);
  return { x, y, z };
}

/**
 * Moves every vertex index in `selected` together, rigidly, by whatever height delta `t` (cm) the
 * drag on the anchor vertex produced — the Shift-constrained (Z-only) group drag. A lone selected
 * vertex is just the single-vertex case of this (a 1-element set), so there's no separate function
 * for it. Indices not in `selected` are left untouched (same array positions copied as-is).
 */
export function moveSelectedVerticesZ(part, selected, t) {
  const vh = part.vh.slice();
  for (const i of selected) vh[i] = clamp(part.vh[i] + t, -300, 300);
  return { ...part, vh };
}

/**
 * Moves every vertex index in `selected` together, rigidly, within the mesh's own X/Z plane: the
 * anchor vertex (`anchorIndex`, the one actually grabbed) has its new absolute local (x,z) solved
 * from `worldHit` — a point on the plane through its current position (see meshNormalDir) —
 * unrotated back into the part's local frame. The same (dx,dz) delta that movement produced is then
 * applied to every other selected vertex's existing vx/vz — a rigid translation, since rotation is
 * linear. Indices not in `selected` are left untouched.
 */
export function moveSelectedVerticesXZ(part, selected, anchorIndex, worldHit) {
  const [hx, hy, hz] = worldHit;
  const [lx, , lz] = unrotatePoint(hx - part.x, hy - part.y, hz - part.z, part.tilt || 0, part.roty || 0);
  const [gx, gz] = meshGridSlot(part, anchorIndex);
  const dx = (lx - gx) - part.vx[anchorIndex];
  const dz = (lz - gz) - part.vz[anchorIndex];
  const vx = part.vx.slice(), vz = part.vz.slice();
  for (const i of selected) {
    vx[i] = clamp(part.vx[i] + dx, -300, 300);
    vz[i] = clamp(part.vz[i] + dz, -300, 300);
  }
  return { ...part, vx, vz };
}

/** Changes grid resolution — resets to a flat, unshaped plane (the old offsets don't map cleanly
 * onto a different vertex count), so the UI warns before calling this. */
export function resizeMeshGrid(part, rows, cols) {
  rows = clamp(Math.round(rows), 1, MESH_MAX_GRID);
  cols = clamp(Math.round(cols), 1, MESH_MAX_GRID);
  const n = (rows + 1) * (cols + 1);
  return { ...part, rows, cols, vh: new Array(n).fill(0), vx: new Array(n).fill(0), vz: new Array(n).fill(0) };
}

/** Resets every vertex back to its regular grid slot — undoes both the 2D outline reshaping and
 * the 3D height sculpting in one step. */
export function flattenMesh(part) {
  return { ...part, vh: part.vh.map(() => 0), vx: part.vx.map(() => 0), vz: part.vz.map(() => 0) };
}

/** Resize one face of a box (axis 'x'|'z') or the height (axis 'y') of a box/cylinder.
 * `part` must be the part as it was when the drag STARTED (never a mid-drag value), so the
 * opposite face stays anchored instead of drifting. `sign` says which face moved (+1/-1); for
 * 'y' the base is always the anchor (matches the base-of-part convention), so sign is unused. */
export function resizeFace(part, axis, sign, newSize) {
  newSize = clampSize(newSize);
  const p = { ...part };
  if (axis === 'y') {
    p.h = newSize;
    return p;
  }
  const key = axis === 'x' ? 'w' : 'd';
  const half = part[key] / 2;
  const fixedFace = part[axis] - sign * half;
  p[key] = newSize;
  p[axis] = fixedFace + sign * (newSize / 2);
  return p;
}

export function resizeRadius(part, newRadius) {
  newRadius = clamp(newRadius, 1, 300);
  return { ...part, r: newRadius, rt: newRadius };
}

export function moveVertical(part, newY) {
  return { ...part, y: clampSpan(newY) };
}

export function moveHorizontal(part, x, z) {
  return { ...part, x: clampSpan(x), z: clampSpan(z) };
}

/**
 * One editing session: the item's overall box/name/color plus its parts (absolute cm). No
 * undo/redo — Huỷ discards the whole session, Lưu commits it in one PUT.
 *
 * emit('select')    selection changed (right panel needs a full rebuild: different fields per kind)
 * emit('structure') a part was added/removed/duplicated, or the session was reset (list needs a full rebuild)
 * emit('value')     a field changed value only (drag, or typing a number) — refresh displayed values in place
 */
export class BlockSession extends Emitter {
  constructor() {
    super();
    this.reset(null);
  }

  /** `existing`: a registered custom-item entry (id/name/size/color/template/rev), or null for a new item. */
  reset(existing) {
    if (existing) {
      this.editingId = existing.id;
      this.baseRev = existing.rev || 1;
      this.name = existing.name;
      this.box = [...existing.size];
      this.color = existing.color;
      this.parts = applyTemplate(existing.template, ...existing.size).map((p) => ({ ...p, id: uid('p') }));
    } else {
      this.editingId = null;
      this.baseRev = 0;
      this.name = 'Đồ vật mới';
      this.box = [50, 50, 50];
      this.color = '#c9b79c';
      this.parts = [];
    }
    this.selectedId = null;
    this.selectedVertices = new Set();
    this.emit('structure');
  }

  /**
   * Start a brand-new, unsaved item pre-filled with a copy of `template` (same fractional format
   * as a stored custom item's) at `size`/`color`, named `name` — used by "Nhân bản để chỉnh sửa"
   * on a catalogue or custom-item card. `editingId` stays null, so Lưu always creates a separate
   * new library entry; the source item (built-in or custom) is only ever read, never touched.
   */
  startFrom(name, size, color, template) {
    this.editingId = null;
    this.baseRev = 0;
    this.name = name;
    this.box = [...size];
    this.color = color;
    this.parts = applyTemplate(template, ...size).map((p) => ({ ...p, id: uid('p') }));
    this.selectedId = null;
    this.selectedVertices = new Set();
    this.emit('structure');
  }

  setBox(w, d, h) {
    this.box = [clamp(w, 5, 600), clamp(d, 5, 600), clamp(h, 5, 600)];
    this.emit('value');
  }

  setName(name) {
    this.name = name;
    this.emit('value');
  }

  setColor(hex) {
    this.color = hex;
    this.emit('value');
  }

  /** Returns the new part, or null when MAX_PARTS is already reached. */
  addPart(kind) {
    if (this.parts.length >= MAX_PARTS) return null;
    const p = newPart(kind, this.box);
    this.parts.push(p);
    this.selectedId = p.id;
    this.selectedVertices = new Set();
    this.emit('structure');
    return p;
  }

  duplicateSelected() {
    const src = this.selectedPart;
    if (!src) return;
    const c = clonePart(src);
    c.x = clampSpan(c.x + 5);
    c.z = clampSpan(c.z + 5);
    this.parts.push(c);
    this.selectedId = c.id;
    this.selectedVertices = new Set();
    this.emit('structure');
  }

  removeSelected() {
    if (!this.selectedId) return;
    this.parts = this.parts.filter((p) => p.id !== this.selectedId);
    this.selectedId = null;
    this.selectedVertices = new Set();
    this.emit('structure');
  }

  select(id) {
    this.selectedVertices = new Set();
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('select');
  }

  // ---------- mesh vertex (multi-)selection ------------------------------------------------
  // `selectedVertices` is a plain Set<number> of vertex indices within the currently selected
  // mesh part — a sub-selection, independent of `selectedId` (which part). See the class doc
  // comment at the bottom of this file for how this is meant to extend to proportional editing.

  isVertexSelected(i) {
    return this.selectedVertices.has(i);
  }

  /** Replaces the selection with exactly vertex `i` — a plain click on a vertex not already part
   * of a multi-selection. */
  selectVertex(i) {
    this.selectedVertices = new Set([i]);
    this.emit('value');
  }

  /** Adds/removes vertex `i` without touching the rest of the selection — Ctrl/Cmd+click. */
  toggleVertex(i) {
    const s = new Set(this.selectedVertices);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    this.selectedVertices = s;
    this.emit('value');
  }

  /** Replaces the whole selection with `indices` — the result of a plain box-select drag. */
  setSelectedVertices(indices) {
    this.selectedVertices = new Set(indices);
    this.emit('value');
  }

  /** Unions `indices` into the existing selection — a Ctrl/Cmd+box-select drag. */
  addSelectedVertices(indices) {
    const s = new Set(this.selectedVertices);
    for (const i of indices) s.add(i);
    this.selectedVertices = s;
    this.emit('value');
  }

  /** "Bỏ chọn tất cả" — clears the vertex selection without touching which part is selected. */
  clearVertexSelection() {
    if (this.selectedVertices.size === 0) return;
    this.selectedVertices = new Set();
    this.emit('value');
  }

  /**
   * Update one part by id (drags/number fields always pass a full next-part object). Mutates the
   * existing part object in place rather than swapping in a new one, so the right panel's number
   * fields — which close over the part object, not its id — keep reading/writing live values
   * instead of a snapshot frozen at the last full re-render (they'd otherwise go stale the moment
   * any single drag or edit happened, including reverting a field you just typed into).
   */
  replacePart(id, next) {
    const p = this.parts.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, next, { id });
    this.emit('value');
  }

  get selectedPart() {
    return this.parts.find((p) => p.id === this.selectedId) || null;
  }

  /** Server-ready record for storage.saveCustomItem(). */
  toRecord() {
    const [w, d, h] = this.box;
    return { name: (this.name || '').trim().slice(0, 60) || 'Đồ vật', size: [w, d, h], color: this.color, template: templateFromParts(this.parts, w, d, h) };
  }
}

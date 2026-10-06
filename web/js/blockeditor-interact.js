// Pointer wiring for the block-builder's mini viewport: click a part to select it, drag its body
// to move (X/Z at its current height), drag a handle to resize/move vertically. All the actual
// part algebra lives in blockbuilder.js — this file only turns pointer events into calls to it.
import {
  moveHorizontal, moveVertical, resizeFace, resizeRadius,
  meshVertexPos, meshNormalDir, moveSelectedVerticesZ, moveSelectedVerticesXZ,
} from './blockbuilder.js';

const TAP_PX = 5;

export class BlockInteract {
  constructor(view, session) {
    this.v = view;
    this.s = session;
    this.down = null;
    this.drag = null;

    const c = view.container;
    c.addEventListener('pointerdown', (e) => this.onDown(e), true);
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  onDown(e) {
    if (e.button !== 0 || !e.isPrimary || !this.v.contains(e.clientX, e.clientY)) return;
    this.down = { x: e.clientX, y: e.clientY, moved: false };
    const hit = this.v.pick(e.clientX, e.clientY);
    if (!hit) {
      this.drag = null;
      this.down.empty = true; // a plain tap here (not a camera-orbit drag) deselects, see onUp
      const p = this.s.selectedPart;
      if (p && p.k === 'm') {
        // Might turn into a box-select drag (see onMove) — disable orbiting pre-emptively so a
        // drag that starts here never rotates the camera instead; re-enabled in onUp regardless.
        this.down.boxSelect = true;
        this.down.boxAdd = e.ctrlKey || e.metaKey;
        this.v.setControlsEnabled(false);
        this.v.beginSelectionBox(e.clientX, e.clientY);
      }
      return;
    }
    if (hit.partId) {
      this.s.clearVertexSelection(); // clicking the body (not a vertex) always drops any vertex highlight
      this.s.select(hit.partId);
      this.drag = { kind: 'move', original: { ...this.s.selectedPart } };
      this.v.setControlsEnabled(false);
    } else if (hit.handle) {
      const p = this.s.selectedPart;
      if (!p) return;
      if (hit.handle.startsWith('vert:')) {
        const i = parseInt(hit.handle.slice(5), 10);
        if (e.ctrlKey || e.metaKey) {
          this.s.toggleVertex(i); // selection-only gesture — no transform drag follows
          return;
        }
        // A plain click on a vertex already part of a multi-selection keeps the whole group
        // selected (so it drags together); otherwise it replaces the selection with just this one.
        if (!this.s.isVertexSelected(i)) this.s.selectVertex(i);
      } else {
        this.s.clearVertexSelection();
      }
      // Shift+drag constrains the selected vertex/vertices to their height (Z) axis, matching the
      // old single-axis behaviour; a plain drag moves them freely within the mesh's own X/Y plane.
      this.drag = { kind: 'handle', name: hit.handle, original: { ...p }, constrainZ: e.shiftKey };
      this.v.setControlsEnabled(false);
    }
  }

  onMove(e) {
    if (this.down && !this.down.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > TAP_PX) this.down.moved = true;
    if (this.down?.boxSelect) {
      if (this.down.moved) this.v.updateSelectionBox(e.clientX, e.clientY);
      return;
    }
    if (!this.drag || !this.down?.moved) return;
    if (this.drag.kind === 'move') this._dragMove(e);
    else this._dragHandle(e);
  }

  onUp(e) {
    if (this.down?.boxSelect) {
      if (this.down.moved) {
        const p = this.s.selectedPart;
        const idx = p ? this.v.vertsInScreenRect(p, this.down.x, this.down.y, e.clientX, e.clientY) : [];
        if (this.down.boxAdd) this.s.addSelectedVertices(idx);
        else this.s.setSelectedVertices(idx);
      } else {
        this.s.select(null); // plain tap on empty space still deselects the whole part
      }
      this.v.endSelectionBox();
    } else if (this.down && !this.down.moved && this.down.empty) {
      // A tap (no drag) that started on empty space — not a camera-orbit drag from the same spot —
      // deselects the current part, which also hides its drag handles (syncOverlay only draws them
      // for session.selectedPart).
      this.s.select(null);
    }
    this.drag = null;
    this.down = null;
    this.v.setControlsEnabled(true);
  }

  _dragMove(e) {
    const o = this.drag.original;
    const yLevel = o.k === 's' ? o.y : o.y + (o.h || 0) / 2; // drag the body in the plane through its middle
    const p = this.v.floorPointAtY(e.clientX, e.clientY, yLevel);
    if (!p) return;
    this.s.replacePart(o.id, moveHorizontal(o, p[0], p[1]));
  }

  _dragHandle(e) {
    const o = this.drag.original;
    const name = this.drag.name;
    if (name.startsWith('vert:')) {
      const i = parseInt(name.slice(5), 10); // the grabbed (anchor) vertex — onDown guarantees it's selected
      const selected = this.s.selectedVertices;
      if (this.drag.constrainZ) {
        const t = this.v.axisT(e.clientX, e.clientY, meshVertexPos(o, i), meshNormalDir(o));
        if (t != null) this.s.replacePart(o.id, moveSelectedVerticesZ(o, selected, t));
      } else {
        const hit = this.v.planeHit(e.clientX, e.clientY, meshVertexPos(o, i), meshNormalDir(o));
        if (hit) this.s.replacePart(o.id, moveSelectedVerticesXZ(o, selected, i, hit));
      }
    } else if (name === 'moveY') {
      const t = this.v.axisT(e.clientX, e.clientY, [o.x, 0, o.z], { x: 0, y: 1, z: 0 });
      if (t != null) this.s.replacePart(o.id, moveVertical(o, t));
    } else if (name === 'h+') {
      const t = this.v.axisT(e.clientX, e.clientY, [o.x, o.y, o.z], { x: 0, y: 1, z: 0 });
      if (t != null) this.s.replacePart(o.id, resizeFace(o, 'y', 1, t));
    } else if (name === 'radius') {
      const cy = o.k === 'c' ? o.y + o.h / 2 : o.y;
      const t = this.v.axisT(e.clientX, e.clientY, [o.x, cy, o.z], { x: 1, y: 0, z: 0 });
      if (t != null) this.s.replacePart(o.id, resizeRadius(o, t));
    } else if (name === 'x+' || name === 'x-') {
      const sign = name === 'x+' ? 1 : -1;
      const fixed = o.x - sign * (o.w / 2);
      const t = this.v.axisT(e.clientX, e.clientY, [fixed, o.y + o.h / 2, o.z], { x: sign, y: 0, z: 0 });
      if (t != null) this.s.replacePart(o.id, resizeFace(o, 'x', sign, t));
    } else if (name === 'z+' || name === 'z-') {
      const sign = name === 'z+' ? 1 : -1;
      const fixed = o.z - sign * (o.d / 2);
      const t = this.v.axisT(e.clientX, e.clientY, [o.x, o.y + o.h / 2, fixed], { x: 0, y: 0, z: sign });
      if (t != null) this.s.replacePart(o.id, resizeFace(o, 'z', sign, t));
    }
  }
}

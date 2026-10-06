// Pointer/keyboard tools on top of the viewport: select/move/rotate, draw walls/rooms,
// place items from the catalogue. Pointer events only (works with mouse, pen and touch).
//
// OrbitControls listens on the canvas; we listen on the container in the CAPTURE phase and
// switch controls off while we own the gesture (dragging an item, a handle, ...).
import { DEG, Emitter, snapTo, dot, dist, round1, normDeg, fmtLen } from './util.js';
import { spawnItem, isBackToWall } from './catalog.js';

const TAP_PX = 5; // pointer travel below this counts as a click
const MAGNET_CM = 14; // draw/handle magnet radius to existing wall ends
const WALL_SNAP_CM = 12;

/**
 * Snap an item flush against nearby walls (and square it up to them when it is already
 * within 10 degrees). Works on the item's oriented box; rot = clockwise degrees.
 */
export function snapToWalls(it, walls, defThickness, thr = WALL_SNAP_CM) {
  let { x, z, rot } = it;
  const backToWall = isBackToWall(it.type);
  const hw = it.w / 2, hd = it.d / 2;
  for (let pass = 0; pass < 2; pass++) {
    const r = rot * DEG;
    const ax = [Math.cos(r), Math.sin(r)], az = [-Math.sin(r), Math.cos(r)];
    let best = null;
    for (const w of walls) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const u = [dx / len, dz / len], n = [-u[1], u[0]];
      const t = w.t ?? defThickness;
      const rn = hw * Math.abs(dot(ax, n)) + hd * Math.abs(dot(az, n));
      const ru = hw * Math.abs(dot(ax, u)) + hd * Math.abs(dot(az, u));
      const rel = [x - w.a[0], z - w.a[1]];
      const s = dot(rel, n), tp = dot(rel, u);
      if (tp + ru < 0 || tp - ru > len) continue; // not alongside this wall
      const gap = Math.abs(s) - (t / 2 + rn); // >0 clearance, <0 overlap into the wall
      // snap in when close; push back out when it sank into the wall (until its centre crosses the wall's centre-line)
      if (gap > thr || gap < -(rn + t / 2) * 0.98) continue;
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { n, s, gap, ang: Math.atan2(u[1], u[0]) / DEG };
    }
    if (!best) break;
    if (pass === 0) {
      if (backToWall) {
        // turn the item's back (-z) towards the wall: back = (sin r, -cos r) must equal the wall direction
        const sg = Math.sign(best.s) || 1;
        const target = normDeg(Math.atan2(-sg * best.n[0], sg * best.n[1]) / DEG);
        if (Math.abs(((target - rot + 540) % 360) - 180) > 0.01) {
          rot = target; // then re-measure the gap with the new footprint on the next pass
          continue;
        }
      } else {
        let delta = (((rot - best.ang) % 90) + 90) % 90;
        if (delta > 45) delta -= 90;
        if (Math.abs(delta) <= 10 && Math.abs(delta) > 0.01) {
          rot -= delta; // square up, then re-measure the gap on the next pass
          continue;
        }
      }
    }
    const sg = Math.sign(best.s);
    x -= best.n[0] * sg * best.gap;
    z -= best.n[1] * sg * best.gap;
  }
  return { x: round1(x), z: round1(z), rot: normDeg(round1(rot)) };
}

export class Interact extends Emitter {
  constructor(view, store, prefs) {
    super();
    this.v = view;
    this.s = store;
    this.prefs = prefs;
    this.tool = 'select';
    this.drag = null;
    this.down = null;
    this.placing = null;
    this.palette = false; // true while UI is dragging a catalogue card
    this.draw = { pts: [], cursor: null };
    this.last = { x: 0, y: 0 };

    const c = view.container;
    c.addEventListener('pointerdown', (e) => this.onDown(e), true);
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('dblclick', () => this.onDouble());
    window.addEventListener('keydown', (e) => this.onKey(e));
    store.on((k) => {
      if (k === 'select') this._syncSelectionLabels();
    });
    this._emitHint();
  }

  // ---------- tool management ----------------------------------------------------
  setTool(tool) {
    if (tool !== 'place') {
      this.placing = null;
      this.v.setPreview(null);
    }
    if (!tool.startsWith('draw')) this._resetDraw();
    this.tool = tool;
    this.v.container.dataset.tool = tool;
    this.emit('tool', tool);
    this._emitHint();
  }

  _emitHint() {
    const hints = {
      select: 'Kéo đồ vật để di chuyển · kéo chấm xanh để xoay · kéo vùng trống để xoay/dịch camera · R xoay 90° · Del xoá',
      'draw-room': 'Bấm để đặt từng góc phòng · bấm lại điểm đầu (hoặc nhấp đúp) để khép kín · Backspace bỏ điểm cuối · Esc huỷ',
      'draw-wall': 'Bấm để đặt từng đoạn tường nối tiếp · nhấp đúp hoặc Esc để dừng · giữ Alt để tắt snap',
      place: `Bấm vào sàn để đặt “${this.placing?.name ?? ''}” · giữ Shift để đặt liên tiếp · R xoay · Esc huỷ`,
    };
    this.hint = hints[this.tool] || '';
    this.emit('hint', this.hint);
  }

  _get(kind, id) { return this.s.find(kind, id); }
  get _snapOn() { return this.prefs.snap; }
  get _grid() { return this.prefs.grid; }

  // ---------- pointer -------------------------------------------------------------
  onDown(e) {
    if (e.button !== 0 || !e.isPrimary || this.palette) return;
    this.last = { x: e.clientX, y: e.clientY };
    this.down = { x: e.clientX, y: e.clientY, moved: false };
    if (this.tool !== 'select') {
      this.drag = { kind: 'tap' };
      if (this.tool === 'place') this.updatePlaceAt(e.clientX, e.clientY);
      else this._updateDrawCursor(e);
      return;
    }
    const hit = this.v.pick(e.clientX, e.clientY);
    if (!hit) {
      this.drag = { kind: 'empty' };
      return;
    }
    if (hit.type === 'rot') {
      this.drag = { kind: 'rot', id: hit.id };
      this.v.setControlsEnabled(false);
    } else if (hit.type === 'wallEnd') {
      const w = this._get('wall', hit.id);
      this.drag = { kind: 'wallEnd', id: hit.id, cur: [...w[hit.which]], other: [...w[hit.which === 'a' ? 'b' : 'a']] };
      this.v.setControlsEnabled(false);
    } else if (hit.type === 'item') {
      this.s.select('item', hit.id);
      const it = this._get('item', hit.id);
      const p = this.v.floorPoint(e.clientX, e.clientY);
      if (it && !it.locked && p) {
        this.drag = { kind: 'move', id: hit.id, off: [it.x - p[0], it.z - p[1]], baseRot: it.rot };
        this.v.setControlsEnabled(false);
      } else {
        this.drag = { kind: 'empty', keep: true };
      }
    } else {
      this.s.select(hit.type, hit.id);
      this.drag = { kind: 'empty', keep: true };
    }
  }

  onMove(e) {
    this.last = { x: e.clientX, y: e.clientY };
    if (this.down && !this.down.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > TAP_PX) this.down.moved = true;
    if (this.palette) {
      this.updatePlaceAt(e.clientX, e.clientY);
      return;
    }
    const d = this.drag;
    if (d && d.kind !== 'tap' && d.kind !== 'empty') {
      if (!this.down?.moved) return;
      if (d.kind === 'move') this._dragMove(d, e);
      else if (d.kind === 'rot') this._dragRot(d, e);
      else if (d.kind === 'wallEnd') this._dragWallEnd(d, e);
      return;
    }
    if (d || !this.v.contains(e.clientX, e.clientY)) return;
    if (e.target !== this.v.canvas) return; // hovering a panel/overlay
    if (this.tool === 'place') this.updatePlaceAt(e.clientX, e.clientY);
    else if (this.tool.startsWith('draw')) this._updateDrawCursor(e);
  }

  onUp(e, cancelled = false) {
    if (this.palette) return;
    const d = this.drag, down = this.down;
    this.drag = null;
    this.down = null;
    this.v.setControlsEnabled(true);
    if (!d) return;
    const tap = !!down && !down.moved && !cancelled;
    if (d.kind === 'wallEnd') this.v.setExtraLabels([]);
    if (d.kind === 'move' || d.kind === 'rot' || d.kind === 'wallEnd') this.s.commit();
    else if (d.kind === 'empty' && tap && !d.keep) this.s.select(null);
    else if (d.kind === 'tap' && tap && this.v.contains(e.clientX, e.clientY)) this._onTap(e);
  }

  onDouble() {
    if (this.tool === 'draw-room') this.finishDrawing();
    else if (this.tool === 'draw-wall') this._resetDraw();
  }

  // ---------- drags -------------------------------------------------------------
  _dragMove(d, e) {
    const it = this._get('item', d.id);
    const p = this.v.floorPoint(e.clientX, e.clientY);
    if (!it || !p) return;
    let x = p[0] + d.off[0], z = p[1] + d.off[1], rot = d.baseRot;
    if (this._snapOn && !e.altKey) {
      x = snapTo(x, this._grid);
      z = snapTo(z, this._grid);
      ({ x, z, rot } = snapToWalls({ ...it, x, z, rot }, this.s.doc.walls, this.s.doc.settings.wallThickness));
    }
    it.x = round1(x);
    it.z = round1(z);
    it.rot = normDeg(rot);
    this.s.touch();
  }

  _dragRot(d, e) {
    const it = this._get('item', d.id);
    const p = this.v.floorPoint(e.clientX, e.clientY);
    if (!it || !p) return;
    const vx = p[0] - it.x, vz = p[1] - it.z;
    if (Math.hypot(vx, vz) < 4) return;
    const step = this._snapOn && !e.altKey ? 15 : 1;
    it.rot = normDeg(Math.round(Math.atan2(-vx, vz) / DEG / step) * step);
    this.s.touch();
  }

  _dragWallEnd(d, e) {
    const raw = this.v.floorPoint(e.clientX, e.clientY);
    if (!raw) return;
    let p = raw;
    if (this._snapOn && !e.altKey) {
      p = this._magnet([snapTo(raw[0], this._grid), snapTo(raw[1], this._grid)], d.cur, d.other, e.shiftKey);
    }
    p = [round1(p[0]), round1(p[1])];
    if (dist(p, d.cur) < 0.05) return;
    this.s.moveCorner(d.cur, p);
    d.cur = p;
    this.s.touch();
    this._wallEndLabel(d);
  }

  _wallEndLabel(d) {
    const len = dist(d.cur, d.other);
    this.v.setExtraLabels([{ x: (d.cur[0] + d.other[0]) / 2, z: (d.cur[1] + d.other[1]) / 2, text: fmtLen(len), cls: 'tag' }]);
  }

  /** Snap `p` to nearby wall ends, else square it up against `ref` (axis assist). */
  _magnet(p, ignore, ref, noAssist, extra = []) {
    let best = null, bestD = MAGNET_CM;
    const cands = [...extra];
    for (const w of this.s.doc.walls) cands.push(w.a, w.b);
    for (const c of cands) {
      if (ignore && dist(c, ignore) < 0.6) continue;
      const dd = dist(c, p);
      if (dd < bestD) {
        best = c;
        bestD = dd;
      }
    }
    if (best) return [best[0], best[1]];
    if (ref && !noAssist) {
      const dx = p[0] - ref[0], dz = p[1] - ref[1];
      if (Math.abs(dx) <= Math.abs(dz) * 0.08) return [ref[0], p[1]];
      if (Math.abs(dz) <= Math.abs(dx) * 0.08) return [p[0], ref[1]];
    }
    return p;
  }

  // ---------- drawing -------------------------------------------------------------
  _resetDraw() {
    this.draw = { pts: [], cursor: null };
    this.v.setDrawPreview(null);
    this.v.setExtraLabels([]);
  }

  _drawPoint(e) {
    const raw = this.v.floorPoint(e.clientX, e.clientY);
    if (!raw) return null;
    let p = raw;
    const pts = this.draw.pts;
    if (this._snapOn && !e.altKey) {
      p = this._magnet([snapTo(raw[0], this._grid), snapTo(raw[1], this._grid)], null, pts[pts.length - 1], e.shiftKey, this.tool === 'draw-room' ? pts : []);
    }
    return [round1(p[0]), round1(p[1])];
  }

  _updateDrawCursor(e) {
    const p = this._drawPoint(e);
    if (!p) return;
    const pts = this.draw.pts;
    this.draw.cursor = p;
    this.v.setDrawPreview(pts, p, this.tool === 'draw-room' && pts.length >= 3);
    if (pts.length) {
      const last = pts[pts.length - 1];
      this.v.setExtraLabels([{ x: (last[0] + p[0]) / 2, z: (last[1] + p[1]) / 2, text: fmtLen(dist(last, p)), cls: 'tag' }]);
    } else {
      this.v.setExtraLabels([]);
    }
  }

  _onTap(e) {
    if (this.tool === 'place') {
      this.dropPlace(e.clientX, e.clientY, e.shiftKey);
      return;
    }
    const p = this._drawPoint(e);
    if (!p) return;
    const pts = this.draw.pts;
    const last = pts[pts.length - 1];
    if (last && dist(last, p) < 1) return; // second click of a double-click
    if (this.tool === 'draw-room') {
      if (pts.length >= 3) {
        const a = this.v.project(pts[0][0], pts[0][1]), b = this.v.project(p[0], p[1]);
        if (dist(p, pts[0]) < 1 || Math.hypot(a.x - b.x, a.y - b.y) < 14) {
          this.finishDrawing();
          return;
        }
      }
      pts.push(p);
    } else if (this.tool === 'draw-wall') {
      if (last) {
        this.s.addWall(last, p);
        this.s.commit();
        this.draw.pts = [p];
      } else {
        pts.push(p);
      }
    }
    this.v.setDrawPreview(this.draw.pts, p, this.tool === 'draw-room' && this.draw.pts.length >= 3);
    this.v.setExtraLabels([]);
  }

  /** Close the room being drawn: creates the floor + a wall along every side. */
  finishDrawing() {
    if (this.tool !== 'draw-room') return;
    const pts = this.draw.pts;
    if (pts.length < 3) {
      this.emit('toast', 'Cần ít nhất 3 góc để tạo phòng.');
      return;
    }
    for (let i = 0; i < pts.length; i++) this.s.addWall(pts[i], pts[(i + 1) % pts.length]);
    const f = this.s.addFloor(pts);
    this.s.commit();
    this.setTool('select');
    this.s.select('floor', f.id);
  }

  // ---------- placing from the catalogue -----------------------------------------
  beginPlace(entry) {
    this.placing = { ...spawnItem(entry), baseRot: 0 };
    this.setTool('place');
  }

  /** Move the ghost under the pointer. Returns true when the pointer is over the viewport. */
  updatePlaceAt(cx, cy) {
    if (!this.placing) return false;
    if (!this.v.contains(cx, cy)) {
      this.v.setPreview(null);
      return false;
    }
    const p = this.v.floorPoint(cx, cy);
    if (!p) return false;
    let x = p[0], z = p[1], rot = this.placing.baseRot;
    if (this._snapOn) {
      x = snapTo(x, this._grid);
      z = snapTo(z, this._grid);
      ({ x, z, rot } = snapToWalls({ ...this.placing, x, z, rot }, this.s.doc.walls, this.s.doc.settings.wallThickness));
    }
    Object.assign(this.placing, { x: round1(x), z: round1(z), rot });
    this.v.setPreview(this.placing);
    return true;
  }

  dropPlace(cx, cy, keep = false) {
    if (!this.placing) return false;
    if (!this.updatePlaceAt(cx, cy)) {
      this.setTool('select');
      return false;
    }
    const { baseRot, ...fields } = this.placing;
    const it = this.s.addItem({ ...fields, rot: normDeg(fields.rot) });
    this.s.select('item', it.id);
    this.s.commit();
    if (keep) this.updatePlaceAt(cx, cy);
    else this.setTool('select');
    return true;
  }

  cancelPlace() {
    if (this.tool === 'place') this.setTool('select');
  }

  // ---------- selection actions ----------------------------------------------------
  rotateSelected(deg) {
    if (this.tool === 'place' && this.placing) {
      this.placing.baseRot = normDeg(this.placing.baseRot + deg);
      this.updatePlaceAt(this.last.x, this.last.y);
      return;
    }
    const it = this.s.sel?.kind === 'item' ? this.s.selected : null;
    if (!it || it.locked) return;
    it.rot = normDeg(it.rot + deg);
    this.s.touch();
    this.s.commit();
  }

  nudge(dx, dz) {
    const it = this.s.sel?.kind === 'item' ? this.s.selected : null;
    if (!it || it.locked) return;
    it.x = round1(it.x + dx);
    it.z = round1(it.z + dz);
    this.s.touch();
    this._nudgeCommit();
  }

  _nudgeCommit() {
    clearTimeout(this._nudgeTimer);
    this._nudgeTimer = setTimeout(() => this.s.commit(), 350); // one undo step per burst of key presses
  }

  _syncSelectionLabels() {
    if (this.tool === 'select') this.v.setExtraLabels([]);
  }

  // ---------- keyboard ------------------------------------------------------------
  onKey(e) {
    const t = e.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '') || t?.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      this.emit('save');
      return;
    }
    if (typing) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? this.s.redo() : this.s.undo(); }
      else if (k === 'y') { e.preventDefault(); this.s.redo(); }
      else if (k === 'd') { e.preventDefault(); this.s.duplicateSelected(); }
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      if (this.tool !== 'select' && this.draw.pts.length && this.tool.startsWith('draw')) this._resetDraw();
      else if (this.tool !== 'select') this.setTool('select');
      else this.s.select(null);
    } else if (e.key === 'Enter') {
      if (this.tool === 'draw-room') this.finishDrawing();
      else if (this.tool === 'draw-wall') this._resetDraw();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.tool === 'draw-room' && this.draw.pts.length) {
        this.draw.pts.pop();
        this.v.setDrawPreview(this.draw.pts, this.draw.cursor, this.draw.pts.length >= 3);
      } else if (this.tool === 'select') {
        e.preventDefault();
        this.s.removeSelected();
      }
    } else if (k === 'r') {
      this.rotateSelected(e.shiftKey ? -90 : 90);
    } else if (e.key.startsWith('Arrow') && this.tool === 'select') {
      const step = e.shiftKey ? 1 : Math.max(1, this._grid);
      const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = map[e.key];
      if (m && this.s.sel?.kind === 'item') {
        e.preventDefault();
        this.nudge(...m);
      }
    }
  }
}

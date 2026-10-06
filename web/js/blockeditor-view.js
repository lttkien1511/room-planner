// Mini 3D viewport for the block-builder dialog: renders one item's parts + a wireframe box
// showing its overall size. Deliberately much smaller in scope than view.js — no walls/floors/
// multiple items, nothing else to draw — so it stays a second, independent WebGL context that
// only exists while the dialog has been opened at least once.
import * as THREE from '../vendor/three.bundle.js';
import { M, Emitter } from './util.js';
import { geometryForPart, paintGeometry, resolveColor } from './catalog.js';
import { partBounds, meshVertexPos } from './blockbuilder.js';

/** Index pairs for LineSegments joining every horizontal/vertical (not diagonal) neighbour of a
 * rows×cols mesh grid — the app's tree-shaken three.js bundle doesn't include WireframeGeometry,
 * and this also looks better anyway (just the grid, no triangle diagonals cluttering it). */
function meshWireIndices(rows, cols) {
  const cols1 = cols + 1, rows1 = rows + 1;
  const idx = [];
  for (let r = 0; r < rows1; r++) {
    for (let c = 0; c < cols1; c++) {
      const k = r * cols1 + c;
      if (c < cols) idx.push(k, k + 1);
      if (r < rows) idx.push(k, k + cols1);
    }
  }
  return idx;
}

function boundsToBoxM(p) {
  const b = partBounds(p);
  return {
    sx: Math.max(0.02, (b.maxX - b.minX) * M), sy: Math.max(0.02, (b.maxY - b.minY) * M), sz: Math.max(0.02, (b.maxZ - b.minZ) * M),
    cx: ((b.minX + b.maxX) / 2) * M, cy: ((b.minY + b.maxY) / 2) * M, cz: ((b.minZ + b.maxZ) / 2) * M,
  };
}

export class BlockView extends Emitter {
  constructor(container, session) {
    super();
    this.container = container;
    this.session = session;
    this._raf = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.canvas = this.renderer.domElement;
    container.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1f25);
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    this.cam = new THREE.PerspectiveCamera(42, 1, 0.02, 40);
    this.cam.position.set(1.5, 1.3, 1.9);
    this.ctl = new THREE.OrbitControls(this.cam, this.canvas);
    this.ctl.target.set(0, 0.25, 0);
    this.ctl.minDistance = 0.15;
    this.ctl.maxDistance = 10;
    this.ctl.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.ctl.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.ctl.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.scene.add(new THREE.GridHelper(6, 24, 0x3a434e, 0x2c333b));

    // The grid's own centre lines are too close in tone to the rest of it to read as "this is 0"
    // at a glance, so draw the X/Y/Z axes as separate, brighter strips (flat/box meshes, not 1px
    // GridHelper lines, so the thickness is actually controllable) with a small cap where the
    // horizontal two cross — the origin.
    const AXIS_LEN = 6, AXIS_W = 0.013, AXIS_Y = 0.0015;
    const xAxis = new THREE.Mesh(new THREE.PlaneGeometry(AXIS_LEN, AXIS_W), new THREE.MeshBasicMaterial({ color: 0xd99a5c }));
    xAxis.rotation.x = -Math.PI / 2;
    xAxis.position.y = AXIS_Y;
    const zAxis = new THREE.Mesh(new THREE.PlaneGeometry(AXIS_W, AXIS_LEN), new THREE.MeshBasicMaterial({ color: 0x5fc9b8 }));
    zAxis.rotation.x = -Math.PI / 2;
    zAxis.position.y = AXIS_Y;
    const Y_BELOW = 0.3, Y_ABOVE = 3.5;
    const yAxis = new THREE.Mesh(new THREE.BoxGeometry(AXIS_W, Y_BELOW + Y_ABOVE, AXIS_W), new THREE.MeshBasicMaterial({ color: 0xb98fd9 }));
    yAxis.position.y = (Y_ABOVE - Y_BELOW) / 2;
    const originDot = new THREE.Mesh(new THREE.CircleGeometry(0.028, 20), new THREE.MeshBasicMaterial({ color: 0xf0f2f5 }));
    originDot.rotation.x = -Math.PI / 2;
    originDot.position.y = AXIS_Y + 0.001;
    this.scene.add(xAxis, zAxis, yAxis, originDot);

    this.boxLine = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x5b9bff, transparent: true, opacity: 0.55 }));
    this.scene.add(this.boxLine);

    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.selMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
    this.handleFill = new THREE.MeshBasicMaterial({ color: 0x2f6fed, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    this.handleFillSel = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.98, side: THREE.DoubleSide });
    this.handleRing = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: THREE.DoubleSide });
    this.discGeo = new THREE.CircleGeometry(1, 20);
    this.unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

    this.partGroup = new THREE.Group();
    this.overlay = new THREE.Group();
    this.scene.add(this.partGroup, this.overlay);
    this.meshes = new Map(); // partId -> Mesh

    // Marquee/box-select rectangle for mesh vertices — a plain HTML div over the canvas rather
    // than a three.js object, since it only ever needs an axis-aligned CSS rect, no 3D involved.
    // `.block-viewport` (this `container`) is already `position: relative` for the canvas itself.
    this.selBoxEl = document.createElement('div');
    this.selBoxEl.className = 'block-selbox';
    this.selBoxEl.style.display = 'none';
    container.appendChild(this.selBoxEl);
    this._selStart = null;

    new ResizeObserver(() => this.resize()).observe(container);
    session.on(() => this.sync());
    this.sync();
  }

  setControlsEnabled(on) {
    this.ctl.enabled = on;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) return; // dialog not visible yet
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    this.requestRender();
  }

  // ---------- picking / dragging helpers ------------------------------------------------------
  _ray(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.cam);
  }

  contains(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // ---------- box-select (marquee) for mesh vertices ------------------------------------------
  beginSelectionBox(clientX, clientY) {
    const r = this.container.getBoundingClientRect();
    this._selStart = { x: clientX - r.left, y: clientY - r.top };
    this.selBoxEl.style.display = 'block';
    this._drawSelectionBox(this._selStart, this._selStart);
  }

  updateSelectionBox(clientX, clientY) {
    if (!this._selStart) return;
    const r = this.container.getBoundingClientRect();
    this._drawSelectionBox(this._selStart, { x: clientX - r.left, y: clientY - r.top });
  }

  endSelectionBox() {
    this.selBoxEl.style.display = 'none';
    this._selStart = null;
  }

  _drawSelectionBox(a, b) {
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    Object.assign(this.selBoxEl.style, {
      left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(a.x - b.x)}px`, height: `${Math.abs(a.y - b.y)}px`,
    });
  }

  /** Indices of mesh part `p`'s vertices whose on-screen handle position falls within the
   * client-space rectangle spanning (x0,y0)-(x1,y1) — same coordinate space as pointer events,
   * for turning a finished marquee drag into a vertex selection. */
  vertsInScreenRect(p, x0, y0, x1, y1) {
    this.cam.updateMatrixWorld();
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1), loY = Math.min(y0, y1), hiY = Math.max(y0, y1);
    const r = this.canvas.getBoundingClientRect();
    const v3 = new THREE.Vector3();
    const out = [];
    const n = (p.rows + 1) * (p.cols + 1);
    for (let i = 0; i < n; i++) {
      const [wx, wy, wz] = meshVertexPos(p, i);
      v3.set(wx * M, wy * M, wz * M).project(this.cam);
      const sx = r.left + (v3.x * 0.5 + 0.5) * r.width;
      const sy = r.top + (-v3.y * 0.5 + 0.5) * r.height;
      if (sx >= loX && sx <= hiX && sy >= loY && sy <= hiY) out.push(i);
    }
    return out;
  }

  /** {partId} | {handle} | null under the pointer. */
  pick(clientX, clientY) {
    this._ray(clientX, clientY);
    let hits = this.raycaster.intersectObjects(this.overlay.children, true).filter((h) => h.object.userData.handle);
    if (hits.length) return { handle: hits[0].object.userData.name };
    hits = this.raycaster.intersectObjects([...this.meshes.values()], false);
    if (hits.length) {
      for (const [id, mesh] of this.meshes) if (mesh === hits[0].object) return { partId: id };
    }
    return null;
  }

  /** Point on the horizontal plane at world height `yCm` (doc cm), as [x, z] cm, or null. */
  floorPointAtY(clientX, clientY, yCm) {
    this._ray(clientX, clientY);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -yCm * M);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? [out.x / M, out.z / M] : null;
  }

  /** Point (cm, world) where the pointer ray crosses the plane through `originCm` with unit normal
   * `dir` ({x,y,z}) — like floorPointAtY but for an arbitrarily oriented plane, e.g. a tilted mesh
   * part's own local X/Z plane. Returns null when the ray is ~parallel to the plane. */
  planeHit(clientX, clientY, originCm, dir) {
    this._ray(clientX, clientY);
    const plane = new THREE.Plane();
    plane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(dir.x, dir.y, dir.z),
      new THREE.Vector3(originCm[0] * M, originCm[1] * M, originCm[2] * M),
    );
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? [out.x / M, out.y / M, out.z / M] : null;
  }

  /**
   * Closest point (as a scalar t, in cm) on the world-space line `originCm + t*dir` to the
   * current picking ray — the single primitive behind every linear drag handle (vertical move,
   * height/width/depth resize, radius). `dir` is a plain unit {x,y,z} (no THREE.Vector3 needed
   * by callers). Returns null when the ray is ~parallel to the axis.
   */
  axisT(clientX, clientY, originCm, dir) {
    this._ray(clientX, clientY);
    const ray = this.raycaster.ray;
    const rx = ray.origin.x - originCm[0] * M, ry = ray.origin.y - originCm[1] * M, rz = ray.origin.z - originCm[2] * M;
    const d1 = ray.direction;
    const b = d1.x * dir.x + d1.y * dir.y + d1.z * dir.z;
    const c = d1.x * rx + d1.y * ry + d1.z * rz;
    const f = dir.x * rx + dir.y * ry + dir.z * rz;
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) return null;
    return (f - b * c) / denom / M; // metres -> cm
  }

  // ---------- scene sync -----------------------------------------------------------------------
  sync() {
    const [w, d, h] = this.session.box;
    this.boxLine.scale.set(w * M, h * M, d * M);
    this.boxLine.position.set(0, (h * M) / 2, 0);

    const seen = new Set();
    for (const p of this.session.parts) {
      seen.add(p.id);
      const geo = paintGeometry(geometryForPart(p), resolveColor(p.c, this.session.color));
      let mesh = this.meshes.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, this.mat);
        mesh.userData = { partId: p.id };
        this.partGroup.add(mesh);
        this.meshes.set(p.id, mesh);
      } else {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      }
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        this.partGroup.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(id);
      }
    }
    this.syncOverlay();
    this.requestRender();
  }

  _clearOverlay() {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      c.traverse((o) => o.userData.ownGeo && o.geometry.dispose());
    }
  }

  _handleDisc(x, y, z, r, name, selected = false) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const ring = new THREE.Mesh(this.discGeo, this.handleRing);
    ring.scale.setScalar(r * (selected ? 1.7 : 1.35));
    ring.renderOrder = 20;
    const disc = new THREE.Mesh(this.discGeo, selected ? this.handleFillSel : this.handleFill);
    disc.scale.setScalar(r * (selected ? 1.3 : 1));
    disc.renderOrder = 21;
    const userData = { handle: true, name };
    g.userData = ring.userData = disc.userData = userData;
    // billboard toward the current camera so the flat discs read as handles from any angle —
    // onBeforeRender only fires for the renderable meshes, not the group, so both get it
    const billboard = (_r, _s, camera) => g.quaternion.copy(camera.quaternion);
    ring.onBeforeRender = billboard;
    disc.onBeforeRender = billboard;
    g.add(ring, disc);
    return g;
  }

  syncOverlay() {
    this._clearOverlay();
    const p = this.session.selectedPart;
    if (!p) {
      this.requestRender();
      return;
    }
    const b = boundsToBoxM(p);
    const box = new THREE.LineSegments(this.unitEdges, this.selMat);
    box.scale.set(b.sx, b.sy, b.sz);
    box.position.set(b.cx, b.cy, b.cz);
    box.renderOrder = 10;
    this.overlay.add(box);

    const hr = Math.max(0.018, Math.min(b.sx, b.sy, b.sz) * 0.14);
    const put = (x, y, z, name) => this.overlay.add(this._handleDisc(x * M, y * M, z * M, hr, name));
    if (p.k === 'm') {
      const maxVh = Math.max(0, ...p.vh);
      put(p.x, p.y + maxVh + 15, p.z, 'moveY');
      const srcGeo = geometryForPart(p);
      const wireGeo = new THREE.BufferGeometry();
      wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(srcGeo.attributes.position.array.slice(), 3));
      wireGeo.setIndex(meshWireIndices(p.rows, p.cols));
      srcGeo.dispose();
      const wire = new THREE.LineSegments(wireGeo, this.selMat);
      wire.renderOrder = 9;
      wire.userData.ownGeo = true;
      this.overlay.add(wire);
      // Smaller than the generic `hr` (sized off the whole part) so handles don't overlap on a
      // dense grid — scaled to one grid cell instead, clamped both ends so a sparse grid's handles
      // don't balloon and a dense one's don't vanish.
      const vr = Math.min(0.03, Math.max(0.007, Math.min(p.w / p.cols, p.d / p.rows) * 0.16 * M));
      const nverts = (p.rows + 1) * (p.cols + 1);
      for (let i = 0; i < nverts; i++) {
        const [vx, vy, vz] = meshVertexPos(p, i);
        this.overlay.add(this._handleDisc(vx * M, vy * M, vz * M, vr, `vert:${i}`, this.session.selectedVertices.has(i)));
      }
    } else if (p.k === 'b') {
      put(p.x, p.y + p.h + 15, p.z, 'moveY');
      put(p.x, p.y + p.h, p.z, 'h+');
      put(p.x + p.w / 2, p.y + p.h / 2, p.z, 'x+');
      put(p.x - p.w / 2, p.y + p.h / 2, p.z, 'x-');
      put(p.x, p.y + p.h / 2, p.z + p.d / 2, 'z+');
      put(p.x, p.y + p.h / 2, p.z - p.d / 2, 'z-');
    } else if (p.k === 'c') {
      put(p.x, p.y + p.h + 15, p.z, 'moveY');
      put(p.x, p.y + p.h, p.z, 'h+');
      put(p.x + p.r, p.y + p.h / 2, p.z, 'radius');
    } else {
      put(p.x, p.y + p.r + 15, p.z, 'moveY');
      put(p.x + p.r, p.y, p.z, 'radius');
    }
    this.requestRender();
  }

  // ---------- rendering --------------------------------------------------------------------------
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderer.render(this.scene, this.cam);
    });
  }
}

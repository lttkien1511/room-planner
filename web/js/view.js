// 3D/2D viewport. Render-on-demand: nothing is drawn unless something changed, so an idle
// tab costs ~0 CPU/GPU. Scene units are metres (doc cm * M).
import * as THREE from '../vendor/three.bundle.js';
import { M, DEG, Emitter, fmtLen, dist } from './util.js';
import { buildItemGeometry } from './catalog.js';
import { wallInnerLength } from './model.js';

const THEMES = {
  light: { bg: 0xdde3ea, ground: 0xe8ecf0, gridSub: 0xd0d7de, gridMain: 0xb4bec8, wallTop: 0x3f4852, accent: 0x2f6fed },
  dark: { bg: 0x1a1e23, ground: 0x242930, gridSub: 0x2c333b, gridMain: 0x3a434e, wallTop: 0xc3ccd6, accent: 0x5b9bff },
};

export class View extends Emitter {
  constructor(container, store, prefs) {
    super();
    this.container = container;
    this.store = store;
    this.prefs = prefs;
    this.mode = prefs.mode === '2d' ? '2d' : '3d';
    this.extraLabels = [];
    this._raf = 0;
    this._controlsWanted = true;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.canvas = this.renderer.domElement;
    container.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.01;
    this.ndc = new THREE.Vector2();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // cameras: perspective (3D) + orthographic looking straight down (2D plan)
    this.cam3 = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.cam3.position.set(5, 6, 8);
    this.cam2 = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 400);
    this.cam2.up.set(0, 0, -1);
    this.cam2.position.set(0, 100, 0);
    this.cam2.lookAt(0, 0, 0);

    this.ctl3 = new THREE.OrbitControls(this.cam3, this.canvas);
    this.ctl3.maxPolarAngle = Math.PI * 0.495;
    this.ctl3.minDistance = 0.6;
    this.ctl3.maxDistance = 120;
    this.ctl3.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.ctl3.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.ctl2 = new THREE.OrbitControls(this.cam2, this.canvas);
    this.ctl2.enableRotate = false;
    this.ctl2.screenSpacePanning = true;
    this.ctl2.zoomToCursor = true;
    this.ctl2.minZoom = 0.05;
    this.ctl2.maxZoom = 80;
    this.ctl2.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.ctl2.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    for (const c of [this.ctl3, this.ctl2]) c.addEventListener('change', () => this.requestRender());

    // lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.55));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.35);
    this.sun.position.set(4, 9, 6);
    this.scene.add(this.sun, this.sun.target);

    // groups
    this.groundGroup = new THREE.Group();
    this.floorGroup = new THREE.Group();
    this.wallGroup = new THREE.Group();
    this.itemGroup = new THREE.Group();
    this.overlay = new THREE.Group(); // selection boxes + handles
    this.drawGroup = new THREE.Group(); // room/wall drawing preview
    this.scene.add(this.groundGroup, this.floorGroup, this.wallGroup, this.itemGroup, this.drawGroup, this.overlay);

    // shared resources
    this.itemMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.previewMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.72 });
    this.wallSideMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.wallTopMat = new THREE.MeshLambertMaterial({ color: 0x3f4852 });
    this.wallMats = [this.wallSideMat, this.wallSideMat, this.wallTopMat, this.wallSideMat, this.wallSideMat, this.wallSideMat];
    this.floorMats = new Map();
    this.accentLine = new THREE.LineBasicMaterial({ color: 0x2f6fed, depthTest: false, transparent: true });
    this.accentFill = new THREE.MeshBasicMaterial({ color: 0x2f6fed, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    this.handleRing = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: THREE.DoubleSide });
    this.unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.unitZ = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
    this.discGeo = new THREE.CircleGeometry(1, 24);
    this.geoCache = new Map();

    this.itemMeshes = new Map();
    this.wallMeshes = new Map();
    this.floorMeshes = new Map();
    this._wallsKey = '';
    this._floorsKey = '';
    this.preview = null;
    this.previewKey = '';

    // labels (HTML overlay)
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'dim-layer';
    container.append(this.labelLayer);
    this.labelEls = [];

    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.scheme.addEventListener?.('change', () => this.applyTheme());
    this.applyTheme();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    store.on((kind) => {
      if (kind === 'doc') this.sync();
    });
    store.on((kind) => {
      if (kind === 'select') this.syncOverlay();
    });
    this.applyPrefs();
    this.sync();
  }

  // ---------- theme / prefs ------------------------------------------------------
  get theme() { return THEMES[this.scheme.matches ? 'dark' : 'light']; }

  applyTheme() {
    const t = this.theme;
    this.renderer.setClearColor(t.bg);
    this.wallTopMat.color.set(t.wallTop);
    this.accentLine.color.set(t.accent);
    this.accentFill.color.set(t.accent);
    for (const o of [...this.groundGroup.children]) {
      this.groundGroup.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: t.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.004;
    const g1 = new THREE.GridHelper(200, 200, t.gridSub, t.gridSub);
    const g5 = new THREE.GridHelper(200, 40, t.gridMain, t.gridMain);
    g1.position.y = -0.002;
    g5.position.y = -0.001;
    this.groundGroup.add(ground, g1, g5);
    this.requestRender();
  }

  applyPrefs() {
    const p = this.prefs;
    this.renderer.shadowMap.enabled = !!p.shadows;
    this.sun.castShadow = !!p.shadows;
    if (p.shadows) this.sun.shadow.mapSize.set(1024, 1024);
    for (const m of [this.itemMat, this.previewMat, this.wallSideMat, this.wallTopMat, ...this.floorMats.values()]) m.needsUpdate = true;
    this._applyMeshFlags();
    this._applyWallMode();
    this._updateShadowBounds();
    this.setMode(p.mode === '2d' ? '2d' : '3d', true);
    this.requestRender();
  }

  _applyMeshFlags() {
    const on = !!this.prefs.shadows;
    for (const m of [...this.itemMeshes.values(), ...this.wallMeshes.values()]) {
      m.castShadow = on;
      m.receiveShadow = on;
    }
    for (const m of this.floorMeshes.values()) m.receiveShadow = on;
  }

  _applyWallMode() {
    const mode = this.mode === '2d' ? 'full' : this.prefs.wallMode;
    for (const m of this.wallMeshes.values()) {
      m.visible = mode !== 'hide';
      m.scale.y = mode === 'low' ? Math.min(1, 100 / m.userData.h) : 1;
    }
    if (this.store.sel?.kind === 'wall') this.syncOverlay(); // selection box follows the wall's visible height
    this.requestRender();
  }

  _updateShadowBounds() {
    if (!this.prefs.shadows) return;
    const b = this.store.bounds() || { minX: -300, maxX: 300, minZ: -300, maxZ: 300 };
    const cx = ((b.minX + b.maxX) / 2) * M, cz = ((b.minZ + b.maxZ) / 2) * M;
    const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * M * 0.75 + 2;
    this.sun.position.set(cx + r * 0.7, r * 1.9, cz + r * 1.0);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = -r * 1.3; cam.right = r * 1.3; cam.top = r * 1.3; cam.bottom = -r * 1.3;
    cam.near = 0.5; cam.far = r * 6;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006;
  }

  // ---------- mode / camera ------------------------------------------------------
  get cam() { return this.mode === '2d' ? this.cam2 : this.cam3; }

  setMode(mode, silent) {
    this.mode = mode;
    this._applyControls();
    this._applyWallMode();
    if (!silent) this.emit('mode', mode);
    this.requestRender();
  }

  setControlsEnabled(on) {
    this._controlsWanted = on;
    this._applyControls();
  }

  _applyControls() {
    this.ctl3.enabled = this._controlsWanted && this.mode === '3d';
    this.ctl2.enabled = this._controlsWanted && this.mode === '2d';
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.cam3.aspect = aspect;
    this.cam3.updateProjectionMatrix();
    this.cam2.left = -5 * aspect; this.cam2.right = 5 * aspect; this.cam2.top = 5; this.cam2.bottom = -5;
    this.cam2.updateProjectionMatrix();
    this.requestRender();
  }

  /** Frame everything (or a default 6 m area). */
  fit() {
    const b = this.store.bounds() || { minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 250 };
    const cx = ((b.minX + b.maxX) / 2) * M, cz = ((b.minZ + b.maxZ) / 2) * M;
    const sx = Math.max(1, (b.maxX - b.minX) * M), sz = Math.max(1, (b.maxZ - b.minZ) * M), sy = Math.max(1, b.maxY * M);
    // 3D
    const radius = Math.hypot(sx, sz, sy) / 2;
    const vfov = this.cam3.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.cam3.aspect);
    const dist3 = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.95; // fit in the narrower field of view
    const dir = new THREE.Vector3(0.55, 0.75, 0.9).normalize();
    this.ctl3.target.set(cx, sy * 0.25, cz);
    this.cam3.position.copy(dir.multiplyScalar(dist3)).add(this.ctl3.target);
    this.ctl3.update();
    // 2D
    const aspect = this.cam2.right / 5;
    this.cam2.zoom = Math.min((10 * aspect) / (sx * 1.25), 10 / (sz * 1.25));
    this.ctl2.target.set(cx, 0, cz);
    this.cam2.position.set(cx, 100, cz);
    this.cam2.updateProjectionMatrix();
    this.ctl2.update();
    this.requestRender();
  }

  // ---------- picking ------------------------------------------------------------
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

  /** Point on the floor plane in cm as [x, z], or null. */
  floorPoint(clientX, clientY) {
    this._ray(clientX, clientY);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.floorPlane, out) ? [out.x / M, out.z / M] : null;
  }

  /** What is under the pointer: {type:'rot'|'wallEnd'|'item'|'wall'|'floor', id, which?} or null. */
  pick(clientX, clientY) {
    this._ray(clientX, clientY);
    let hits = this.raycaster.intersectObjects(this.overlay.children, true).filter((h) => h.object.userData.handle);
    if (hits.length) {
      const u = hits[0].object.userData;
      return { type: u.type, id: u.id, which: u.which };
    }
    const solid = [...this.itemMeshes.values(), ...this.wallMeshes.values()].filter((m) => m.visible);
    hits = this.raycaster.intersectObjects(solid, false);
    if (hits.length) {
      const u = hits[0].object.userData;
      return { type: u.kind, id: u.id };
    }
    hits = this.raycaster.intersectObjects([...this.floorMeshes.values()], false);
    if (hits.length) return { type: 'floor', id: hits[0].object.userData.id };
    return null;
  }

  /** Project a doc-space point (cm) to container pixels. */
  project(x, z, y = 0) {
    const v = new THREE.Vector3(x * M, y * M, z * M).project(this.cam);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z > -1 && v.z < 1 };
  }

  // ---------- scene sync ---------------------------------------------------------
  sync() {
    this._syncFloors();
    this._syncWalls();
    this._syncItems();
    this.syncOverlay();
    this._updateShadowBounds();
    this.requestRender();
  }

  /** Drop cached geometry for a type (a custom item was just edited) and rebuild its placed items. */
  invalidateType(type) {
    for (const [key, geo] of this.geoCache) {
      if (key.startsWith(type + '|')) {
        geo.dispose();
        this.geoCache.delete(key);
      }
    }
    for (const mesh of this.itemMeshes.values()) {
      if (mesh.userData.key?.startsWith(type + '|')) mesh.userData.key = ''; // forces _syncItems to rebuild it below
    }
    this._syncItems();
    this.requestRender();
  }

  _geometryFor(it) {
    const key = `${it.type}|${it.w}|${it.d}|${it.h}|${it.color}`;
    let g = this.geoCache.get(key);
    if (!g) {
      g = buildItemGeometry(it.type, it.w, it.d, it.h, it.color);
      this.geoCache.set(key, g);
    }
    return { key, geo: g };
  }

  _syncItems() {
    const seen = new Set();
    const on = !!this.prefs.shadows;
    for (const it of this.store.doc.items) {
      seen.add(it.id);
      const { key, geo } = this._geometryFor(it);
      let mesh = this.itemMeshes.get(it.id);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, this.itemMat);
        mesh.userData = { kind: 'item', id: it.id, key };
        mesh.castShadow = mesh.receiveShadow = on;
        this.itemGroup.add(mesh);
        this.itemMeshes.set(it.id, mesh);
      } else if (mesh.userData.key !== key) {
        mesh.geometry = geo;
        mesh.userData.key = key;
      }
      mesh.position.set(it.x * M, (it.y || 0) * M, it.z * M);
      mesh.rotation.y = -it.rot * DEG;
    }
    for (const [id, mesh] of this.itemMeshes) {
      if (!seen.has(id)) {
        this.itemGroup.remove(mesh);
        this.itemMeshes.delete(id);
      }
    }
    const used = new Set([...this.itemMeshes.values()].map((m) => m.userData.key));
    if (this.previewKey) used.add(this.previewKey);
    for (const [key, geo] of this.geoCache) {
      if (!used.has(key)) {
        geo.dispose();
        this.geoCache.delete(key);
      }
    }
  }

  _floorMat(color) {
    let m = this.floorMats.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      this.floorMats.set(color, m);
    }
    return m;
  }

  _syncFloors() {
    const key = JSON.stringify(this.store.doc.floors);
    if (key === this._floorsKey) return;
    this._floorsKey = key;
    for (const m of this.floorMeshes.values()) {
      this.floorGroup.remove(m);
      m.geometry.dispose();
    }
    this.floorMeshes.clear();
    for (const f of this.store.doc.floors) {
      const shape = new THREE.Shape(f.pts.map((p) => new THREE.Vector2(p[0] * M, -p[1] * M)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this._floorMat(f.color));
      mesh.userData = { kind: 'floor', id: f.id };
      mesh.receiveShadow = !!this.prefs.shadows;
      this.floorGroup.add(mesh);
      this.floorMeshes.set(f.id, mesh);
    }
  }

  _syncWalls() {
    const s = this.store.doc.settings;
    this.wallSideMat.color.set(s.wallColor);
    const key = JSON.stringify([this.store.doc.walls, s.wallHeight, s.wallThickness]);
    if (key === this._wallsKey) return;
    this._wallsKey = key;
    for (const m of this.wallMeshes.values()) {
      this.wallGroup.remove(m);
      m.geometry.dispose();
    }
    this.wallMeshes.clear();
    const on = !!this.prefs.shadows;
    for (const w of this.store.doc.walls) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const t = w.t ?? s.wallThickness, h = w.h ?? s.wallHeight;
      const geo = new THREE.BoxGeometry((len + t) * M, h * M, t * M); // +t: fills the corner joints
      geo.translate(0, (h * M) / 2, 0);
      const mesh = new THREE.Mesh(geo, this.wallMats);
      mesh.position.set(((w.a[0] + w.b[0]) / 2) * M, 0, ((w.a[1] + w.b[1]) / 2) * M);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.userData = { kind: 'wall', id: w.id, h, t, len };
      mesh.castShadow = mesh.receiveShadow = on;
      this.wallGroup.add(mesh);
      this.wallMeshes.set(w.id, mesh);
    }
    this._applyWallMode();
  }

  // ---------- overlays (selection, handles, previews) ------------------------------
  _clear(group) {
    for (const c of [...group.children]) {
      group.remove(c);
      c.traverse((o) => o.userData.ownGeo && o.geometry.dispose());
    }
  }

  _handle(x, z, y, r, userData) {
    const g = new THREE.Group();
    g.position.set(x * M, y * M, z * M);
    const ring = new THREE.Mesh(this.discGeo, this.handleRing);
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(r * M * 1.35);
    ring.renderOrder = 20;
    const disc = new THREE.Mesh(this.discGeo, this.accentFill);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    disc.scale.setScalar(r * M);
    disc.renderOrder = 21;
    disc.userData = { handle: true, ...userData };
    ring.userData = { handle: true, ...userData };
    g.add(ring, disc);
    return g;
  }

  syncOverlay() {
    this._clear(this.overlay);
    const sel = this.store.sel;
    const obj = this.store.selected;
    if (!sel || !obj) {
      this.requestRender();
      return;
    }
    if (sel.kind === 'item') {
      const box = new THREE.LineSegments(this.unitEdges, this.accentLine);
      box.scale.set(obj.w * M, obj.h * M, obj.d * M);
      box.position.set(obj.x * M, ((obj.y || 0) + obj.h / 2) * M, obj.z * M);
      box.rotation.y = -obj.rot * DEG;
      box.renderOrder = 10;
      this.overlay.add(box);
      if (!obj.locked) {
        const g = new THREE.Group();
        g.position.set(obj.x * M, 0.03, obj.z * M);
        g.rotation.y = -obj.rot * DEG;
        const line = new THREE.LineSegments(this.unitZ, this.accentLine);
        line.position.z = (obj.d / 2) * M;
        line.scale.z = 30 * M;
        line.renderOrder = 10;
        g.add(line, this._handle(0, obj.d / 2 + 40, 0, 10, { type: 'rot', id: obj.id }));
        this.overlay.add(g);
      }
    } else if (sel.kind === 'wall') {
      const mesh = this.wallMeshes.get(obj.id);
      if (mesh) {
        const box = new THREE.LineSegments(this.unitEdges, this.accentLine);
        const vh = mesh.userData.h * mesh.scale.y;
        box.scale.set((mesh.userData.len + mesh.userData.t) * M, vh * M, mesh.userData.t * M);
        box.position.set(mesh.position.x, (vh * M) / 2, mesh.position.z);
        box.rotation.y = mesh.rotation.y;
        box.renderOrder = 10;
        this.overlay.add(box);
        const top = vh + 1;
        this.overlay.add(this._handle(obj.a[0], obj.a[1], top, 12, { type: 'wallEnd', id: obj.id, which: 'a' }));
        this.overlay.add(this._handle(obj.b[0], obj.b[1], top, 12, { type: 'wallEnd', id: obj.id, which: 'b' }));
      }
    } else if (sel.kind === 'floor') {
      const pts = [...obj.pts, obj.pts[0]].map((p) => new THREE.Vector3(p[0] * M, 0.03, p[1] * M));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.accentLine);
      line.userData.ownGeo = true;
      line.renderOrder = 10;
      this.overlay.add(line);
    }
    this.requestRender();
  }

  /** Ghost of an item being placed (not part of the document). */
  setPreview(item) {
    if (!item) {
      if (this.preview) {
        this.scene.remove(this.preview);
        this.preview = null;
        this.previewKey = '';
        this.requestRender();
      }
      return;
    }
    const { key, geo } = this._geometryFor(item);
    if (!this.preview) {
      this.preview = new THREE.Mesh(geo, this.previewMat);
      this.scene.add(this.preview);
    } else if (this.previewKey !== key) {
      this.preview.geometry = geo;
    }
    this.previewKey = key;
    this.preview.position.set(item.x * M, (item.y || 0) * M, item.z * M);
    this.preview.rotation.y = -item.rot * DEG;
    this.requestRender();
  }

  /** Rubber-band preview while drawing walls/rooms. */
  setDrawPreview(pts, cursor, closeable) {
    this._clear(this.drawGroup);
    if (!pts || (!pts.length && !cursor)) {
      this.requestRender();
      return;
    }
    const all = cursor ? [...pts, cursor] : [...pts];
    if (all.length > 1) {
      const v = all.map((p) => new THREE.Vector3(p[0] * M, 0.05, p[1] * M));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), this.accentLine);
      line.userData.ownGeo = true;
      line.renderOrder = 12;
      this.drawGroup.add(line);
    }
    pts.forEach((p, i) => {
      const d = new THREE.Mesh(this.discGeo, this.accentFill);
      d.rotation.x = -Math.PI / 2;
      d.position.set(p[0] * M, 0.06, p[1] * M);
      d.scale.setScalar((i === 0 && closeable ? 11 : 6) * M);
      d.renderOrder = 13;
      this.drawGroup.add(d);
    });
    if (cursor) {
      const d = new THREE.Mesh(this.discGeo, this.accentFill);
      d.rotation.x = -Math.PI / 2;
      d.position.set(cursor[0] * M, 0.06, cursor[1] * M);
      d.scale.setScalar(5 * M);
      d.renderOrder = 13;
      this.drawGroup.add(d);
    }
    this.requestRender();
  }

  // ---------- labels -------------------------------------------------------------
  setExtraLabels(list) {
    this.extraLabels = list || [];
    this.requestRender();
  }

  _labelList() {
    const out = [...this.extraLabels];
    const doc = this.store.doc;
    if (this.mode === '2d' && this.prefs.dims && doc.walls.length) {
      let cx = 0, cz = 0;
      for (const w of doc.walls) { cx += w.a[0] + w.b[0]; cz += w.a[1] + w.b[1]; }
      cx /= doc.walls.length * 2; cz /= doc.walls.length * 2;
      for (const w of doc.walls) {
        const L = dist(w.a, w.b);
        if (L < 20) continue;
        const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
        const mx = (w.a[0] + w.b[0]) / 2, mz = (w.a[1] + w.b[1]) / 2;
        let nx = -uz, nz = ux;
        if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
        const off = (w.t ?? doc.settings.wallThickness) / 2 + 16;
        out.push({ x: mx + nx * off, z: mz + nz * off, text: fmtLen(wallInnerLength(doc, w)), cls: '' });
      }
    }
    const it = this.store.sel?.kind === 'item' ? this.store.selected : null;
    if (it) {
      out.push({ x: it.x, z: it.z, y: (it.y || 0) + it.h, text: `${Math.round(it.w)} × ${Math.round(it.d)} × ${Math.round(it.h)}`, cls: 'tag' });
    }
    return out;
  }

  _positionLabels() {
    const list = this._labelList();
    while (this.labelEls.length < list.length) {
      const el = document.createElement('div');
      this.labelLayer.append(el);
      this.labelEls.push(el);
    }
    this.labelEls.forEach((el, i) => {
      const l = list[i];
      if (!l) {
        el.style.display = 'none';
        return;
      }
      const p = this.project(l.x, l.z, l.y || 0);
      if (!p.visible) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.className = 'dim ' + (l.cls || '');
      if (el.textContent !== l.text) el.textContent = l.text;
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  }

  // ---------- rendering ----------------------------------------------------------
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    this.renderer.render(this.scene, this.cam);
    this._positionLabels();
  }

  /** PNG data URL of the current view. */
  screenshot() {
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}

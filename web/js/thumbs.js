// Renders one small preview image per catalogue entry, once, with a throw-away renderer.
import * as THREE from '../vendor/three.bundle.js';
import { buildItemGeometry } from './catalog.js';
import { M, DEG } from './util.js';

export async function renderThumbnails(entries, onThumb, size = 120) {
  let renderer;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return; // no WebGL: cards simply keep their placeholder
  }
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cam = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
  const dir = new THREE.Vector3(0.8, 0.62, 1.0).normalize();

  for (const e of entries) {
    const [w, d, h] = e.size;
    const geo = buildItemGeometry(e.id, w, d, h, e.color);
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    const center = new THREE.Vector3(0, (h * M) / 2, 0);
    const radius = (Math.hypot(w, d, h) * M) / 2;
    cam.position.copy(dir).multiplyScalar((radius / Math.sin((cam.fov * DEG) / 2)) * 1.02).add(center);
    cam.lookAt(center);
    renderer.render(scene, cam);
    onThumb(e.id, canvas.toDataURL('image/png'));
    scene.remove(mesh);
    geo.dispose();
    await new Promise((r) => setTimeout(r, 0)); // stay responsive
  }
  mat.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}

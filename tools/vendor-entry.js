// Entry point for the tree-shaken three.js bundle (web/vendor/three.bundle.js).
// Only names listed here end up in the bundle. When app code needs another
// three.js class, add it here and re-run tools/build-vendor.sh.
export {
  // core
  Scene, WebGLRenderer, PerspectiveCamera, OrthographicCamera, Object3D, Group, Mesh, Line, LineSegments, Color,
  // geometry
  BufferGeometry, BufferAttribute, Float32BufferAttribute, BoxGeometry, CylinderGeometry, PlaneGeometry,
  CircleGeometry, RingGeometry, SphereGeometry, ShapeGeometry, EdgesGeometry, Shape,
  // materials
  MeshLambertMaterial, MeshBasicMaterial, LineBasicMaterial, LineDashedMaterial,
  // lights
  HemisphereLight, DirectionalLight, AmbientLight,
  // helpers
  GridHelper,
  // math / picking
  Raycaster, Vector2, Vector3, Plane, Box3, Matrix4, Quaternion, Euler, MathUtils,
  // constants
  DoubleSide, FrontSide, BackSide, PCFSoftShadowMap, SRGBColorSpace, MOUSE, TOUCH,
} from 'three';

export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

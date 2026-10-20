// render.js — the three.js world: terrain, sea, clouds, plane, bandits, drones, ring, tracers, smoke.
// Reads game state, never writes it. Flight maths uses {x,y,z}; THREE objects stay in here.

const SKY = 0x8fc3e8;

function tv(v) { return new THREE.Vector3(v.x, v.y, v.z); }

function createWorld(canvas, pixelRatio) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.autoClear = false;   // the cockpit is a second pass over the world
  renderer.setPixelRatio(pixelRatio);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 2000, CONFIG.FOG_BASE);
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 1, CONFIG.FOG_MAX + 10000);

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 0.75));
  const sun = new THREE.DirectionalLight(0xfff3dd, 0.85);
  sun.position.set(0.5, 1, 0.3);
  scene.add(sun);

  const w = { renderer, scene, camera, terrain: makeTerrain(), farTerrain: makeFarTerrain(), farCenter: null, sea: makeSea(), clouds: makeClouds(), plane: makePlaneModel(), cockpit: makeCockpit(),
    drones: new Map(), bandits: new Map(), ring: makeRing(), tracers: makeTracers(), smoke: makeSmoke(), damageSmoke: makeSmoke({ color: 0x3a3a3a, size: 3.5, opacity: 0.5, life: 1.6, max: 600 }), booms: [], missiles: [],
    trails: [makeTrail(), makeTrail()], prevFwd: null, vapor: 0, planeType: 'jet',
    terrainCenter: null, heightCache: new Map(), camUp: new THREE.Vector3(0, 1, 0), camPos: null, view: 'chase' };
  scene.add(w.terrain, w.farTerrain, w.sea, w.clouds.mesh, w.clouds.ink, w.plane, w.ring, w.tracers, w.smoke.points, w.damageSmoke.points, w.trails[0].mesh, w.trails[1].mesh);
  return w;
}

function makeTerrain() {
  const geo = new THREE.PlaneGeometry(CONFIG.TERRAIN_SIZE, CONFIG.TERRAIN_SIZE, CONFIG.TERRAIN_SEGS, CONFIG.TERRAIN_SEGS);
  geo.rotateX(-Math.PI / 2);
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
  geo.userData.base = Float32Array.from(geo.attributes.position.array);
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 0 });
  return new THREE.Mesh(geo, mat);
}

// The far layer: same ground, coarse, drawn a little behind the detailed patch (polygon offset +
// a few metres lower) so the detailed one always wins where they overlap.
function makeFarTerrain() {
  const geo = new THREE.PlaneGeometry(CONFIG.FAR_TERRAIN_SIZE, CONFIG.FAR_TERRAIN_SIZE, CONFIG.FAR_TERRAIN_SEGS, CONFIG.FAR_TERRAIN_SEGS);
  geo.rotateX(-Math.PI / 2);
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
  geo.userData.base = Float32Array.from(geo.attributes.position.array);
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 0, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
  return new THREE.Mesh(geo, mat);
}

function recenterFarTerrain(w, x, z) {
  const R = CONFIG.FAR_RECENTER;
  const cx = Math.round(x / R) * R, cz = Math.round(z / R) * R;
  if (w.farCenter && w.farCenter.x === cx && w.farCenter.z === cz) return;
  w.farCenter = { x: cx, z: cz };
  const geo = w.farTerrain.geometry;
  const pos = geo.attributes.position, col = geo.attributes.color, base = geo.userData.base;
  for (let i = 0; i < pos.count; i++) {
    const e = terrainVertex(base[i * 3] + cx, base[i * 3 + 2] + cz);
    pos.array[i * 3 + 1] = e[0];
    col.array[i * 3] = e[1]; col.array[i * 3 + 1] = e[2]; col.array[i * 3 + 2] = e[3];
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  w.farTerrain.position.set(cx, -6, cz);
}

// Heights are baked around a centre; re-bake when the player wanders off it.
function recenterTerrain(w, x, z) {
  const R = CONFIG.TERRAIN_RECENTER;
  const cx = Math.round(x / R) * R, cz = Math.round(z / R) * R;
  if (w.terrainCenter && w.terrainCenter.x === cx && w.terrainCenter.z === cz) return;
  w.terrainCenter = { x: cx, z: cz };
  const geo = w.terrain.geometry;
  const pos = geo.attributes.position, col = geo.attributes.color, base = geo.userData.base;
  // Grid points repeat between re-centres (they move in whole cells), so heights + colours are
  // cached by world position. Dropped wholesale if it grows past a few full grids.
  if (w.heightCache.size > 120000) w.heightCache.clear();
  for (let i = 0; i < pos.count; i++) {
    const wx = base[i * 3] + cx, wz = base[i * 3 + 2] + cz;
    const key = Math.round(wx) + ',' + Math.round(wz);
    let e = w.heightCache.get(key);
    if (!e) { e = terrainVertex(wx, wz); w.heightCache.set(key, e); }
    pos.array[i * 3 + 1] = e[0];
    col.array[i * 3] = e[1]; col.array[i * 3 + 1] = e[2]; col.array[i * 3 + 2] = e[3];
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  w.terrain.position.set(cx, 0, cz);
}

const TERRAIN_COLORS = {
  sand: new THREE.Color(0xd9c89a), grassA: new THREE.Color(0x5f8f45), grassB: new THREE.Color(0x4b7a3a),
  rockA: new THREE.Color(0x6d6a4e), rockB: new THREE.Color(0x7d7466), snow: new THREE.Color(0xf2f4f6),
};
const tmpColor = new THREE.Color();

// [height, r, g, b] for one grid point.
function terrainVertex(wx, wz) {
  const h = terrainHeight(wx, wz), T = TERRAIN_COLORS, c = tmpColor;
  if (h < 8) c.copy(T.sand);
  else if (h < 260) c.copy(T.grassA).lerp(T.grassB, valueNoise(wx / 300, wz / 300));
  else if (h < 600) c.copy(T.rockA).lerp(T.rockB, (h - 260) / 340);
  else c.copy(T.snow);
  return [h, c.r, c.g, c.b];
}

function makeSea() {
  const geo = new THREE.PlaneGeometry(CONFIG.FAR_TERRAIN_SIZE * 1.4, CONFIG.FAR_TERRAIN_SIZE * 1.4);
  geo.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0x2f6f9f, shininess: 60, transparent: true, opacity: 0.88 }));
}

// Every cloud puff is one instance of one mesh: a single draw call for the whole sky.
const CLOUDS = 45, PUFFS = 6;

function makeClouds() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa8b8, flatShading: true, transparent: true, opacity: 0.92 });
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat, CLOUDS * PUFFS);
  mesh.frustumCulled = false;
  const rng = makeRng(99);
  const list = [];
  for (let i = 0; i < CLOUDS; i++) {
    const n = 3 + Math.floor(rng() * 4);
    const puffs = [];
    for (let j = 0; j < PUFFS; j++) {
      const s = j < n ? 60 + rng() * 90 : 0;   // unused slots scale to nothing
      puffs.push({ x: (rng() - 0.5) * 260, y: (rng() - 0.5) * 50, z: (rng() - 0.5) * 160, sx: s * 1.6, sy: s * 0.7, sz: s });
    }
    list.push({ x: (rng() - 0.5) * 9000, y: 1300 + rng() * 900, z: (rng() - 0.5) * 9000, puffs });
  }
  // Ink: the same puffs a touch bigger, back faces only, drawn in the anime look.
  const ink = new THREE.InstancedMesh(mesh.geometry, INK_MAT, CLOUDS * PUFFS);
  ink.frustumCulled = false;
  ink.visible = false;
  ink.userData.isInk = true;
  const clouds = { mesh, ink, list };
  list.forEach((c, i) => placeCloud(clouds, i));
  return clouds;
}

function placeCloud(clouds, i) {
  const c = clouds.list[i];
  const m = new THREE.Matrix4();
  c.puffs.forEach((p, j) => {
    m.makeScale(p.sx, p.sy, p.sz).setPosition(c.x + p.x, c.y + p.y, c.z + p.z);
    clouds.mesh.setMatrixAt(i * PUFFS + j, m);
    m.makeScale(p.sx * 1.05, p.sy * 1.08, p.sz * 1.05).setPosition(c.x + p.x, c.y + p.y, c.z + p.z);
    clouds.ink.setMatrixAt(i * PUFFS + j, m);
  });
  clouds.mesh.instanceMatrix.needsUpdate = true;
  clouds.ink.instanceMatrix.needsUpdate = true;
}

// A little delta-wing jet pointing down -z, like every THREE object.
// paint: { body, dark } colours. Bandits wear a darker red-grey scheme.
function makePlaneModel(paint) {
  const g = new THREE.Group();
  const body = new THREE.MeshPhongMaterial({ color: paint ? paint.body : 0x9aa7b4, flatShading: true });
  const dark = new THREE.MeshPhongMaterial({ color: paint ? paint.dark : 0x4d5864, flatShading: true });
  const fus = new THREE.Mesh(new THREE.ConeGeometry(1.3, 15, 6), body);
  fus.geometry.rotateX(-Math.PI / 2);
  g.add(fus);
  g.userData.fus = fus;
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -3); wingShape.lineTo(7.5, 4.5); wingShape.lineTo(-7.5, 4.5); wingShape.lineTo(0, -3);
  const wing = new THREE.Mesh(new THREE.ExtrudeGeometry(wingShape, { depth: 0.35, bevelEnabled: false }), body);
  wing.geometry.rotateX(Math.PI / 2);
  wing.position.set(0, 0, 1.5);
  g.add(wing);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.4, 2.6), dark);
  fin.position.set(0, 1.9, 5.8);
  g.add(fin);
  const canard = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.2, 1.1), dark);
  canard.position.set(0, 0.2, -3.5);
  g.add(canard);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), new THREE.MeshPhongMaterial({ color: 0x223344, shininess: 90 }));
  glass.scale.set(0.8, 0.7, 2);
  glass.position.set(0, 0.9, -3);
  g.add(glass);
  g.userData.glass = glass;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3, 8), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85 }));
  flame.geometry.rotateX(Math.PI / 2);
  flame.position.set(0, 0, 8.5);
  g.add(flame);
  g.userData.flame = flame;
  for (const part of [fus, wing, fin, canard]) addInk(part, 0.26);
  return g;
}

// WW2 fighters, nose down -z, low-poly. Wing planform per type (elliptical Spitfire, square-tipped
// 109, straight-tapered P-51), a nose in the type's colour, a spinning three-blade prop (userData.prop).
// userData.flame is an empty stand-in so code written for the jet's afterburner just works.
const PROP_LOOKS = {
  spitfire: { len: 9.1, span: 11.2, chord: 2.5, plan: 'ellipse', body: 0x63704a, dark: 0x4b3f2c, nose: 0x63704a, canopyZ: -0.2 },
  bf109: { len: 8.9, span: 9.9, chord: 2.0, plan: 'square', body: 0x8c969f, dark: 0x58626b, nose: 0xd9b52e, canopyZ: -0.5 },
  p51: { len: 9.8, span: 11.3, chord: 2.6, plan: 'taper', body: 0xb7bec6, dark: 0x30353c, nose: 0xc4372c, canopyZ: 0.1, scoop: true },
};

function makePropModel(type) {
  const L = PROP_LOOKS[type];
  const g = new THREE.Group();
  const mat = c => new THREE.MeshPhongMaterial({ color: c, flatShading: true });
  const body = mat(L.body), dark = mat(L.dark), noseM = mat(L.nose);
  const mesh = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  // Fuselage: thick at the cowl, thin at the tail.
  const fusG = new THREE.CylinderGeometry(0.28, 0.62, L.len * 0.72, 8);
  fusG.rotateX(Math.PI / 2);
  const fus = mesh(fusG, body, 0, 0, L.len * 0.14);
  const cowlG = new THREE.CylinderGeometry(0.62, 0.52, L.len * 0.24, 8);
  cowlG.rotateX(Math.PI / 2);
  const cowl = mesh(cowlG, noseM, 0, 0, -L.len * 0.34);
  const spinG = new THREE.ConeGeometry(0.32, 0.7, 8);
  spinG.rotateX(-Math.PI / 2);
  mesh(spinG, dark, 0, 0, -L.len * 0.46 - 0.35);
  // Wing planform as a shape in (x, z-forward-negative), extruded thin.
  const half = L.span / 2, pts = [];
  const chordAt = u => L.plan === 'ellipse' ? Math.max(0.35, Math.sqrt(1 - u * u)) : L.plan === 'square' ? 1 - 0.4 * u : 1 - 0.5 * u;
  for (let i = -10; i <= 10; i++) { const u = Math.abs(i / 10); pts.push([i / 10 * half, -L.chord * 0.35 * chordAt(u)]); }
  for (let i = 10; i >= -10; i--) { const u = Math.abs(i / 10); pts.push([i / 10 * half, L.chord * 0.65 * chordAt(u)]); }
  const wingShape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const wingG = new THREE.ExtrudeGeometry(wingShape, { depth: 0.16, bevelEnabled: false });
  wingG.rotateX(Math.PI / 2);
  const wing = mesh(wingG, body, 0, -0.25, -L.len * 0.08);
  const tailG = new THREE.BoxGeometry(L.span * 0.33, 0.1, 0.9);
  const tail = mesh(tailG, body, 0, 0.1, L.len * 0.44);
  const fin = mesh(new THREE.BoxGeometry(0.1, 1.3, 1.1), dark, 0, 0.7, L.len * 0.45);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshPhongMaterial({ color: 0x223344, shininess: 90 }));
  glass.scale.set(0.85, 0.8, 2.1);
  glass.position.set(0, 0.55, L.canopyZ);
  g.add(glass);
  if (L.scoop) mesh(new THREE.BoxGeometry(0.55, 0.45, 1.8), body, 0, -0.62, L.len * 0.1);
  // Propeller: three blades and a faint disc; main spins it.
  const prop = new THREE.Group();
  prop.position.set(0, 0, -L.len * 0.47);
  prop.add(new THREE.Mesh(new THREE.CircleGeometry(1.5, 20), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })));
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.5, 0.05), dark);
    blade.geometry.translate(0, 0.75, 0);
    blade.rotation.z = i * Math.PI * 2 / 3;
    prop.add(blade);
  }
  g.add(prop);
  for (const part of [fus, cowl, wing, tail, fin]) addInk(part, 0.12);
  g.userData = { fus, glass, cowl, prop, flame: new THREE.Object3D(), type, len: L.len };
  return g;
}

// The right model for a plane type (jet paint only matters for the jet).
function makeAircraft(type, paint) {
  return planeSpec(type).ERA === 'ww2' ? makePropModel(planeSpec(type).type) : makePlaneModel(paint);
}

// Cockpit: its own little scene in the plane's frame (x right, y up, -z forward), eye at
// COCKPIT_EYE. Drawn in a second pass with its own close-range camera, so nothing gets cut away
// by the world camera's 1 m near plane (which made the sides see-through).
const COCKPIT_EYE = { x: 0, y: 1.4, z: 1 };

function makeCockpit() {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x303840, 0.8);
  const sun = new THREE.DirectionalLight(0xfff3dd, 0.7);
  scene.add(hemi, sun);
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.03, 30);
  camera.position.set(COCKPIT_EYE.x, COCKPIT_EYE.y, COCKPIT_EYE.z);

  const panel = new THREE.MeshPhongMaterial({ color: 0x262c34, flatShading: true });
  const frame = new THREE.MeshPhongMaterial({ color: 0x3c4550, flatShading: true });
  const black = new THREE.MeshPhongMaterial({ color: 0x15181c, flatShading: true });
  const box = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  // Tub: side walls, floor, consoles either side of the seat.
  for (const s of [-1, 1]) {
    box(0.08, 0.6, 2.8, s * 0.62, 0.78, 0.4, panel);
    box(0.24, 0.12, 0.95, s * 0.47, 0.84, 0.55, panel);
    // A few buttons/switch lights on each console.
    for (let i = 0; i < 4; i++) {
      const lit = new THREE.MeshBasicMaterial({ color: [0x8dffb0, 0xffd34a, 0x4fd8ff, 0xff5a4f][(i + (s > 0 ? 2 : 0)) % 4] });
      box(0.04, 0.015, 0.04, s * (0.42 + (i % 2) * 0.08), 0.905, 0.25 + Math.floor(i / 2) * 0.12, lit);
    }
  }
  box(1.2, 0.05, 2.8, 0, 0.47, 0.4, black);

  // Dash, glare shield and gauges (speed, throttle, altitude).
  box(1.16, 0.42, 0.5, 0, 0.8, -0.78, panel);
  box(1.16, 0.05, 0.22, 0, 1.03, -0.58, frame);
  const gaugeRim = new THREE.MeshBasicMaterial({ color: 0x55606c });
  const faces = [0x103018, 0x302408, 0x103018];
  const needles = [];
  [-0.32, 0, 0.32].forEach((x, i) => {
    const rim = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), gaugeRim);
    rim.position.set(x, 0.84, -0.528);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.083, 24), new THREE.MeshBasicMaterial({ color: faces[i] }));
    face.position.set(x, 0.84, -0.526);
    const needle = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.075), new THREE.MeshBasicMaterial({ color: i === 1 ? 0xffd34a : 0x8dffb0 }));
    needle.geometry.translate(0, 0.037, 0);
    needle.position.set(x, 0.84, -0.524);
    scene.add(rim, face, needle);
    needles.push(needle);
  });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.24),
    new THREE.MeshBasicMaterial({ color: 0x8dffb0, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
  glass.position.set(0, 1.19, -0.6);
  glass.rotation.x = -0.3;
  scene.add(glass);

  // Canopy: sill rails, a windscreen arch in front, another behind your head.
  for (const s of [-1, 1]) box(0.06, 0.06, 2.8, s * 0.62, 1.1, 0.4, frame);
  const arch = (z, lean) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 6, 30, Math.PI), frame);
    m.position.set(0, 1.1, z);
    m.rotation.x = lean;
    scene.add(m);
  };
  arch(-0.85, -0.45);
  arch(1.75, 0.25);

  // Stick between the knees and the throttle on the left console: both move with your inputs.
  const stick = new THREE.Group();
  stick.position.set(0, 0.5, 0.3);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.34, 8), black);
  shaft.position.y = 0.17;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.11, 8), frame);
  grip.position.y = 0.37;
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff5a4f }));
  button.position.set(0, 0.43, -0.015);
  stick.add(shaft, grip, button);
  scene.add(stick);
  const throttle = new THREE.Group();
  throttle.position.set(-0.47, 0.9, 0.55);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.16, 0.035), black);
  lever.position.y = 0.08;
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.07), frame);
  knob.position.y = 0.17;
  throttle.add(lever, knob);
  scene.add(throttle);

  const ext = makeCockpitExt('jet');
  scene.add(ext);

  return { scene, camera, sun, needles, stick, throttle, ext };
}

// The outside of your own plane seen from the seat: the real model minus the fuselage shell (it
// would fill the seat) and canopy glass. Jet: a nose cone ahead of the dash and a spine behind the
// seat stand in for the fuselage. WW2: the long engine cowling over the dash, with the prop.
function makeCockpitExt(type) {
  const ext = makeAircraft(type);
  ext.remove(ext.userData.fus, ext.userData.glass);
  if (ext.userData.cowl) {
    ext.remove(ext.userData.cowl);
    const L = ext.userData.len;
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, L * 0.4, 10), ext.userData.cowl.material);
    cowl.geometry.rotateX(Math.PI / 2);
    cowl.position.set(0, 0.55, -L * 0.3);
    ext.userData.prop.position.y = 0.55;
    ext.add(cowl);
    return ext;
  }
  const skin = new THREE.MeshPhongMaterial({ color: 0x9aa7b4, flatShading: true });
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.62, 6.4, 8), skin);
  nose.geometry.rotateX(-Math.PI / 2);
  nose.position.set(0, 0.35, -4.3);
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 1.15, 5.6, 8), skin);
  spine.geometry.rotateX(Math.PI / 2);
  spine.position.set(0, 0.35, 4.7);
  ext.add(nose, spine);
  return ext;
}

// Swap your own model (and the cockpit's view of it) when you change plane.
function setOwnModel(w, type) {
  if (w.planeType === type) return;
  w.planeType = type;
  w.scene.remove(w.plane);
  w.plane = makeAircraft(type);
  styleNew(w, w.plane);
  w.scene.add(w.plane);
  const C = w.cockpit;
  C.scene.remove(C.ext);
  C.ext = makeCockpitExt(type);
  styleNew(w, C.ext);
  C.scene.add(C.ext);
}

// A four-engined bomber (wingspan 36 m), nose down -z. Props spin (userData.props); the gun
// turrets are only looks for now (crewing one is a later idea). Part positions match BOMBER_PARTS.
function makeBomberModel() {
  const g = new THREE.Group();
  const body = new THREE.MeshPhongMaterial({ color: 0x66704f, flatShading: true });
  const dark = new THREE.MeshPhongMaterial({ color: 0x3b4230, flatShading: true });
  const glassM = new THREE.MeshPhongMaterial({ color: 0x223344, shininess: 90 });
  const add = (geo, mat, x, y, z, ink) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); if (ink) addInk(m, 0.3); return m; };
  const fus = new THREE.CylinderGeometry(1.9, 1.3, 26, 10);
  fus.rotateX(Math.PI / 2);
  add(fus, body, 0, 0, 0, true);
  const nose = new THREE.SphereGeometry(1.9, 10, 8);
  nose.scale(1, 1, 1.6);
  add(nose, glassM, 0, 0, -13, false);
  add(new THREE.BoxGeometry(36, 0.5, 4.6), body, 0, 0, 0, true);
  add(new THREE.BoxGeometry(12, 0.3, 3), body, 0, 0.6, 12, true);
  add(new THREE.BoxGeometry(0.4, 5, 4.2), dark, 0, 3, 11.5, true);
  g.userData.props = [];
  for (const x of [-11, -5.5, 5.5, 11]) {
    const nac = new THREE.CylinderGeometry(1, 0.8, 5, 8);
    nac.rotateX(Math.PI / 2);
    add(nac, dark, x, -0.3, -2.5, true);
    const prop = add(new THREE.CircleGeometry(1.9, 16), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }), x, -0.3, -5.1, false);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.25, 0.1), dark);
    prop.add(blade);
    g.userData.props.push(prop);
  }
  add(new THREE.SphereGeometry(0.9, 8, 6), glassM, 0, 1.8, -6, false);   // top turret
  add(new THREE.SphereGeometry(0.8, 8, 6), glassM, 0, -1.8, -1, false);  // ball turret
  add(new THREE.SphereGeometry(0.7, 8, 6), glassM, 0, 0.2, 13.4, false); // tail gunner
  return g;
}

const BANDIT_PAINT = { body: 0x8a5a58, dark: 0x3a2426 };
const DUEL_PAINT = { body: 0x5a6f9a, dark: 0x23304a };

function makeDroneModel() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.OctahedronGeometry(9, 0), new THREE.MeshPhongMaterial({ color: 0xc8322b, emissive: 0x401010, flatShading: true })));
  const halo = new THREE.Mesh(new THREE.TorusGeometry(14, 1, 4, 16), new THREE.MeshBasicMaterial({ color: 0xff6a4f }));
  halo.rotation.x = Math.PI / 2;
  g.add(halo);
  g.userData.halo = halo;
  for (const part of g.children) addInk(part, 1.6);
  return g;
}

function makeRing() {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(CONFIG.RING_R, 3, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffd34a }));
  addInk(ring, 1.4);
  return ring;
}

// Tracers: every round is a glowing streak, a camera-facing ribbon (WebGL lines are always 1 px):
// bright head fading to a clear tail. Yours are yellow, everyone else's red-orange. (Not additive:
// over the pale sky additive washed every colour out to white.) The ribbon widens with distance so far rounds stay a few pixels wide.
const TRACER_MAX = 700;
const TRACER_LEN = 0.1;         // seconds of flight per streak (~100 m)
const TRACER_PX = 0.01;         // width per metre of distance (~6 px at 720p)
const TRACER_COLORS = {           // [head, tail]
  mine: [[1, 0.95, 0.5], [1, 0.7, 0.1]],
  theirs: [[1, 0.5, 0.25], [0.9, 0.15, 0.05]],
};

function makeTracers() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACER_MAX * 4 * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRACER_MAX * 4 * 4), 4));
  const idx = [];
  for (let i = 0; i < TRACER_MAX; i++) { const a = i * 4; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide
  }));
  mesh.frustumCulled = false;
  return mesh;
}

function updateTracers(w, bullets) {
  const pos = w.tracers.geometry.attributes.position, col = w.tracers.geometry.attributes.color;
  const cam = w.camera.position;
  let n = 0;
  for (const b of bullets) {
    if (n >= TRACER_MAX) break;
    // Never longer than the round has flown, so a streak never starts behind the gun.
    const tail = vSub(b.pos, vScale(b.vel, Math.min(TRACER_LEN, b.age)));
    const dir = vSub(b.pos, tail);
    if (vLen(dir) < 0.5) continue;
    const toCam = v3(cam.x - b.pos.x, cam.y - b.pos.y, cam.z - b.pos.z);
    const dist = vLen(toCam);
    let side = vCross(dir, toCam);
    if (vLen(side) < 1e-6) continue;
    side = vScale(vNorm(side), Math.max(0.05, dist * TRACER_PX) / 2);   // (a 0.3 m floor drew rounds whizzing past the camera as bars)
    const h0 = vAdd(b.pos, side), h1 = vSub(b.pos, side), t0 = vAdd(tail, side), t1 = vSub(tail, side);
    pos.array.set([h0.x, h0.y, h0.z, h1.x, h1.y, h1.z, t0.x, t0.y, t0.z, t1.x, t1.y, t1.z], n * 12);
    const [H, T] = b.owner === 'player' ? TRACER_COLORS.mine : TRACER_COLORS.theirs;
    const fade = 1 - Math.max(0, b.age - CONFIG.GUN_LIFE * 0.7) / (CONFIG.GUN_LIFE * 0.3);
    col.array.set([...H, fade, ...H, fade, ...T, 0, ...T, 0], n * 16);
    n++;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  w.tracers.geometry.setDrawRange(0, n * 6);
}

// Wingtip vapour: per tip, two crossed ribbons (one spanning the plane's up, one its wings), so
// the trail reads from behind, from the side and from the cockpit. Vertex alpha fades with age.
const TRAIL_MAX = 140;
const WINGTIP = { out: 7.4, back: 5.8 };   // tip of the delta wing in the plane's frame (WW2: spec.WINGTIP)

function makeTrail() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 4 * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 4 * 4), 4));
  const idx = [];
  for (let i = 0; i < TRAIL_MAX - 1; i++) {
    const a = i * 4, b = a + 4;
    idx.push(a, a + 1, b, a + 1, b + 1, b, a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  return { mesh, pts: [] };
}

function updateTrails(w, p, dt) {
  const k = p.crashed ? 0 : vaporAmount(w.prevFwd, p.fwd, dt);
  w.prevFwd = { ...p.fwd };
  w.vapor = k;
  w.trails.forEach((T, i) => {
    const side = i ? 1 : -1;
    const T0 = p.spec.WINGTIP || WINGTIP;
    const tip = vAdd(vAdd(p.pos, vScale(p.right, side * T0.out)), vScale(p.fwd, -T0.back));
    for (const s of T.pts) s.age += dt;
    // Respawn teleports the plane: don't draw a ribbon across the map.
    const last = T.pts[T.pts.length - 1];
    if (last && vDist(last.p, tip) > 120) T.pts.length = 0;
    T.pts.push({ p: tip, u: p.up, r: p.right, age: 0, k });
    while (T.pts.length > TRAIL_MAX || (T.pts.length && T.pts[0].age > CONFIG.VAPOR_LIFE)) T.pts.shift();
    const geo = T.mesh.geometry, pos = geo.attributes.position.array, col = geo.attributes.color.array;
    T.pts.forEach((s, j) => {
      const h = CONFIG.VAPOR_WIDTH * (1 + s.age * 3);
      const a = s.k * (1 - s.age / CONFIG.VAPOR_LIFE) * 0.55;
      const o = j * 12;
      pos[o] = s.p.x + s.u.x * h; pos[o + 1] = s.p.y + s.u.y * h; pos[o + 2] = s.p.z + s.u.z * h;
      pos[o + 3] = s.p.x - s.u.x * h; pos[o + 4] = s.p.y - s.u.y * h; pos[o + 5] = s.p.z - s.u.z * h;
      pos[o + 6] = s.p.x + s.r.x * h; pos[o + 7] = s.p.y + s.r.y * h; pos[o + 8] = s.p.z + s.r.z * h;
      pos[o + 9] = s.p.x - s.r.x * h; pos[o + 10] = s.p.y - s.r.y * h; pos[o + 11] = s.p.z - s.r.z * h;
      for (let v = 0; v < 4; v++) col.set([1, 1, 1, a], j * 16 + v * 4);
    });
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, Math.max(0, T.pts.length - 1) * 12);
  });
}

// Puffs are points with a soft round sprite (plain points draw as squares). Missile trails are
// big and pale; damage smoke is smaller and dark (made for right behind your own plane).
let puffSprite = null;
function makePuffSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeSmoke(opts = {}) {
  const MAX = opts.max || 1200;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
  geo.setDrawRange(0, 0);
  puffSprite = puffSprite || makePuffSprite();
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: opts.color ?? 0xe8e8e8, size: opts.size || 7, map: puffSprite,
    transparent: true, opacity: opts.opacity ?? 0.55, depthWrite: false }));
  points.frustumCulled = false;
  return { points, puffs: [], max: MAX, life: opts.life || 2.5 };
}

function updateSmoke(S, dt) {
  for (const p of S.puffs) p.age += dt;
  S.puffs = S.puffs.filter(p => p.age < S.life).slice(-S.max);
  const sp = S.points.geometry.attributes.position;
  S.puffs.forEach((p, i) => sp.array.set([p.x, p.y, p.z], i * 3));
  sp.needsUpdate = true;
  S.points.geometry.setDrawRange(0, S.puffs.length);
}

function setBasis(obj, fwd, up) {
  const f = tv(fwd), u = tv(up);
  const r = new THREE.Vector3().crossVectors(f, u).normalize();
  const m = new THREE.Matrix4().makeBasis(r, u, f.clone().negate());
  obj.quaternion.setFromRotationMatrix(m);
}

function addBoom(w, pos, size) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 1 }));
  m.position.copy(tv(pos));
  m.userData = { age: 0, size };
  w.scene.add(m);
  w.booms.push(m);
}

// look = { yaw, pitch } radians from head tracking (null = straight ahead).
function renderWorld(w, g, dt, now, look, ctrl) {
  const p = g.plane;
  recenterTerrain(w, p.pos.x, p.pos.z);
  recenterFarTerrain(w, p.pos.x, p.pos.z);
  w.sea.position.set(p.pos.x, 0, p.pos.z);
  // Fog opens up with altitude: low down it hides the detailed patch's edge, high up the far layer's.
  const fogFar = Math.min(CONFIG.FOG_MAX, CONFIG.FOG_BASE + Math.max(0, p.pos.y) * CONFIG.FOG_PER_ALT);
  w.scene.fog.far = fogFar;
  w.scene.fog.near = Math.min(2000, fogFar * 0.4) + Math.max(0, p.pos.y) * 0.5;

  w.clouds.list.forEach((c, i) => {
    const dx = c.x - p.pos.x, dz = c.z - p.pos.z;
    if (dx * dx + dz * dz > 5200 * 5200) {
      // Recycle behind-you clouds to somewhere ahead.
      const a = (Math.random() - 0.5) * 2.4;
      const h = vRotate(vNorm(v3(p.fwd.x, 0, p.fwd.z)), WORLD_UP, a);
      const d = 3500 + Math.random() * 1500;
      c.x = p.pos.x + h.x * d;
      c.y = 1200 + Math.random() * 1000;
      c.z = p.pos.z + h.z * d;
      placeCloud(w.clouds, i);
    }
  });

  setOwnModel(w, p.type);
  w.plane.position.copy(tv(p.pos));
  setBasis(w.plane, p.fwd, p.up);
  w.plane.visible = !p.crashed && w.view === 'chase';
  const inCockpit = !p.crashed && w.view === 'cockpit';
  if (inCockpit) {
    const C = w.cockpit;
    // Gauges: speed, throttle, altitude, as sweeping needles.
    const sweep = k => Math.PI * 0.75 - clamp(k, 0, 1) * Math.PI * 1.5;
    C.needles[0].rotation.z = sweep((p.speed - p.spec.SPEED_MIN * 0.7) / (p.spec.SPEED_MAX * 1.25 - p.spec.SPEED_MIN * 0.7));
    C.needles[1].rotation.z = sweep(p.throttle);
    C.needles[2].rotation.z = sweep(p.pos.y / CONFIG.CEILING);
    if (ctrl) {
      // Stick leans the way you're pushing it: right = roll right, back = pull.
      C.stick.rotation.set(ctrl.pitch * 0.35, 0, -ctrl.roll * 0.35);
      C.throttle.rotation.x = -(ctrl.throttle - 0.5) * 0.9;
    }
    // The sun, seen from inside the plane.
    C.sun.position.set(0.5, 1, 0.3).applyQuaternion(w.plane.quaternion.clone().invert());
  }
  const flameLen = 0.4 + p.throttle * 1.2 + Math.random() * 0.15;
  w.plane.userData.flame.scale.set(1, 1, flameLen);
  w.cockpit.ext.userData.flame.scale.set(1, 1, flameLen);
  // Props spin (a random angle each picture reads as a blur), unless the engine is cut.
  const spin = m => { if (m.userData.prop) m.userData.prop.rotation.z = Math.random() * 6.3; };
  if (!(p.engineCut > 0)) { spin(w.plane); spin(w.cockpit.ext); }

  // Drones: create/remove meshes to match the game list.
  const alive = new Set();
  for (const d of g.drones) {
    alive.add(d.id);
    let m = w.drones.get(d.id);
    if (!m) { m = makeDroneModel(); styleNew(w, m); w.drones.set(d.id, m); w.scene.add(m); }
    m.position.copy(tv(d.pos));
    m.rotation.y = now * 1.5;
    m.userData.halo.rotation.z = now * 3;
  }
  for (const [id, m] of w.drones) if (!alive.has(id)) { w.scene.remove(m); w.drones.delete(id); }

  // Bandits: same as drones, plane models flown by ai.js.
  const flying = new Set();
  // The duel opponent is drawn the same way, in its own colours.
  const others = (g.bandits || []).concat((g.remotes || []).filter(r => r.alive));
  for (const b of others) {
    flying.add(b.id);
    let m = w.bandits.get(b.id);
    // (Rebuilt if the type changed: the duel opponent picked another plane.)
    if (m && m.userData.planeType !== b.plane.type) { w.scene.remove(m); m = null; }
    if (!m) {
      m = makeAircraft(b.plane.type, b.kind === 'remote' ? DUEL_PAINT : BANDIT_PAINT);
      m.userData.planeType = b.plane.type;
      styleNew(w, m); w.bandits.set(b.id, m); w.scene.add(m);
    }
    m.position.copy(tv(b.plane.pos));
    setBasis(m, b.plane.fwd, b.plane.up);
    m.userData.flame.scale.set(1, 1, 0.4 + b.plane.throttle * 1.2 + Math.random() * 0.15);
    if (m.userData.prop) m.userData.prop.rotation.z = Math.random() * 6.3;
  }
  // Bombers keep their model while they fall burning.
  for (const b of g.bombers || []) {
    flying.add(b.id);
    let m = w.bandits.get(b.id);
    if (!m) { m = makeBomberModel(); styleNew(w, m); w.bandits.set(b.id, m); w.scene.add(m); }
    m.position.copy(tv(b.plane.pos));
    setBasis(m, b.plane.fwd, b.plane.up);
    b.burning.forEach((burn, i) => { m.userData.props[i].rotation.z += (burn ? 0.15 : 1.1); });
  }
  for (const [id, m] of w.bandits) if (!flying.has(id)) { w.scene.remove(m); w.bandits.delete(id); }

  w.ring.visible = !!g.ring;
  if (g.ring) {
    w.ring.position.copy(tv(g.ring.pos));
    w.ring.lookAt(tv(vAdd(g.ring.pos, g.ring.normal)));
  }

  updateTracers(w, g.bullets);

  // Missiles: pooled cones, and a smoke puff per frame each.
  while (w.missiles.length < g.missiles.length) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 4, 6), new THREE.MeshPhongMaterial({ color: 0xffffff }));
    m.geometry.rotateX(-Math.PI / 2);
    w.scene.add(m);
    w.missiles.push(m);
  }
  w.missiles.forEach((m, i) => {
    const ms = g.missiles[i];
    m.visible = !!ms;
    if (!ms) return;
    m.position.copy(tv(ms.pos));
    setBasis(m, ms.dir, Math.abs(ms.dir.y) > 0.99 ? v3(1, 0, 0) : WORLD_UP);
    w.smoke.puffs.push({ x: ms.pos.x, y: ms.pos.y, z: ms.pos.z, age: 0 });
  });
  updateSmoke(w.smoke, dt);
  updateSmoke(w.damageSmoke, dt);

  for (const e of g.events) {
    if (e.type === 'kill') addBoom(w, e.pos, e.bomber ? 80 : e.bandit ? 60 : 40);
    if (e.type === 'engine-fire') addBoom(w, e.pos, 14);
    if (e.type === 'bomber-crash') addBoom(w, e.pos, 120);
    if (e.type === 'hit' || e.type === 'duel-hit') addBoom(w, e.pos, 6);
    if (e.type === 'shot-down') addBoom(w, e.pos, 70);
    if (e.type === 'boom') addBoom(w, e.pos, 25);
    if (e.type === 'crash') addBoom(w, e.pos, 70);
  }
  for (const b of w.booms) {
    b.userData.age += dt;
    const k = b.userData.age / 1.2;
    b.scale.setScalar(b.userData.size * (0.3 + k));
    b.material.opacity = Math.max(0, 1 - k);
    b.material.color.setHex(k < 0.25 ? 0xfff0a0 : 0xff7a2a);
  }
  w.booms = w.booms.filter(b => {
    if (b.userData.age < 1.2) return true;
    w.scene.remove(b);
    b.geometry.dispose();
    b.material.dispose();
    return false;
  });

  updateTrails(w, p, dt);
  updateCamera(w, p, dt, look);
  // Hit: jolt the camera (position and a little roll), harder the bigger the hit.
  if (w.shake > 0.01 && !p.crashed) {
    const k = w.shake * w.shake, r = () => Math.random() * 2 - 1;
    w.camera.position.add(new THREE.Vector3(r(), r(), r()).multiplyScalar(2.2 * k));
    w.camera.rotateZ(r() * 0.05 * k);
    w.camera.rotateX(r() * 0.02 * k);
  }
  // Damaged planes trail smoke, thicker the worse it is.
  const smokeFrom = (pl, frac) => {
    if (pl.crashed || frac >= CONFIG.SMOKE_HP) return;
    const n = frac < 0.3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const at = vAdd(pl.pos, vScale(pl.fwd, -8 - Math.random() * 4));
      w.damageSmoke.puffs.push({ x: at.x + (Math.random() - 0.5) * 2, y: at.y + (Math.random() - 0.5) * 2, z: at.z + (Math.random() - 0.5) * 2, age: 0 });
    }
  };
  smokeFrom(p, g.hp / CONFIG.PLAYER_HP);
  for (const R of g.remotes || []) if (R.alive) smokeFrom(R.plane, R.hp / CONFIG.PLAYER_HP);
  for (const b of g.bandits || []) smokeFrom(b.plane, b.hp / b.maxHp);
  // Bombers smoke from each burning engine (all four once it's going down).
  for (const b of g.bombers || []) {
    CONFIG.BOMBER_PARTS.forEach(part => {
      if (part.zone !== 'engine' || (b.alive && !b.burning[part.engine]) || Math.random() < 0.3) return;
      const at = vAdd(bomberPartPos(b, part), vScale(b.plane.fwd, -3 - Math.random() * 3));
      w.damageSmoke.puffs.push({ x: at.x + (Math.random() - 0.5) * 2, y: at.y + (Math.random() - 0.5) * 2, z: at.z + (Math.random() - 0.5) * 2, age: 0 });
    });
  }
  w.renderer.clear();
  w.renderer.render(w.scene, w.camera);
  if (inCockpit) {
    // Same view direction as the world camera, expressed in the plane's frame.
    const C = w.cockpit;
    C.camera.quaternion.copy(w.plane.quaternion).invert().multiply(w.camera.quaternion);
    C.camera.fov = w.camera.fov;
    C.camera.aspect = w.camera.aspect;
    C.camera.updateProjectionMatrix();
    w.renderer.clearDepth();
    w.renderer.render(C.scene, C.camera);
  }
}

function updateCamera(w, p, dt, look) {
  const cam = w.camera;
  // Field of view widens with speed, the usual game trick for a sense of speed.
  const k = clamp((p.speed - p.spec.SPEED_MIN) / (p.spec.SPEED_MAX - p.spec.SPEED_MIN), 0, 1.25);
  const fov = CONFIG.FOV_BASE + CONFIG.FOV_SPEED * k;
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 3));
    cam.updateProjectionMatrix();
  }
  if (p.crashed) { cam.lookAt(tv(p.pos)); return; }
  const pos = tv(p.pos), up = tv(p.up);
  // Head look turns the view about the plane's own axes: yaw about its up, pitch about its wings.
  // In chase view that orbits the camera round the plane; in the cockpit it turns your head.
  const fwd = tv(p.fwd);
  if (look && (look.yaw || look.pitch)) {
    fwd.applyAxisAngle(up, -look.yaw);
    const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
    fwd.applyAxisAngle(side, look.pitch);
  }
  if (w.view === 'cockpit') {
    // Eye is fixed in the seat; head look only turns where it points.
    cam.position.copy(pos).addScaledVector(up, COCKPIT_EYE.y).addScaledVector(tv(p.fwd), -COCKPIT_EYE.z);
    cam.up.copy(up);
    cam.lookAt(pos.clone().addScaledVector(fwd, 200));
    w.camPos = null;
    return;
  }
  // (WW2 fighters are smaller and slower: the camera sits closer, spec.CHASE_BACK / CHASE_UP.)
  const want = pos.clone().addScaledVector(fwd, -(p.spec.CHASE_BACK ?? 36)).addScaledVector(up, p.spec.CHASE_UP ?? 8);
  if (!w.camPos) w.camPos = want.clone();
  w.camPos.lerp(want, 1 - Math.exp(-dt * 7));
  // The chase camera banks with the plane, a beat behind it, like Ace Combat's.
  w.camUp.lerp(up, 1 - Math.exp(-dt * 4)).normalize();
  cam.position.copy(w.camPos);
  cam.up.copy(w.camUp);
  cam.lookAt(pos.clone().addScaledVector(fwd, 90));
}

// ---- Anime look -----------------------------------------------------------------------------
// Purely how things are drawn (T). Lit materials swap to 3-band toon shading, ink outlines appear
// (inverted hull: a slightly bigger back-face copy in ink), and main.js draws on a 24 fps cadence
// while the game and the hand tracking keep running at full rate.
const INK = 0x161b2a;
const INK_MAT = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

function addInk(mesh, thick) {
  const g = mesh.geometry;
  g.computeBoundingSphere();
  const c = g.boundingSphere.center, s = 1 + thick / (g.boundingSphere.radius || 1);
  const ink = new THREE.Mesh(g, INK_MAT);
  // Scale about the part's own centre, so off-centre parts (the wing) grow in place.
  ink.scale.setScalar(s);
  ink.position.copy(c).multiplyScalar(1 - s);
  ink.userData.isInk = true;
  ink.visible = false;
  mesh.add(ink);
}

function toonGradient() {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function styleMesh(o, on, grad) {
  if (!o.isMesh) return;
  if (o.userData.isInk) { o.visible = on; return; }
  const m = o.material;
  if (on && (m.isMeshPhongMaterial || m.isMeshLambertMaterial)) {
    if (!m.userData.toon) {
      m.userData.toon = new THREE.MeshToonMaterial({
        color: m.color, vertexColors: m.vertexColors, emissive: m.emissive ? m.emissive.clone().multiplyScalar(0.6) : new THREE.Color(0),
        transparent: m.transparent, opacity: m.opacity, side: m.side, depthWrite: m.depthWrite, gradientMap: grad,
        polygonOffset: m.polygonOffset, polygonOffsetFactor: m.polygonOffsetFactor, polygonOffsetUnits: m.polygonOffsetUnits,
      });
      m.userData.toon.userData.orig = m;
    }
    o.material = m.userData.toon;
  } else if (!on && m.isMeshToonMaterial && m.userData.orig) {
    o.material = m.userData.orig;
  }
}

function setAnime(w, on) {
  w.anime = on;
  w.grad = w.grad || toonGradient();
  w.scene.traverse(o => styleMesh(o, on, w.grad));
  w.cockpit.scene.traverse(o => styleMesh(o, on, w.grad));
  w.clouds.ink.visible = on;
}

// Things created after the toggle (drones) pick up the current look.
function styleNew(w, obj) {
  if (w.anime) obj.traverse(o => styleMesh(o, true, w.grad));
}

function resizeWorld(w, W, H) {
  w.renderer.setSize(W, H, false);
  w.camera.aspect = W / H;
  w.camera.updateProjectionMatrix();
}

// World point → screen pixels, or null if behind the camera.
function projectToScreen(w, pos, W, H) {
  const v = tv(pos).project(w.camera);
  const behind = v.z > 1;
  return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, behind, on: !behind && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
}

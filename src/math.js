// math.js — small vector helpers and terrain noise. Pure: no DOM, no THREE.

function v3(x, y, z) { return { x, y, z }; }
function vAdd(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
function vSub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
function vScale(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function vCross(a, b) { return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
function vLen(a) { return Math.hypot(a.x, a.y, a.z); }
function vNorm(a) { const l = vLen(a) || 1; return v3(a.x / l, a.y / l, a.z / l); }
function vDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// Rodrigues: rotate v about unit axis k by angle a (right-handed).
function vRotate(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const kxv = vCross(k, v);
  const kdv = vDot(k, v) * (1 - c);
  return v3(v.x * c + kxv.x * s + k.x * kdv, v.y * c + kxv.y * s + k.y * kdv, v.z * c + kxv.z * s + k.z * kdv);
}

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Distance from point p to segment ab.
function segPointDist(a, b, p) {
  const ab = vSub(b, a);
  const t = clamp(vDot(vSub(p, a), ab) / (vDot(ab, ab) || 1), 0, 1);
  return vDist(vAdd(a, vScale(ab, t)), p);
}

// Deterministic PRNG so tests (and terrain) repeat.
function makeRng(seed) {
  let s = seed % 2147483647 || 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

// Rolling hills and sharp ridges, with sea below 0.
function terrainHeight(x, z) {
  let h = 0, amp = 1, f = 1 / 2400;
  for (let o = 0; o < 5; o++) {
    h += (valueNoise(x * f, z * f) - 0.5) * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  const ridge = 1 - Math.abs(valueNoise(x / 3000 + 50, z / 3000 + 50) * 2 - 1);
  return (h * 1.4 + ridge * ridge * 0.7 - 0.25) * CONFIG.TERRAIN_HEIGHT;
}

// What the plane collides with: ground or sea surface.
function groundHeight(x, z) {
  return Math.max(0, terrainHeight(x, z));
}

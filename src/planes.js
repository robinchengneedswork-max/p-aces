// planes.js — per-plane flight models. Each type lists only what differs from CONFIG: a spec is
// CONFIG with the type's own values laid over it (prototype fallback), so flightStep reads
// spec.PITCH_RATE etc. the same way whatever the plane. The jet is the game as it has always
// flown, i.e. the CONFIG values unchanged.
// Pure: no DOM, no THREE.

const PLANES = {
  jet: { name: 'JET' },
};
const DEFAULT_PLANE = 'jet';

const SPEC_CACHE = {};
function planeSpec(type) {
  const t = PLANES[type] ? type : DEFAULT_PLANE;
  return SPEC_CACHE[t] || (SPEC_CACHE[t] = Object.assign(Object.create(CONFIG), PLANES[t], { type: t }));
}

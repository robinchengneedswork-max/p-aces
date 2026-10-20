// planes.js — WW2 flight models against rough historical figures, plus checks that each plane's
// quirks work. Run: node test/planes.js [report]
//   report prints the performance table (top speed, climb, turns, zoom, over-G at full stick).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Math });
const src = ['config.js', 'math.js', 'planes.js', 'flight.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
vm.runInContext(src + '\n;this.__x = { CONFIG, PLANES, planeSpec, createPlane, flightStep, pitchEnvelope, v3, vDot };', ctx);
const X = ctx.__x;
const G = 9.81;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  — ' + detail : ''));
}

// Level-flight excess acceleration at speed v, full throttle, 1 G.
const excess = (s, v) => s.POWER / Math.max(v, s.V_STATIC) - s.DRAG_K * v * v;
// Max G the stick can pull at v (envelope), and the G the engine sustains at v.
const pullG = (s, v) => 1 + s.PITCH_RATE * X.pitchEnvelope(v, s) * v / s.A_PER_G;
const sustG = (s, v) => { const e = excess(s, v); return e > 0 ? 1 + Math.sqrt(e / (s.TURN_BLEED * Math.min(4, Math.pow(s.CORNER_SPEED / v, 2)))) : 1; };

function perf(type) {
  const s = X.planeSpec(type);
  let climb = 0, climbV = 0, sust = { t: Infinity }, inst = 0;
  for (let v = 40; v <= s.SPEED_MAX; v += 1) {
    const c = excess(s, v) * v / G;
    if (c > climb) { climb = c; climbV = v; }
    const gs = Math.min(sustG(s, v), pullG(s, v), s.G_LIMIT);
    const w = Math.sqrt(Math.max(0, gs * gs - 1)) * G / v;
    if (2 * Math.PI / w < sust.t) sust = { t: 2 * Math.PI / w, v, g: gs };
    const gi = Math.min(pullG(s, v), s.G_LIMIT);
    inst = Math.max(inst, Math.sqrt(gi * gi - 1) * G / v);
  }
  // Simulated: full stick from level at a speed, how many G and how long the wing lasts.
  // dive: start 60° nose down (pulling out of a dive, where gravity keeps the speed up).
  const yank = (v, dive) => {
    const p = X.createPlane(X.v3(0, 6000, 0), null, type);
    p.speed = v;
    if (dive) { const c = Math.cos(60 * Math.PI / 180), sn = Math.sin(60 * Math.PI / 180); p.fwd = X.v3(0, -sn, -c); p.up = X.v3(0, c, -sn); p.path = { ...p.fwd }; }
    let t = 0, peak = 0;
    for (; t < 10 && !p.wingFailed; t += 1 / 60) {
      X.flightStep(p, { roll: 0, pitch: 1, yaw: 0, throttle: 1 }, 1 / 60, false);
      peak = Math.max(peak, p.g);
    }
    return { g: peak, fail: p.wingFailed ? t : null };
  };
  // Simulated zoom: from top speed, pull to 60° climb and hold it until slow.
  const zoom = () => {
    const p = X.createPlane(X.v3(0, 3000, 0), null, type);
    p.speed = s.SPEED_MAX;
    const y0 = p.pos.y;
    for (let t = 0; t < 60 && p.speed > s.STALL_SPEED + 10; t += 1 / 60) {
      X.flightStep(p, { roll: 0, pitch: p.fwd.y < 0.85 ? 0.6 : 0, yaw: 0, throttle: 1 }, 1 / 60, false);
    }
    return p.pos.y - y0;
  };
  return { s, climb, climbV, sust, inst, y150: yank(150), y180: yank(180), d200: yank(200, true), zoom: zoom() };
}

const REAL = {   // rough historical figures, for the report
  spitfire: 'real: ~160 m/s, ~13 m/s climb, ~19 s turn',
  bf109: 'real: ~155 m/s, ~15 m/s climb, ~21-24 s turn',
  p51: 'real: ~195 m/s, ~16 m/s climb, ~22 s turn',
};
const P = {};
for (const t of ['spitfire', 'bf109', 'p51']) P[t] = perf(t);

if (process.argv[2] === 'report') {
  for (const [t, r] of Object.entries(P)) {
    console.log(r.s.name.padEnd(14), 'top', r.s.SPEED_MAX, 'm/s · climb', r.climb.toFixed(1), 'm/s at', r.climbV,
      '· sustained 360°', r.sust.t.toFixed(1), 's at', r.sust.v, 'm/s,', r.sust.g.toFixed(1), 'G · peak turn', (r.inst / Math.PI * 180).toFixed(0), '°/s');
    console.log(''.padEnd(14), 'zoom from top speed', Math.round(r.zoom), 'm · full stick at 150 m/s', r.y150.g.toFixed(1), 'G', r.y150.fail ? 'wing fails in ' + r.y150.fail.toFixed(1) + ' s' : 'holds',
      '· at 180', r.y180.g.toFixed(1), 'G', r.y180.fail ? 'fails in ' + r.y180.fail.toFixed(1) + ' s' : 'holds',
      '· pulling out of a 200 m/s dive', r.d200.g.toFixed(1), 'G', r.d200.fail ? 'fails in ' + r.d200.fail.toFixed(1) + ' s' : 'holds', '   (' + REAL[t] + ')');
  }
  console.log();
}

console.log('WW2 flight models');
check('Spitfire out-turns the 109 (sustained)', P.spitfire.sust.t < P.bf109.sust.t, P.spitfire.sust.t.toFixed(1) + ' vs ' + P.bf109.sust.t.toFixed(1) + ' s');
check('the 109 out-climbs the Spitfire', P.bf109.climb > P.spitfire.climb, P.bf109.climb.toFixed(1) + ' vs ' + P.spitfire.climb.toFixed(1) + ' m/s');
check('the P-51 is the fastest and climbs at least as well as the 109', P.p51.s.SPEED_MAX > P.bf109.s.SPEED_MAX && P.p51.climb >= P.bf109.climb - 0.5);
for (const [t, r] of Object.entries(P)) {
  check(r.s.name + ': climb 10-20 m/s, sustained turn 12-25 s', r.climb > 10 && r.climb < 20 && r.sust.t > 12 && r.sust.t < 25, r.climb.toFixed(1) + ' m/s, ' + r.sust.t.toFixed(1) + ' s');
  check(r.s.name + ': zoom climb trades speed for real height (> 700 m)', r.zoom > 700, Math.round(r.zoom) + ' m');
}

console.log('limits and quirks');
{
  // Level full throttle settles at SPEED_MAX.
  const p = X.createPlane(X.v3(0, 6000, 0), null, 'spitfire');
  p.speed = 100;
  for (let i = 0; i < 60 * 240; i++) X.flightStep(p, { roll: 0, pitch: 0, yaw: 0, throttle: 1 }, 1 / 60, false);
  check('full throttle levels off at top speed', Math.abs(p.speed - p.spec.SPEED_MAX) < 3, p.speed.toFixed(1));
  // At corner speed a full pull reaches the limit without breaking anything.
  const q = X.createPlane(X.v3(0, 6000, 0), null, 'spitfire');
  q.speed = q.spec.CORNER_SPEED;
  let peak = 0;
  for (let i = 0; i < 40; i++) { X.flightStep(q, { roll: 0, pitch: 1, yaw: 0, throttle: 1 }, 1 / 60, false); peak = Math.max(peak, q.g); }
  check('full pull at corner speed ≈ the G limit, wing fine', Math.abs(peak - q.spec.G_LIMIT) < 0.6 && !q.wingFailed, peak.toFixed(2) + ' G');
  check('full stick at 150 m/s: the pull bleeds speed fast enough that the wing holds', P.spitfire.y150.fail === null && P.p51.y150.fail === null);
  check('full stick pulling out of a 200 m/s dive fails the Spitfire wing, not instantly', P.spitfire.d200.fail !== null && P.spitfire.d200.fail > 0.8, P.spitfire.d200.fail && P.spitfire.d200.fail.toFixed(1) + ' s');
  check("…the 109's heavy elevator can't pull that hard (it just can't pull out quickly)", P.bf109.d200.fail === null, P.bf109.d200.g.toFixed(1) + ' G');
  // A brief yank over the limit is survivable; the stress heals back.
  const r = X.createPlane(X.v3(0, 6000, 0), null, 'spitfire');
  r.speed = 185;
  for (let i = 0; i < 20; i++) X.flightStep(r, { roll: 0, pitch: 1, yaw: 0, throttle: 1 }, 1 / 60, false);
  const stressed = r.wingStress;
  for (let i = 0; i < 60 * 3; i++) X.flightStep(r, { roll: 0, pitch: 0, yaw: 0, throttle: 1 }, 1 / 60, false);
  check('a short over-G yank stresses the wing, then it eases back', stressed > 0 && !r.wingFailed && r.wingStress < stressed, stressed.toFixed(2) + ' → ' + r.wingStress.toFixed(2));
  // The jet never has a wing limit.
  const j = X.createPlane(X.v3(0, 6000, 0), null, 'jet');
  j.speed = 250;
  for (let i = 0; i < 60 * 5; i++) X.flightStep(j, { roll: 0, pitch: 1, yaw: 0, throttle: 1 }, 1 / 60, false);
  check('the jet has no wing limit', !j.wingFailed);

  // Negative G: the Spitfire's engine cuts, the 109's doesn't.
  const bunt = type => {
    const b = X.createPlane(X.v3(0, 6000, 0), null, type);
    b.speed = 130;
    let cut = false;
    for (let i = 0; i < 60; i++) { X.flightStep(b, { roll: 0, pitch: -1, yaw: 0, throttle: 1 }, 1 / 60, false); cut = cut || b.engineCut > 0; }
    const s0 = b.speed;
    for (let i = 0; i < 30; i++) X.flightStep(b, { roll: 0, pitch: 0, yaw: 0, throttle: 1 }, 1 / 60, false);
    return { cut, still: b.engineCut > 0, g: b.g };
  };
  const sp = bunt('spitfire'), me = bunt('bf109');
  check('pushing over: the Spitfire\'s carburettor cuts the engine, and it stays cut a moment', sp.cut && sp.still);
  check('…the 109\'s fuel injection keeps running', !me.cut);

  // Controls stiffen at speed: less roll at 190 m/s than at 130.
  const roll = v => { const a = X.createPlane(X.v3(0, 6000, 0), null, 'spitfire'); a.speed = v; X.flightStep(a, { roll: 1, pitch: 0, yaw: 0, throttle: 1 }, 0.1, false); return Math.atan2(-a.right.y, a.up.y); };
  check('Spitfire ailerons stiffen in a fast dive', Math.abs(roll(190)) < Math.abs(roll(100)) * 0.85, (roll(190) / roll(100)).toFixed(2));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

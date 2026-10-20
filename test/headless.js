// headless.js — drives hands.js, flight.js and game.js with synthetic hands. No camera needed.
// Run: node test/headless.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Math });
const src = ['config.js', 'math.js', 'planes.js', 'flight.js', 'ai.js', 'hands.js', 'head.js', 'recorder.js', 'game.js', 'duel.js', 'escort.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
vm.runInContext(src + '\n;this.__x = { CONFIG, DEG, DEFAULT_NEUTRAL, v3, vDot, vLen, vCross, vSub, measureHand, assignHands, createControls, controlsUpdate, calibrateNeutral, createRangeSweep, rangeSweepAdd, rangeSweepFinish, escortReceive, escortStep, escortFriend, PLANES, planeSpec, PLANE_ENEMY, fireGuns, createPlane, flightStep, bankAngle, pitchEnvelope, planeVelocity, SKILLS, createBandit, pilotStep, spawnBandit, missileTti, gunSolution, spawnBomber, bomberPartPos, segPointDist, vNorm, vRotate, createDuel, duelReceive, duelSnapshot, duelRemoteStep, duelFlying, vDist, vAdd, vScale, groundHeight, createGame, gameUpdate, vaporAmount, headFollow, createClap, clapUpdate, assistOn, isCalibrated, neutralRoom, neutralFromRecording, RECORD_STEPS, createRecorder, recorderStep, recorderAdd, recorderResult, measureFace, createHead, headUpdate, calibrateHead };', ctx);
const X = ctx.__x;
const { CONFIG, DEG } = X;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
}

// ---- Synthetic hand ------------------------------------------------------------------
// Local frame (metres): x across the palm (index → pinky for a right hand), y down,
// z toward the back of the hand. Identity = palm to camera, fingers up.
function handLocal(opts) {
  const P = [];
  P[0] = [0, 0, 0];
  const thumbOpen = [[-0.03, -0.02, 0], [-0.05, -0.04, 0], [-0.065, -0.06, 0], [-0.075, -0.075, 0]];
  for (let i = 0; i < 4; i++) P[1 + i] = thumbOpen[i];
  const mcps = [[-0.025, -0.09, 0], [0, -0.095, 0], [0.02, -0.09, 0], [0.04, -0.08, 0]];
  mcps.forEach((m, f) => {
    const base = 5 + f * 4;
    P[base] = m;
    for (let k = 1; k <= 3; k++) {
      P[base + k] = opts.fist
        ? [m[0], m[1] + [0.01, 0.03, 0.02][k - 1], [-0.025, -0.035, -0.02][k - 1]]
        : [m[0], m[1] - 0.028 * k, 0];
    }
  });
  if (opts.pinch) P[4] = [P[8][0] + 0.005, P[8][1], P[8][2] - 0.005];
  if (opts.left) for (const p of P) p[0] = -p[0];
  return P;
}

// Rotate: pitch (about x: + tips fingers away from camera), then roll (about z: + clockwise on screen).
function rot(p, pitch, roll) {
  const [x, y0, z0] = p;
  const y = y0 * Math.cos(pitch) - z0 * Math.sin(pitch);
  const z = -y0 * Math.sin(pitch) + z0 * Math.cos(pitch);
  return [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll), z];
}

// A hand at image position (cx, cy), with orientation in degrees.
function hand(o = {}) {
  const pitch = (o.pitch ?? -70) * DEG, roll = (o.roll || 0) * DEG;
  // lean: the whole hand tipped about the screen's horizontal axis (+ = top away from the
  // camera), the way a fist on a stick moves when the stick is pulled back.
  const ln = (o.lean || 0) * DEG;
  const leanP = ([x, y, z]) => [x, y * Math.cos(ln) + z * Math.sin(ln), -y * Math.sin(ln) + z * Math.cos(ln)];
  const pts = handLocal(o).map(p => leanP(rot(p, pitch, roll)));
  const imgScale = 0.12 / 0.095 * (o.size || 1);  // palm length → 0.12 image units (size: nearer = bigger)
  const cx = o.cx ?? 0.5, cy = o.cy ?? 0.55;
  const jitter = () => (o.jitter ? (rnd() - 0.5) * o.jitter : 0);
  const lm = pts.map(p => ({ x: cx + p[0] * imgScale + jitter(), y: cy + p[1] * imgScale + jitter(), z: p[2] * imgScale }));
  // Centre the image landmarks on the palm like measureHand does, so cx/cy mean what they say.
  const pc = [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + lm[i].x / 5, a[1] + lm[i].y / 5], [0, 0]);
  for (const l of lm) { l.x += cx - pc[0]; l.y += cy - pc[1]; }
  const world = pts.map(p => ({ x: p[0], y: p[1], z: p[2] }));
  return { lm, world };
}

let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

function settings(over) { return { ...CONFIG.DEFAULTS, ...over }; }

// Feed n frames at 30 fps of the same hands (or a function of frame index).
function drive(handsFn, n, s, c = X.createControls(), t0 = 0) {
  for (let i = 0; i < n; i++) X.controlsUpdate(c, typeof handsFn === 'function' ? handsFn(i) : handsFn, t0 + i / 30, s);
  return c;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('hand geometry');
{
  // A real knuckle line slopes (pinky knuckle lower), so roll is read relative to a level hand.
  const tilt = o => X.measureHand(hand(o)).roll - X.measureHand(hand({ ...o, roll: 0 })).roll;
  check('knuckle line reads a 20° clockwise tilt', near(tilt({ roll: 20 }), 20 * DEG, 0.5 * DEG), (tilt({ roll: 20 }) / DEG).toFixed(2));
  check('left hand reads the same roll sign', near(tilt({ roll: 20, left: true }), 20 * DEG, 0.5 * DEG));
  const bias = X.measureHand(hand()).roll / DEG;
  check('uncalibrated level-hand bias sits inside the deadzone', Math.abs(bias) < CONFIG.DEFAULTS.deadzone * CONFIG.DEFAULTS.rollRange, bias.toFixed(2) + '°');
  const mp = X.measureHand(hand({ pitch: -50 }));
  check('palm tilt reads back (fingers forward −50°)', near(mp.pitch, -50 * DEG, 0.5 * DEG), (mp.pitch / DEG).toFixed(2));
  const mr = X.measureHand(hand({ pitch: -50, roll: 35 }));
  check('rolling the hand does not change its pitch reading', near(mr.pitch, -50 * DEG, 0.5 * DEG), (mr.pitch / DEG).toFixed(2));
  check('open hand reads open', X.measureHand(hand()).open > CONFIG.FIST_OFF);
  check('fist reads closed', X.measureHand(hand({ fist: true })).open < CONFIG.FIST_ON, X.measureHand(hand({ fist: true })).open.toFixed(2));
  check('pinch reads pinched', X.measureHand(hand({ pinch: true })).pinch < CONFIG.PINCH_ON);
  check('open thumb is not a pinch', X.measureHand(hand()).pinch > CONFIG.PINCH_OFF, X.measureHand(hand()).pinch.toFixed(2));
}

console.log('flat-hand scheme');
{
  const s = settings({ scheme: 'flat' });
  X.calibrateNeutral(s, [hand()]);
  check('level hand at neutral = no input', (() => { const c = drive([hand()], 30, s); return c.out.roll === 0 && c.out.pitch === 0; })());
  const cr = drive([hand({ roll: 25 })], 30, s);
  check('tilt right 25° → roll right', cr.out.roll > 0.3, cr.out.roll.toFixed(2));
  const cl = drive([hand({ roll: -25 })], 30, s);
  check('tilt left 25° → roll left, same size', near(cl.out.roll, -cr.out.roll, 1e-6));
  check('tilt 40° (past the range) → full roll', drive([hand({ roll: 40 })], 30, s).out.roll > 0.99);
  const cu = drive([hand({ pitch: -45 })], 30, s);
  check('fingers tipped up 25° → nose up', cu.out.pitch > 0.4, cu.out.pitch.toFixed(2));
  check('fingers tipped down → nose down', drive([hand({ pitch: -95 })], 30, s).out.pitch < -0.4);
  check('invert pitch flips it', drive([hand({ pitch: -45 })], 30, { ...s, invertPitch: true }).out.pitch < -0.4);
  const cb = drive([hand({ roll: 30 })], 30, s);
  check('pure roll gives no pitch', cb.out.pitch === 0, cb.out.pitch.toFixed(3));
  check('2° tremor is inside the deadzone', drive(i => [hand({ roll: 2 * Math.sin(i) })], 60, s).out.roll === 0);
  const c20 = drive([hand({ roll: 20 })], 30, s);
  const cj = X.createControls();
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    X.controlsUpdate(cj, [hand({ roll: 20, jitter: 0.004 })], i / 30, s);
    if (i > 30) worst = Math.max(worst, Math.abs(cj.out.roll - c20.out.roll));
  }
  check('landmark jitter (±2 px) barely moves a held tilt', worst < 0.06, 'worst ' + worst.toFixed(3));
  const ch = drive([hand({ cy: 0.4 })], 30, { ...s, pitchSrc: 'height' });
  check('height pitch: raising the hand = nose up', ch.out.pitch > 0.4, ch.out.pitch.toFixed(2));
}

console.log('stick scheme');
{
  // Gripping a stick seen from the front: knuckle line near vertical (88°). Calibrated on the
  // centre grip, as the start-up countdown does. lean = stick tipped toward/away from camera,
  // roll = tipped sideways on screen.
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.6, ...o, roll: GRIP + (o.roll || 0) });
  const s = settings({ scheme: 'stick' });
  X.calibrateNeutral(s, [fist({})]);
  check('fist at centre = no input', (() => { const c = drive([fist({})], 30, s); return c.out.roll === 0 && c.out.pitch === 0; })());
  const ax = X.measureHand(fist({})).axW;
  check('ring axis of an upright grip points up the stick', ax.y < -0.95, 'axis ' + ax.x.toFixed(2) + ',' + ax.y.toFixed(2) + ',' + ax.z.toFixed(2));
  // Leaning a stick pinned at its base slides the fist sideways and tips it: both happen.
  const right = o => fist({ cx: 0.5 + 0.06, roll: 15, ...o });
  const r15 = drive([right({})], 30, s);
  const slide = 0.06 / 0.12 / s.stickThrow;
  check('stick leaned right (fist slides ½ palm) → roll right', r15.out.roll > 0.3 && Math.abs(r15.raw.roll - slide) < 0.03, r15.raw.roll.toFixed(2) + ' (expect ' + slide.toFixed(2) + ')');
  check('stick leaned left → roll left', drive([fist({ cx: 0.44, roll: -15 })], 30, s).out.roll < -0.3);
  const pull = drive([fist({ lean: 20 })], 30, s);
  check('stick pulled back 20° → nose up', pull.out.pitch > 0.4, pull.raw.pitch.toFixed(2));
  check('stick pushed forward 20° → nose down', drive([fist({ lean: -20 })], 30, s).out.pitch < -0.4);
  check('half the pull reads about half', Math.abs(drive([fist({ lean: 10 })], 30, s).raw.pitch / pull.raw.pitch - 0.5) < 0.1);
  check('a pull does not leak into roll', Math.abs(pull.raw.roll) < 0.05, pull.raw.roll.toFixed(3));
  check('a roll does not leak into pitch', Math.abs(r15.raw.pitch) < 0.05, r15.raw.pitch.toFixed(3));
  const both = drive([right({ lean: 20 })], 30, s);
  check('pull + roll together read as both', both.out.roll > 0.3 && both.out.pitch > 0.4, both.raw.roll.toFixed(2) + ' / ' + both.raw.pitch.toFixed(2));
  // Pitch is an angle now: sitting closer or raising the fist doesn't move it.
  const moved = drive([fist({ cy: 0.5, size: 1.25 })], 30, s);
  check('sitting closer / raising the fist (no lean) does not steer', moved.out.roll === 0 && moved.out.pitch === 0,
    moved.raw.roll.toFixed(3) + ' / ' + moved.raw.pitch.toFixed(3));
  const pushTilt = drive([fist({ lean: -25, roll: -15 })], 30, s);
  check('a push that also tips the stick sideways does not roll (the slide is what rolls)', pushTilt.out.roll === 0 && pushTilt.out.pitch < -0.4,
    pushTilt.raw.roll.toFixed(2) + ' / ' + pushTilt.raw.pitch.toFixed(2));
  check('an old (pre-ring-axis) stick calibration counts as uncalibrated', !X.isCalibrated(settings({ scheme: 'stick', neutral: { stick: { cx: 0.5, cy: 0.6, scale: 0.12, roll: 0, pitch: 0 } } })));
  const c = drive([fist({ cx: 0.96 })], 5, s);
  check('fist near the frame edge raises the edge warning', c.edge);
  check('stick defaults to rate roll (hold over = keep rolling); flat to assist',
    !X.assistOn(s) && X.assistOn(settings({ scheme: 'flat' })));
  // Stick drops out for 0.5 s (odd angle): input must hold, not spring back.
  const cl = drive([fist({ roll: 25 })], 30, s);
  const held = cl.out.roll;
  for (let i = 0; i < 15; i++) X.controlsUpdate(cl, [], 1 + i / 30, s);
  check('stick: a 0.5 s dropout holds the input', cl.out.roll === held);
}

console.log('two hands');
{
  const s = settings({ scheme: 'flat' });
  const fly = hand({ cx: 0.7, roll: 25 }), thr = hand({ cx: 0.3, left: true, cy: 0.3 });
  const a = X.assignHands([thr, fly], s);
  check('right hand (screen right) flies', a.fly === fly && a.thr === thr);
  check('H swap: left hand flies', X.assignHands([thr, fly], settings({ hand: 'left' })).fly === thr);
  const c = drive([thr, fly], 30, s);
  check('throttle hand high → near full throttle', c.out.throttle > 0.9, c.out.throttle.toFixed(2));
  check('throttle hand low → idle', drive([hand({ cx: 0.3, cy: 0.85 }), fly], 30, s).out.throttle < 0.1);
  check('roll still comes from the flying hand', c.out.roll > 0.3);
  check('pinch → gun', drive([hand({ cx: 0.3, pinch: true }), fly], 10, s).out.gun);
  let missiles = 0, guns = 0;
  const cc = X.createControls();
  for (let i = 0; i < 60; i++) {
    X.controlsUpdate(cc, [hand({ cx: 0.3, fist: i >= 10 && i < 40 }), fly], i / 30, s);
    if (cc.out.missile) missiles++;
    if (cc.out.gun) guns++;
  }
  check('holding a fist fires exactly one missile', missiles === 1, missiles + ' missiles');
  check('a fist is not read as a pinch', guns === 0, guns + ' gun frames');
}

console.log('from the first recordings');
{
  const s = settings({ scheme: 'stick' });
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.7, cx: 0.78, ...o, roll: GRIP + (o.roll || 0) });
  const open = hand({ cx: 0.26, cy: 0.72, left: true });
  X.calibrateNeutral(s, [fist({})]);
  // Recording 1, push: both hands seen, then the stick fist drops out and only the open
  // throttle hand on the left is left in view.
  const c = X.createControls();
  for (let i = 0; i < 30; i++) X.controlsUpdate(c, [open, fist({})], i / 30, s);
  let worst = 0;
  for (let i = 0; i < 20; i++) {
    X.controlsUpdate(c, [open], 1 + i / 30, s);
    worst = Math.max(worst, Math.abs(c.out.roll), Math.abs(c.out.pitch));
  }
  check('fist drops out: the open throttle hand does NOT take over flying', c.assigned.fly === null && c.assigned.thr === open && worst === 0,
    'fly ' + (c.assigned.fly ? 'throttle hand!' : 'none') + ', worst input ' + worst.toFixed(2));
  X.controlsUpdate(c, [fist({})], 2, s);
  check('…and the fist coming back alone is the flying hand again', c.assigned.fly !== null && c.assigned.thr === null);
  const solo = X.createControls();
  X.controlsUpdate(solo, [fist({ cx: 0.3 })], 0, s);
  check('one hand from the start flies, wherever it is', solo.assigned.fly !== null);

  // Centre drifted: hand held still, but reads as steering.
  const cs = X.createControls();
  for (let i = 0; i < 120; i++) X.controlsUpdate(cs, [fist({ lean: 15 })], i / 30, s);
  check('still hand that keeps steering → "press C to re-centre" hint', cs.offCentre);
  const cm = X.createControls();
  for (let i = 0; i < 120; i++) X.controlsUpdate(cm, [fist({ lean: 15, cx: 0.78 + 0.1 * Math.sin(i / 6) })], i / 30, s);
  check('…but not while the hand is actually moving', !cm.offCentre);
  const cn = X.createControls();
  for (let i = 0; i < 120; i++) X.controlsUpdate(cn, [fist({})], i / 30, s);
  check('…and not when it rests centred', !cn.offCentre);

  check('calibrating at 78% across warns about room to roll', X.neutralRoom({ cx: 0.78, cy: 0.6 }) !== '');
  check('calibrating mid-frame does not', X.neutralRoom({ cx: 0.5, cy: 0.55 }) === '');
}

console.log('left-hand rudder');
{
  const s = settings({ scheme: 'stick' });
  const stick = hand({ fist: true, pitch: 0, cy: 0.6, cx: 0.72, roll: 88 });
  // The throttle hand rests at its own angle (12°); calibration takes it as "no rudder".
  const left = o => hand({ left: true, cx: 0.28, cy: 0.55, ...o, roll: 12 + (o.roll || 0) });
  X.calibrateNeutral(s, [left({}), stick]);
  check('calibration records the rudder hand resting angle', s.neutral.thr && Math.abs(s.neutral.thr.roll - X.measureHand(left({})).roll) < 1e-9);
  check('left hand at rest = no rudder', drive([left({}), stick], 30, s).out.yaw === 0);
  // Rudder only for a big, deliberate turn toward 90° (user: small turns made it hard to focus).
  check('a 40° turn of the left hand is still no rudder', drive([left({ roll: 40 }), stick], 30, s).out.yaw === 0);
  const right = drive([left({ roll: 80 }), stick], 30, s);
  check('turn the left hand clockwise ~80° → right rudder', right.out.yaw > 0.5, right.out.yaw.toFixed(2));
  check('anticlockwise ~80° → left rudder', drive([left({ roll: -80 }), stick], 30, s).out.yaw < -0.5);
  const full = drive([left({ roll: 92 }), stick], 30, s);
  check('…a turn just past 90° stays right rudder (no flip where the folded angle wraps)', full.out.yaw > 0.9, full.out.yaw.toFixed(2));
  check('raising the left hand (throttle) does not steer', drive([left({ cy: 0.3 }), stick], 30, s).out.yaw === 0);
  check('pinching (guns) does not steer', drive([left({ pinch: true }), stick], 30, s).out.yaw === 0);
  check('fist (missile) does not steer', drive([left({ fist: true }), stick], 30, s).out.yaw === 0);
  check('rudder does not touch roll or pitch', right.out.roll === 0 && right.out.pitch === 0);
  check('a 5° wobble of the left hand stays inside the rudder deadzone', drive([left({ roll: 5 }), stick], 30, s).out.yaw === 0);
  check('rudder deadzone is its own setting (0 = every degree counts)', drive([left({ roll: 5 }), stick], 30, { ...s, yawDeadzone: 0 }).out.yaw > 0);
  check('Y off → no rudder from the hand', drive([left({ roll: 80 }), stick], 30, { ...s, thrRudder: false }).out.yaw === 0);
  const gone = drive([left({ roll: 80 }), stick], 30, s);
  for (let i = 0; i < 30; i++) X.controlsUpdate(gone, [stick], 1 + i / 30, s);
  check('left hand leaves view → rudder returns to centre', Math.abs(gone.out.yaw) < 0.01);
}

console.log('double clap');
{
  const pair = (gapPalms, extra = {}) => {
    const half = gapPalms * 0.12 / 2;
    return [hand({ cx: 0.5 - half, cy: 0.5, left: true, ...extra }), hand({ cx: 0.5 + half, cy: 0.5, ...extra })];
  };
  // Feed a sequence of [seconds, hands] and count triggers.
  const run = seq => {
    const cl = X.createClap();
    let fired = 0, tt = 0;
    for (const [secs, hs] of seq) for (let i = 0; i < secs * 30; i++) { if (X.clapUpdate(cl, hs, tt)) fired++; tt += 1 / 30; }
    return fired;
  };
  const apart = pair(4), touch = pair(0.6);
  check('two claps (apart, together, apart, together) → calibrate once',
    run([[0.5, apart], [0.1, touch], [0.25, apart], [0.1, touch], [0.5, apart]]) === 1);
  check('one clap does nothing', run([[0.5, apart], [0.1, touch], [1, apart]]) === 0);
  check('two claps 2 s apart do nothing', run([[0.5, apart], [0.1, touch], [2, apart], [0.1, touch], [0.5, apart]]) === 0);
  // At contact the tracker often merges the two palms into one detection.
  const merged = [hand({ cx: 0.5, cy: 0.5 })];
  check('palms merging into one detection count as a clap', run([[0.5, pair(2.8)], [0.1, merged], [0.25, apart], [0.1, pair(2.8)], [0.1, merged], [0.5, apart]]) === 1);
  check('bringing hands near but not touching (2 palms apart) does nothing', run([[0.5, apart], [0.2, pair(2)], [0.3, apart], [0.2, pair(2)], [0.5, apart]]) === 0);
  // Normal flying: stick fist on the right, throttle hand on the left, moving about.
  const cl = X.createClap();
  let fired = 0;
  for (let i = 0; i < 300; i++) {
    const hs = [hand({ cx: 0.3, cy: 0.5 + 0.1 * Math.sin(i / 9), left: true }), hand({ fist: true, pitch: 0, roll: 88, cx: 0.7 + 0.05 * Math.sin(i / 5), cy: 0.6 })];
    if (X.clapUpdate(cl, hs, i / 30)) fired++;
  }
  check('ten seconds of normal two-handed flying never triggers it', fired === 0);
  const lone = X.createClap();
  let f2 = 0;
  for (let i = 0; i < 120; i++) if (X.clapUpdate(lone, i % 20 < 10 ? [hand({ cx: 0.7 })] : [], i / 30)) f2++;
  check('one hand flickering in and out of view never triggers it', f2 === 0);
}

console.log('smoothing');
{
  // Hand tracking updates ~20x/s; the game draws at 60. Between camera frames the output should
  // glide, not jump. Feed a step at 20 Hz and sample at 60 Hz.
  const s = settings({ scheme: 'flat' });
  X.calibrateNeutral(s, [hand()]);
  const c = X.createControls();
  for (let i = 0; i < 60; i++) X.controlsUpdate(c, [hand()], i / 60, s);
  const seq = [];
  for (let i = 0; i < 30; i++) { X.controlsUpdate(c, [hand({ roll: 30 })], 1 + i / 60, s); seq.push(c.out.roll); }
  const jumps = seq.slice(1).map((v, i) => v - seq[i]);
  check('a sudden full input ramps in over several drawn frames, not one jump', Math.max(...jumps) < 0.35 && seq[seq.length - 1] > 0.6,
    'biggest jump ' + Math.max(...jumps).toFixed(2) + ', after 0.5 s ' + seq[seq.length - 1].toFixed(2));
  check('pitch default is more sensitive than before (18° of stick lean = full)', CONFIG.DEFAULTS.stickPitch === 18);
}

console.log('hand lost');
{
  const s = settings();
  const c = drive([hand({ roll: 30 })], 30, s);
  const held = c.out.roll;
  X.controlsUpdate(c, [], 30 / 30 + 0.1, s);
  check('a dropped frame holds the input', c.out.roll === held);
  for (let i = 0; i < 60; i++) X.controlsUpdate(c, [], 1.2 + i / 30, s);
  check('hand gone for 2 s → stick springs back to centre', c.out.roll === 0, c.out.roll.toFixed(3));
}

console.log('input clean-up');
{
  const s = settings({ scheme: 'stick' });
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.6, ...o, roll: GRIP + (o.roll || 0) });
  X.calibrateNeutral(s, [fist({})]);
  // A one-reading glitch 3 palms away (the first recording's swapped hand) is ignored…
  const c = drive([fist({ cx: 0.55 })], 30, s);
  const held = c.out.roll;
  X.controlsUpdate(c, [fist({ cx: 0.9 })], 1, s);
  X.controlsUpdate(c, [fist({ cx: 0.55 })], 1 + 1 / 30, s);
  check('a one-reading jump of 3 palms is ignored', Math.abs(c.out.roll - held) < 0.02, (c.out.roll - held).toFixed(3));
  // …but a hand that stays over there really moved.
  drive([fist({ cx: 0.9 })], 20, s, c, 2);
  check('…a hand that stays there is believed after a few readings', c.out.roll > 0.8, c.out.roll.toFixed(2));
  // A fast real move (0.4 palms per reading, the recordings' worst) is never rejected.
  const f = X.createControls();
  drive([fist({})], 10, s, f);
  let rejected = 0;
  for (let i = 0; i < 6; i++) { X.controlsUpdate(f, [fist({ cx: 0.5 + 0.048 * (i + 1) })], 1 + i / 20, s); if (f.jumped) rejected++; }
  check('a fast real roll (0.4 palms/reading) is never rejected', rejected === 0, rejected + ' rejected');
  // Pitch is filtered harder than roll.
  const lean = (i, ax) => [fist({ lean: ax === 'p' ? (i % 2 ? 4 : -4) : 0, cx: ax === 'r' ? (i % 2 ? 0.51 : 0.49) : 0.5 })];
  const jit = (ax, over) => { const c2 = X.createControls(); let w = 0; for (let i = 0; i < 60; i++) { X.controlsUpdate(c2, lean(i, ax), i / 20, { ...s, ...over }); if (i > 20) w = Math.max(w, Math.abs(ax === 'p' ? c2.raw.pitch : c2.raw.roll)); } return w; };
  check('pitch smooth: a lower cutoff calms pitch jitter', jit('p', { pitchSmooth: 0.3 }) < jit('p', { pitchSmooth: 3 }) * 0.6);
  check('pitch smooth leaves roll alone', jit('r', { pitchSmooth: 0.3 }) === jit('r', { pitchSmooth: 3 }));
}
{
  const s = settings({ scheme: 'flat' });
  const fly = hand({ cx: 0.7 });
  const thr = o => hand({ cx: 0.3, cy: 0.5, left: true, ...o });
  // Guns: one glitched pinch reading doesn't fire; a held pinch fires on its 2nd reading.
  const c = drive([thr({}), fly], 10, s);
  X.controlsUpdate(c, [thr({ pinch: true }), fly], 1, s);
  const one = c.out.gun;
  X.controlsUpdate(c, [thr({}), fly], 1.05, s);
  check('a single-reading pinch does not fire the guns', !one && !c.out.gun);
  X.controlsUpdate(c, [thr({ pinch: true }), fly], 2, s);
  X.controlsUpdate(c, [thr({ pinch: true }), fly], 2.016, s, false);   // a drawn frame, no new reading
  const notYet = c.out.gun;
  X.controlsUpdate(c, [thr({ pinch: true }), fly], 2.05, s);
  check('a held pinch fires on its second camera reading (drawn frames do not count)', !notYet && c.out.gun);
  X.controlsUpdate(c, [thr({}), fly], 2.1, s);
  check('…and stops on the first open reading', !c.out.gun);
  // Missiles: instant, and a quick fist-open-fist-open fires two.
  const m = drive([thr({}), fly], 10, s);
  let missiles = 0, first = -1;
  [1, 1, 0, 0, 1, 1, 0].forEach((k, i) => { X.controlsUpdate(m, [thr({ fist: !!k }), fly], 1 + i / 20, s); if (m.out.missile) { missiles++; if (first < 0) first = i; } });
  check('missiles: instant on the first fist reading, and two quick fists fire two', missiles === 2 && first === 0, missiles + ' missiles, first at ' + first);
  // A fist that drags the palm down doesn't cut the throttle or kick the rudder.
  const k = drive([thr({ cy: 0.4 }), fly], 40, s);
  const thr0 = k.out.throttle, yaw0 = k.out.yaw;
  for (let i = 0; i < 4; i++) X.controlsUpdate(k, [thr({ cy: 0.4 + 0.03 * (i + 1), fist: i === 3, roll: 5 * (i + 1) }), fly], 2 + i / 20, s);
  for (let i = 0; i < 6; i++) X.controlsUpdate(k, [thr({ cy: 0.52, fist: true, roll: 25 }), fly], 2.2 + i / 20, s);
  check('a fist (palm dragged down + twisted) leaves throttle where it was', Math.abs(k.out.throttle - thr0) < 0.03, (k.out.throttle - thr0).toFixed(3));
  check('…and the rudder too', Math.abs(k.out.yaw - yaw0) < 0.05, (k.out.yaw - yaw0).toFixed(3));
  for (let i = 0; i < 20; i++) X.controlsUpdate(k, [thr({ cy: 0.7 }), fly], 3 + i / 20, s);
  check('open again: throttle follows the hand once more', k.out.throttle < thr0 - 0.2, k.out.throttle.toFixed(2));
}

console.log('range calibration');
{
  const s = settings({ scheme: 'stick' });
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.6, cx: 0.6, ...o, roll: GRIP + (o.roll || 0) });
  const thr = o => hand({ cx: 0.25, cy: 0.5, left: true, ...o });
  X.calibrateNeutral(s, [thr({}), fist({})]);
  // Before: a short 0.04 slide is under half roll; the left hand at 0.45-0.55 is mid throttle.
  const before = drive([thr({}), fist({ cx: 0.64 })], 40, s).out.roll;
  // Sweep: the fist only ever slides ±0.05 and leans ±8°; the left hand moves 0.4-0.6 and turns ±12°.
  const sw = X.createRangeSweep();
  for (let i = 0; i < 60; i++) {
    const k = Math.sin(i / 6), j = Math.cos(i / 6);
    X.rangeSweepAdd(sw, [thr({ cy: 0.5 + 0.1 * k, roll: 12 * j }), fist({ cx: 0.6 + 0.05 * k, lean: 8 * j })], s);
  }
  const set = X.rangeSweepFinish(sw, s);
  check('the sweep sets every direction it saw', ['roll left', 'roll right', 'pull', 'push', 'throttle'].every(d => set.includes(d)), set.join(', '));
  const after = drive([thr({}), fist({ cx: 0.64 })], 40, s).out.roll;
  check('after the sweep a short slide reaches (near) full roll', before < 0.5 && after > 0.85, before.toFixed(2) + ' → ' + after.toFixed(2));
  const lean = drive([thr({}), fist({ lean: 7 })], 40, s).out.pitch;
  check('…and a short lean reaches (near) full pitch', lean > 0.8, lean.toFixed(2));
  const top = drive([thr({ cy: 0.41 }), fist({})], 60, s).out.throttle, bot = drive([thr({ cy: 0.59 }), fist({})], 60, s).out.throttle;
  check('throttle spans your own up/down travel', top > 0.95 && bot < 0.05, top.toFixed(2) + ' / ' + bot.toFixed(2));
  // Re-centring keeps the range.
  X.calibrateNeutral(s, [thr({}), fist({})]);
  check('re-centring (C) keeps the swept range', !!s.neutral.stick.range && !!s.neutral.thr.cy);
  check('the sweep leaves the rudder alone (it needs a deliberate ~90° turn)', !s.neutral.thr.yaw);
  // A sweep where the hand never moved changes nothing.
  const s2 = settings({ scheme: 'stick' });
  X.calibrateNeutral(s2, [fist({})]);
  const still = X.createRangeSweep();
  for (let i = 0; i < 30; i++) X.rangeSweepAdd(still, [fist({ cx: 0.6 + 0.002 * Math.sin(i) })], s2);
  const none = X.rangeSweepFinish(still, s2);
  check('a sweep with no movement sets nothing (sliders keep working)', none.length === 0 && s2.neutral.stick.range.roll[1] === 1);
}

console.log('calibration');
{
  const s = settings({ scheme: 'flat' });
  const odd = hand({ roll: 12, pitch: -30, cx: 0.4, cy: 0.5 });
  check('calibrate snapshots the flying hand', X.calibrateNeutral(s, [odd]));
  const c = drive([odd], 30, s);
  check('calibrated pose now reads as centre', c.out.roll === 0 && c.out.pitch === 0);
  check('calibration is per scheme', !s.neutral.stick);
  check('flight stick is the default scheme', CONFIG.DEFAULTS.scheme === 'stick');
  check('calibrating with no hand fails', !X.calibrateNeutral(settings(), []));
}

console.log('head look');
// Synthetic head, metres, mirrored-view axes (x right, y down, z toward camera).
// Keypoint order matches the detector: R eye, L eye, nose, mouth, R ear, L ear.
const HEAD = [[0.033, -0.03, 0.08], [-0.033, -0.03, 0.08], [0, 0, 0.11], [0, 0.045, 0.085], [0.075, 0, 0], [-0.075, 0, 0]];
function face(yawDeg = 0, pitchDeg = 0, o = {}) {
  const a = yawDeg * DEG, b = pitchDeg * DEG, S = 2;
  return HEAD.map(([x, y, z]) => {
    const x1 = x * Math.cos(a) + z * Math.sin(a), z1 = -x * Math.sin(a) + z * Math.cos(a);
    const y2 = y * Math.cos(b) - z1 * Math.sin(b);
    const j = () => (o.jitter ? (rnd() - 0.5) * o.jitter : 0);
    return { x: (o.cx ?? 0.5) + x1 * S * (o.scale || 1) + j(), y: 0.4 + y2 * S * (o.scale || 1) + j() };
  });
}
function look(kpFn, n, s, h = X.createHead(), t0 = 0) {
  for (let i = 0; i < n; i++) {
    X.headUpdate(h, typeof kpFn === 'function' ? kpFn(i) : kpFn, t0 + i / 30, s);
    X.headFollow(h, 1 / 30, s);
  }
  return h;
}
{
  // These sizes were tuned at a 0.045 head deadzone; the default is now 0.065 (user), checked below.
  const auto = look(i => (i < 20 ? face() : face(15)), 50, settings({ headDeadzone: 0.045 }));
  check('uncalibrated: first frames become forward, then turns read', auto.look.yaw > 40 * DEG && Math.abs(auto.look.pitch) < 5 * DEG,
    (auto.look.yaw / DEG).toFixed(0) + '° / ' + (auto.look.pitch / DEG).toFixed(0) + '°');
  const s = settings({ headNeutral: X.measureFace(face()), headDeadzone: 0.045 });
  check('default head deadzone ignores a small 4° nod', look(face(0, -4), 30, settings({ headNeutral: X.measureFace(face()) })).look.pitch === 0);
  check('facing the camera = looking forward', (() => { const h = look(face(), 30, s); return h.look.yaw === 0 && h.look.pitch === 0; })());
  const r = look(face(15), 30, s);
  check('turn head 15° right → view swings well right (amplified)', r.look.yaw > 40 * DEG, (r.look.yaw / DEG).toFixed(0) + '°');
  check('turn head left → view left, same size', near(look(face(-15), 30, s).look.yaw, -r.look.yaw, 1 * DEG));
  check('head turn barely moves view pitch', Math.abs(r.look.pitch) < 5 * DEG, (r.look.pitch / DEG).toFixed(1) + '°');
  const u = look(face(0, 12), 30, s);
  check('tip head up → view up', u.look.pitch > 10 * DEG, (u.look.pitch / DEG).toFixed(0) + '°');
  check('tip head down → view down', look(face(0, -12), 30, s).look.pitch < -10 * DEG);
  check('nod barely moves view yaw', Math.abs(u.look.yaw) < 2 * DEG);
  check('sitting further back reads the same turn', near(look(face(15, 0, { scale: 0.6 }), 30, s).look.yaw, r.look.yaw, 1 * DEG));
  check('sliding sideways in the chair is not a look', look(face(0, 0, { cx: 0.35 }), 30, s).look.yaw === 0);
  check('a 1.5° fidget stays in the deadzone', look(i => face(1.5 * Math.sin(i / 3)), 60, s).look.yaw === 0);
  check('big turns cap at the max look angle', look(face(60), 30, s).look.yaw <= CONFIG.LOOK_MAX_YAW + 1e-9);
  const h = look(face(20), 30, s);
  for (let i = 0; i < 60; i++) { X.headUpdate(h, null, 1 + i / 30, s); X.headFollow(h, 1 / 30, s); }
  check('face lost → view eases back to forward', Math.abs(h.look.yaw) < 3 * DEG, (h.look.yaw / DEG).toFixed(1) + '°');
  check('head look off → always forward', look(face(20), 30, { ...s, headLook: false }).look.yaw === 0);
  const sc = settings();
  check('calibrate takes the current head pose as forward', X.calibrateHead(sc, face(8, -5)) && look(face(8, -5), 30, sc).look.yaw === 0);
  check('calibrating with no face fails', !X.calibrateHead(settings(), null));
  // Face readings arrive ~10x/s, frames at 60: the view must glide between readings, accelerating
  // and decelerating, never jumping when a reading lands.
  {
    const sg = settings({ headNeutral: X.measureFace(face()) });
    const hh = X.createHead();
    const seq = [];
    for (let i = 0; i < 120; i++) {
      const tt = i / 60;
      if (i % 6 === 0) X.headUpdate(hh, face(i < 12 ? 0 : 15), tt, sg);
      X.headFollow(hh, 1 / 60, sg);
      seq.push(hh.look.yaw);
    }
    const steps = seq.slice(1).map((v, i) => v - seq[i]);
    const start = steps.findIndex(d => Math.abs(d) > 1e-6);
    const moving = steps.slice(start, start + 48).filter(d => Math.abs(d) > 1e-6).length;
    const jerk = Math.max(...steps.slice(1).map((d, i) => Math.abs(d - steps[i])));
    check('view moves every frame between 10 Hz face readings (no stop-start)', start > 0 && moving === 48, moving + '/48 frames moving');
    check('…with no sudden kicks (speed changes smoothly)', jerk < 0.01, 'max frame-to-frame speed change ' + (jerk / DEG).toFixed(2) + '°');
    check('…and settles on the target without overshooting', Math.abs(seq[119] - hh.target.yaw) < 0.03 * Math.abs(hh.target.yaw) && Math.max(...seq) <= hh.target.yaw * 1.001,
      (seq[119] / DEG).toFixed(1) + '° vs ' + (hh.target.yaw / DEG).toFixed(1) + '°');
  }
}

console.log('gesture recorder');
{
  const { analyze, report } = require('../tools/analyze-recording.js');
  const s = settings({ scheme: 'stick' });
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.6, ...o, roll: GRIP + (o.roll || 0) });
  X.calibrateNeutral(s, [fist({})]);
  // What a player does for each asked-for motion (during 'ready' they return to centre).
  const POSE = {
    neutral: () => fist({}),
    pull: () => fist({ lean: 25, size: 0.82, cy: 0.56 }),
    push: () => fist({ lean: -25, size: 1.22, cy: 0.65 }),
    'roll-left': () => fist({ roll: -20, cx: 0.44 }),
    'roll-right': () => fist({ roll: 20, cx: 0.56 }),
    'half-pull': () => fist({ lean: 12, size: 0.91, cy: 0.58 }),
    'pull-right': () => fist({ lean: 22, size: 0.84, cy: 0.57, roll: 18, cx: 0.55 }),
    circle: i => fist({ roll: 15 * Math.cos(i / 8), lean: 15 * Math.sin(i / 8) }),
  };
  const rec = X.createRecorder(10);
  const c = X.createControls();
  let i = 0;
  while (!rec.done && i < 30 * 120) {
    const tt = 10 + i / 30;
    X.recorderStep(rec, tt);
    if (rec.done) break;
    const id = X.RECORD_STEPS[rec.i].id;
    // The fist drops out for a few frames when pushed (as the user reported).
    const lost = id === 'push' && rec.phase === 'hold' && i % 10 < 3;
    const hands = lost ? [] : [rec.phase === 'hold' ? POSE[id](i) : POSE.neutral()];
    X.controlsUpdate(c, hands, tt, s);
    X.recorderAdd(rec, tt, hands, s, c);
    i++;
  }
  check('recorder walks every step and finishes', rec.done, 'stopped on step ' + rec.i);
  const total = X.RECORD_STEPS.reduce((a, st) => a + 2.5 + (st.hold || 3), 0);
  check('recording takes about ' + total.toFixed(0) + ' s', Math.abs(i / 30 - total) < 0.2, (i / 30).toFixed(1) + ' s');
  const data = JSON.parse(JSON.stringify(X.recorderResult(rec, s, { date: 'test' })));
  check('every frame is labelled with its step and phase', data.frames.every(f => f.step && (f.phase === 'ready' || f.phase === 'hold')));
  const a = analyze(data);
  const row = id => a.rows.find(r => r.id === id);
  check('analysis: pull = fist got smaller (depth < 0)', row('pull').mean.depth < -0.15, row('pull').mean.depth.toFixed(3));
  check('analysis: push = fist got bigger (depth > 0)', row('push').mean.depth > 0.15, row('push').mean.depth.toFixed(3));
  check('analysis: roll right = knuckles turned clockwise ~20°', Math.abs(row('roll-right').mean.knuckles - 20) < 2, row('roll-right').mean.knuckles.toFixed(1));
  check('analysis: roll left = anticlockwise', row('roll-left').mean.knuckles < -15);
  check('analysis: half pull reads about half of a full pull', Math.abs(row('half-pull').mean.depth / row('pull').mean.depth - 0.5) < 0.1);
  check('analysis: push dropouts are counted', row('push').tracked < 0.8 && row('push').lostHold >= 3, Math.round(row('push').tracked * 100) + '%, ' + row('push').lostHold);
  const text = report(data, a);
  if (process.env.SHOW_REPORT) console.log(text);
  // The line after each axis heading lists its signals, best first.
  const topSignal = axis => {
    const lines = text.split('\n');
    const at = lines.findIndex(l => l.startsWith(axis));
    return at >= 0 ? lines[at + 1].trim().split(' ')[0] : '';
  };
  check('report ranks depth or height as the top pitch signal', ['depth', 'dy'].includes(topSignal('PITCH')), topSignal('PITCH'));
  check('report ranks knuckles or slide as the top roll signal', ['knuckles', 'dx'].includes(topSignal('ROLL')), topSignal('ROLL'));
  check('game read the pull as nose up during the hold', row('pull').game.pitch > 0.5, row('pull').game.pitch.toFixed(2));
  const fresh = X.neutralFromRecording(rec), cal = s.neutral.stick;
  check('recording\'s centred step becomes the calibration', fresh && Math.abs(fresh.cx - cal.cx) < 1e-3 && Math.abs(fresh.scale - cal.scale) < 1e-3
    && Math.abs(fresh.roll - cal.roll) < 0.01);
}

console.log('flight');
// Full pull from level until the top of the loop (inverted, heading back) or all the way round.
function loopUntil(assist, until) {
  const p = X.createPlane(X.v3(0, 3000, 0));
  let topped = false, t = 0;
  for (; t < 20; t += 1 / 60) {
    X.flightStep(p, { roll: 0, pitch: 1, yaw: 0, throttle: 0.5 }, 1 / 60, assist);
    if (p.up.y < -0.97 && p.fwd.z > 0.97) { topped = true; if (until === 'top') break; }
    if (topped && p.fwd.y >= 0 && p.fwd.z < 0) break;
  }
  p.t = t;
  return p;
}
function fly(ctrl, secs, assist, plane) {
  const p = plane || X.createPlane(X.v3(0, 3000, 0));
  for (let i = 0; i < secs * 60; i++) X.flightStep(p, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, ...ctrl }, 1 / 60, assist);
  return p;
}
{
  const p = fly({}, 10, true);
  check('neutral stick flies straight and level', Math.abs(p.pos.x) < 1 && Math.abs(p.pos.y - 3000) < 5 && p.pos.z < -1000);
  const b = fly({ roll: 0.4 }, 3, true);
  check('assist: 40% stick holds 40% of max bank', near(X.bankAngle(b), 0.4 * CONFIG.MAX_BANK, 2 * DEG), (X.bankAngle(b) / DEG).toFixed(1) + '°');
  check('assist: banked right turns right', b.fwd.x > 0.3, b.fwd.x.toFixed(2));
  const lv = fly({}, 3, true, fly({ roll: 0.6 }, 2, true));
  check('assist: centring the hand rolls wings level', Math.abs(X.bankAngle(lv)) < 1 * DEG);
  const heading = q => Math.atan2(q.fwd.x, -q.fwd.z);
  const bankOnly = fly({ roll: 0.8 }, 2, true), bankPull = fly({ roll: 0.8, pitch: 0.6 }, 2, true);
  check('assist: bank + pull turns harder than bank alone', heading(bankPull) > heading(bankOnly) + 0.5,
    (heading(bankOnly) / DEG).toFixed(0) + '° vs ' + (heading(bankPull) / DEG).toFixed(0) + '°');
  // Pulling must move the nose toward the canopy, never sideways across the screen.
  const q0 = fly({ roll: 0.8 }, 3, true), up0 = { ...q0.up }, fwd0 = { ...q0.fwd };
  X.flightStep(q0, { roll: 0.8, pitch: 1, yaw: 0, throttle: 0.5 }, 1 / 30, true);
  const dNose = X.v3(q0.fwd.x - fwd0.x, q0.fwd.y - fwd0.y, q0.fwd.z - fwd0.z);
  const towardCanopy = X.vDot(dNose, up0) / X.vLen(dNose);
  check('assist: banked pull moves the nose toward the canopy', towardCanopy > 0.9, towardCanopy.toFixed(2));
  const up = fly({ pitch: 1 }, 1, true);
  check('pitch up climbs', up.fwd.y > 0.5 && up.pos.y > 3000);
  // Over the top: hold full pull from level flight in assist.
  {
    const q = X.createPlane(X.v3(0, 3000, 0));
    let inverted = false, minUp = 1;
    for (let i = 0; i < 60 * 7; i++) {
      X.flightStep(q, { roll: 0, pitch: 1, yaw: 0, throttle: 0.5 }, 1 / 60, true);
      minUp = Math.min(minUp, q.up.y);
      if (q.up.y < -0.95 && q.fwd.z > 0.9) inverted = true;
    }
    check('assist: holding full pull goes over the top, upside down', inverted, 'min up.y ' + minUp.toFixed(2));
    const loop = loopUntil(true, 'round');
    check('assist: …and on round a full loop, heading unchanged', loop.fwd.z < -0.97 && Math.abs(loop.fwd.x) < 0.05 && loop.up.y > 0.97,
      'fwd ' + loop.fwd.x.toFixed(2) + ',' + loop.fwd.y.toFixed(2) + ',' + loop.fwd.z.toFixed(2) + ' after ' + loop.t.toFixed(1) + ' s');
    // Pull to inverted at the top, then let go: assist should roll back upright.
    const top = loopUntil(true, 'top');
    const before = top.up.y;
    fly({}, 2, true, top);
    check('assist: let go upside down → rolls back upright', before < -0.9 && top.up.y > 0.95, before.toFixed(2) + ' → ' + top.up.y.toFixed(2));
  }
  const ex = fly({ roll: 1 }, 0.3, false);
  check('expert: roll right drops the right wing', ex.right.y < -0.5);
  const loop = loopUntil(false, 'round');
  check('expert: full pull loops back to level', Math.abs(loop.fwd.y) < 0.05 && loop.fwd.z < -0.99 && loop.t < 10, loop.t.toFixed(1) + ' s');
  // The stick's default is RATE: holding it over keeps rolling (an aileron roll), it doesn't
  // stop at a bank angle the way assist does.
  {
    const sd = settings();
    check('stick defaults to rate control', sd.scheme === 'stick' && !X.assistOn(sd));
    const q = X.createPlane(X.v3(0, 3000, 0));
    let total = 0, prev = X.bankAngle(q);
    for (let i = 0; i < 60 * 4; i++) {
      X.flightStep(q, { roll: 0.4, pitch: 0, yaw: 0, throttle: 0.5 }, 1 / 60, X.assistOn(sd));
      const b = X.bankAngle(q);
      total += Math.atan2(Math.sin(b - prev), Math.cos(b - prev));
      prev = b;
    }
    check('holding the stick 40% right: a continuous aileron roll (past inverted and still going after 4 s)', total > 1.5 * Math.PI, (total / DEG).toFixed(0) + '°');
    const a = fly({ roll: 0.4 }, 4, true);
    check('…whereas assist would hold a 30° bank', Math.abs(X.bankAngle(a) / DEG - 30) < 2);
  }
  // Wingtip vapour: hard pulls and tight turns, not rolls or straight flight.
  {
    const vap = (ctrl, assist, secs = 1) => {
      const q = fly(ctrl, 1, assist);
      const before = { ...q.fwd };
      X.flightStep(q, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, ...ctrl }, 1 / 60, assist);
      return X.vaporAmount(before, q.fwd, 1 / 60);
    };
    check('no vapour in straight flight', vap({}, false) === 0);
    check('no vapour in a pure aileron roll', vap({ roll: 1 }, false) === 0);
    check('full vapour on a full pull', vap({ pitch: 1 }, false) > 0.95);
    check('some vapour in a hard banked assist turn', vap({ roll: 1 }, true) > 0.4, vap({ roll: 1 }, true).toFixed(2));
    check('a gentle pull stays clean', vap({ pitch: 0.25 }, false) === 0);
  }
  const tp = fly({ throttle: 1 }, 10, true);
  check('full throttle speeds up', tp.speed > 230, tp.speed.toFixed(0));
  let r = 1;
  const pr = X.createPlane(X.v3(0, 3500, 0));
  for (let i = 0; i < 3600; i++) {
    r = (r * 16807) % 2147483647;
    X.flightStep(pr, { roll: Math.sin(i / 37), pitch: Math.cos(i / 53) * 0.5, yaw: Math.sin(i / 11), throttle: 0.5 }, 1 / 60, i % 600 < 300);
  }
  const ortho = Math.abs(X.vLen(pr.fwd) - 1) + Math.abs(X.vDot(pr.fwd, pr.up)) + Math.abs(X.vDot(pr.up, pr.right));
  check('basis stays orthonormal after a minute of random flying', ortho < 1e-9, ortho.toExponential(2));
  const dive = X.createPlane(X.v3(0, 300, 0));
  for (let i = 0; i < 600 && !dive.crashed; i++) X.flightStep(dive, { roll: 0, pitch: -1, yaw: 0, throttle: 1 }, 1 / 60, true);
  check('diving into the ground crashes', dive.crashed);
}

console.log('energy, slip, G');
{
  const peak = X.pitchEnvelope(CONFIG.CORNER_SPEED);
  check('pull rate peaks at corner speed', peak === 1 && X.pitchEnvelope(100) < 0.7 && X.pitchEnvelope(300) < 0.6,
    X.pitchEnvelope(100).toFixed(2) + ' / 1 / ' + X.pitchEnvelope(300).toFixed(2));
  // Sustained full pull from cruise: G near 8-9, speed bleeds, the flight path slips outside the nose.
  const q = X.createPlane(X.v3(0, 3000, 0));
  let maxG = 0, maxSlip = 0;
  for (let i = 0; i < 60 * 0.6; i++) { X.flightStep(q, { roll: 0, pitch: 1, yaw: 0, throttle: 0.5 }, 1 / 60, false); maxG = Math.max(maxG, q.g); maxSlip = Math.max(maxSlip, q.slip); }
  check('a full pull at cruise reads ~8-9 G', maxG > 7.5 && maxG < 10, maxG.toFixed(1) + ' G');
  check('…and slips a few degrees (flight path outside the nose)', maxSlip > 4 * DEG && maxSlip < 12 * DEG, (maxSlip / DEG).toFixed(1) + '°');
  check('level flight reads 1 G with no slip', Math.abs(fly({}, 2).g - 1) < 0.01 && fly({}, 2).slip < 1e-6);
  // A level turn at half throttle bleeds speed; letting go recovers it.
  const t = X.createPlane(X.v3(0, 3000, 0));
  for (let i = 0; i < 60 * 8; i++) {
    const roll = Math.max(-1, Math.min(1, (75 * DEG - X.bankAngle(t)) * 2));
    X.flightStep(t, { roll, pitch: 0.8, yaw: 0, throttle: 0.5 }, 1 / 60, false);
  }
  check('a long hard turn at half throttle bleeds speed', t.speed < 150, t.speed.toFixed(0) + ' m/s');
  const zoom = X.createPlane(X.v3(0, 1500, 0));
  zoom.fwd = X.v3(0, 1, 0); zoom.up = X.v3(0, 0, 1); zoom.right = X.v3(1, 0, 0); zoom.path = X.v3(0, 1, 0);
  zoom.right = X.vCross(zoom.fwd, zoom.up);
  for (let i = 0; i < 60 * 12; i++) X.flightStep(zoom, { roll: 0, pitch: 0, yaw: 0, throttle: 0.2 }, 1 / 60, false);
  check('straight up at low throttle runs out of speed and the nose falls (stall)', zoom.fwd.y < 0.9 && zoom.pos.y > 1500, 'nose ' + zoom.fwd.y.toFixed(2) + ', ' + zoom.speed.toFixed(0) + ' m/s');
  const dive = X.createPlane(X.v3(0, 3500, 0));
  dive.fwd = X.v3(0, -0.7071, -0.7071); dive.up = X.v3(0, 0.7071, -0.7071); dive.path = { ...dive.fwd };
  for (let i = 0; i < 60 * 4; i++) X.flightStep(dive, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 }, 1 / 60, false);
  check('diving gains speed past the throttle setting', dive.speed > 230, dive.speed.toFixed(0) + ' m/s');
  // G strain is looks only: it builds under sustained G and never cuts the pull.
  const s9 = X.createPlane(X.v3(0, 3000, 0));
  let worstRate = Infinity;
  for (let i = 0; i < 60 * 12; i++) {
    const before = { ...s9.fwd };
    X.flightStep(s9, { roll: 0, pitch: 1, yaw: 0, throttle: 1 }, 1 / 60, false);
    if (i > 60) worstRate = Math.min(worstRate, Math.acos(Math.min(1, X.vDot(before, s9.fwd))) * 60);
  }
  check('sustained full pull builds G strain (tunnel vision)', s9.strain > 0.5, s9.strain.toFixed(2));
  check('…but never takes the stick away (the nose keeps coming round)', worstRate > 0.6, worstRate.toFixed(2) + ' rad/s worst');
  for (let i = 0; i < 60 * 4; i++) X.flightStep(s9, { roll: 0, pitch: 0, yaw: 0, throttle: 1 }, 1 / 60, false);
  check('…and it clears once you ease off', s9.strain < 0.1, s9.strain.toFixed(2));
}

console.log('dogfight');
{
  const ctrl0 = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false, assist: false };
  const g = X.createGame(3, 'dogfight');
  check('dogfight mode has no drones or rings', g.drones.length === 0 && !g.ring);
  for (let i = 0; i < 120; i++) X.gameUpdate(g, ctrl0, 1 / 60);
  check('a bandit arrives ahead of you', g.bandits.length === 1 && g.wave === 1 && X.vDot(X.vSub(g.bandits[0].pos, g.plane.pos), g.plane.fwd) > 0);
  check('waves go rookie → regular → ace', X.SKILLS[g.bandits[0].skill].name === 'ROOKIE');
  // Park the bandit dead ahead and shoot it.
  const b = g.bandits[0];
  b.plane.pos = X.v3(g.plane.pos.x, g.plane.pos.y, g.plane.pos.z - 250);
  b.plane.fwd = X.v3(0, 0, -1); b.plane.up = X.v3(0, 1, 0); b.plane.right = X.v3(1, 0, 0); b.plane.path = X.v3(0, 0, -1);
  b.plane.speed = g.plane.speed;
  let hits = 0;
  for (let i = 0; i < 40; i++) { X.gameUpdate(g, { ...ctrl0, gun: true }, 1 / 60); hits += g.events.filter(e => e.type === 'hit').length; }
  check('your rounds hit a bandit', hits > 0, hits + ' hits');
  // Its rounds hurt you; enough of them shoot you down.
  const g2 = X.createGame(4, 'dogfight');
  const hp0 = g2.hp;
  for (let i = 0; i < 25; i++) g2.bullets.push({ pos: X.v3(g2.plane.pos.x, g2.plane.pos.y, g2.plane.pos.z - 8), vel: X.v3(0, 0, 900), age: 0, owner: 99 });
  X.gameUpdate(g2, ctrl0, 1 / 60);
  check('bandit rounds hurt you', g2.hp < hp0, hp0 + ' → ' + g2.hp);
  check('…and 20 of them shoot you down', g2.plane.crashed && g2.plane.shotDown);
  X.gameUpdate(g2, ctrl0, 1 / 60);
  check('…which counts as shot down, not a crash', g2.deaths === 1 && g2.crashes === 0);
  for (let i = 0; i < 60 * CONFIG.RESPAWN_TIME + 2; i++) X.gameUpdate(g2, ctrl0, 1 / 60);
  check('respawn with full HP', !g2.plane.crashed && g2.hp === CONFIG.PLAYER_HP);
  // Missile warning shows distance; your own rounds never hurt you.
  const g3 = X.createGame(5, 'dogfight');
  g3.waveT = 999;
  g3.missiles.push({ pos: X.v3(g3.plane.pos.x, g3.plane.pos.y, g3.plane.pos.z + 2000), dir: X.v3(0, 0, -1), speed: 400, target: g3.player, age: 0, owner: 99, turn: CONFIG.ENEMY_MISSILE_TURN });
  X.gameUpdate(g3, ctrl0, 1 / 60);
  check('an enemy missile raises MISSILE with its distance', g3.warn.missile && Math.abs(g3.warn.missile.dist - 2000) < 20);
  const g4 = X.createGame(6, 'dogfight');
  g4.waveT = 999;
  for (let i = 0; i < 60; i++) X.gameUpdate(g4, { ...ctrl0, gun: true }, 1 / 60);
  check('your own rounds never hurt you', g4.hp === CONFIG.PLAYER_HP);
  check('range mode still has drones and rings', X.createGame(7).drones.length > 0 && !!X.createGame(7).ring);
}

console.log('duel (two laptops, in one process)');
{
  // Two games wired back to back: what one sends, the other receives LAT seconds later.
  const LAT = 0.02, DT = 1 / 60;
  const A = { g: X.createGame(1, 'duel'), d: X.createDuel('Ann') }, B = { g: X.createGame(2, 'duel'), d: X.createDuel('Bob') };
  const wire = [];
  let now = 0;
  const deliver = (to, m) => wire.push({ at: now + LAT, to, m });
  const players = [{ id: 1, name: 'Ann', score: 0, ready: true }, { id: 2, name: 'Bob', score: 0, ready: true }];
  X.duelReceive(A.d, A.g, { t: 'welcome', id: 1, lan: [], target: 5 }, 0);
  X.duelReceive(B.d, B.g, { t: 'welcome', id: 2, lan: [], target: 5 }, 0);
  for (const P of [A, B]) X.duelReceive(P.d, P.g, { t: 'room', phase: 'fight', round: 1, players }, 0);
  // Nose to nose 7 km apart over the sea-level-ish spot, then a 0.5 s countdown.
  const spawns = { 1: { x: 0, z: 3500, hx: 0, hz: -1, alt: 3000 }, 2: { x: 0, z: -3500, hx: 0, hz: 1, alt: 3000 } };
  for (const P of [A, B]) X.duelReceive(P.d, P.g, { t: 'go', round: 1, spawns, countdown: 0.5 }, 0);
  check('both planes spawn 7 km apart, nose to nose', Math.abs(X.vDist(A.g.plane.pos, B.g.plane.pos) - 7000) < 600 && X.vDot(A.g.plane.fwd, B.g.plane.fwd) < -0.99);
  const ctrl0 = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false, assist: false };
  const step = (ctrlA, ctrlB) => {
    now += DT;
    for (const [P, c] of [[A, ctrlA], [B, ctrlB]]) {
      if (P.d.countdown > 0) P.d.countdown -= DT;
      if (X.duelFlying(P.d)) X.gameUpdate(P.g, c, DT); else P.g.events.length = 0;
      for (const e of P.g.events) if (e.type === 'duel-hit') deliver(P === A ? B : A, { t: 'hit', dmg: e.dmg });
      deliver(P === A ? B : A, X.duelSnapshot(P.g, c.gun));
    }
    for (const w of wire.filter(w => w.at <= now)) X.duelReceive(w.to.d, w.to.g, w.m, now);
    wire.splice(0, wire.length, ...wire.filter(w => w.at > now));
    for (const P of [A, B]) X.duelRemoteStep(P.d, P.g, now, DT);
  };
  const startA = { ...A.g.plane.pos };
  for (let i = 0; i < 20; i++) step(ctrl0, ctrl0);
  check('nobody moves during the countdown', X.vDist(A.g.plane.pos, startA) < 1e-6);
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    step({ ...ctrl0, roll: 0.3 }, ctrl0);
    if (i > 20) worst = Math.max(worst, X.vDist(B.g.remote.pos, A.g.plane.pos));
  }
  // Drawn ~0.1 s in the past at ~175 m/s ≈ 17 m behind, plus latency.
  check("each laptop draws the other's plane close behind where it really is", worst < 30, worst.toFixed(1) + ' m');
  check('…and can lock it like a bandit', B.g.remote && B.g.remote.alive && B.g.remote.name === 'Ann');
  // Park Bob 300 m in front of Ann and let Ann shoot: Ann's laptop scores the hits, Bob's loses HP.
  const pa = A.g.plane;
  const pb = B.g.plane;
  pb.pos = X.vAdd(pa.pos, X.vScale(pa.fwd, 300)); pb.fwd = { ...pa.fwd }; pb.up = { ...pa.up }; pb.right = { ...pa.right }; pb.path = { ...pa.path }; pb.speed = pa.speed;
  for (let i = 0; i < 12; i++) step(ctrl0, ctrl0);   // let Ann's laptop see where Bob is now
  const hp0 = B.g.hp;
  let downs = 0;
  for (let i = 0; i < 180 && !pb.crashed; i++) {
    step({ ...ctrl0, gun: true }, ctrl0);
    downs += B.g.events.filter(e => e.type === 'shot-down').length;
  }
  check("Ann's rounds hurt Bob, scored on Ann's laptop", B.g.hp < hp0, hp0 + ' → ' + B.g.hp);
  for (let i = 0; i < 60 * 4; i++) { step(ctrl0, ctrl0); downs += B.g.events.filter(e => e.type === 'shot-down').length; }
  check('…until Bob is shot down (and his laptop says so once)', pb.crashed && pb.shotDown && downs === 1, downs + ' shot-down events');
  check('no respawn in a duel: the server starts the next round', B.g.plane.crashed);
  check("…and Ann sees Bob's plane as down", !A.g.remote.alive);
  // Missiles: Ann's missile shows up on Bob's laptop and raises his warning.
  const C = { g: X.createGame(3, 'duel'), d: X.createDuel('Cy') };
  X.duelReceive(C.d, C.g, { t: 'welcome', id: 2, lan: [], target: 5 }, 0);
  X.duelReceive(C.d, C.g, { t: 'room', phase: 'fight', round: 1, players }, 0);
  X.duelReceive(C.d, C.g, { t: 'go', round: 1, spawns, countdown: 0 }, 0);
  const cp = C.g.plane;
  const mpos = X.vAdd(cp.pos, X.vScale(cp.fwd, -1200));
  X.duelReceive(C.d, C.g, { t: 's', p: [cp.pos.x, cp.pos.y, cp.pos.z + 5000], f: [0, 0, 1], u: [0, 1, 0], v: 175, th: 0.5, hp: 100, dead: false, gun: false,
    m: [[7, mpos.x, mpos.y, mpos.z, ...[cp.fwd.x, cp.fwd.y, cp.fwd.z], 500, 1]] }, 10);
  X.duelRemoteStep(C.d, C.g, 10.12, 1 / 60);
  X.gameUpdate(C.g, ctrl0, 1 / 60);
  check("the other laptop's missile raises MISSILE with its distance", C.g.warn.missile && Math.abs(C.g.warn.missile.dist - 1200) < 120, C.g.warn.missile && Math.round(C.g.warn.missile.dist) + ' m');
  check("…and it never hits you here (their laptop decides)", C.g.hp === 100);
}

console.log('WW2 duel');
{
  // Spitfire (Ann) vs 109 (Bob), wired back to back with no latency.
  const DT = 1 / 60;
  const A = { g: X.createGame(1, 'duel', 'spitfire'), d: X.createDuel('Ann') }, B = { g: X.createGame(2, 'duel', 'bf109'), d: X.createDuel('Bob') };
  const players = [{ id: 1, name: 'Ann', score: 0, ready: true }, { id: 2, name: 'Bob', score: 0, ready: true }];
  X.duelReceive(A.d, A.g, { t: 'welcome', id: 1, lan: [], target: 5 }, 0);
  X.duelReceive(B.d, B.g, { t: 'welcome', id: 2, lan: [], target: 5 }, 0);
  for (const P of [A, B]) X.duelReceive(P.d, P.g, { t: 'room', phase: 'fight', round: 1, players }, 0);
  // Bob 200 m behind Ann, both heading the same way: Bob has the shot.
  const spawns = { 1: { x: 0, z: -200, hx: 0, hz: -1, alt: 3000 }, 2: { x: 0, z: 0, hx: 0, hz: -1, alt: 3000 } };
  for (const P of [A, B]) X.duelReceive(P.d, P.g, { t: 'go', round: 1, spawns, countdown: 0 }, 0);
  check('each laptop keeps its own plane through the round start', A.g.plane.type === 'spitfire' && B.g.plane.type === 'bf109');
  let now = 0, dmg = 0, big = 0, remoteCannon = 0;
  const c0 = { roll: 0, pitch: 0, yaw: 0, throttle: 0.7, gun: false, cannon: false, missile: false };
  for (let i = 0; i < 40; i++) {
    now += DT;
    const cb = { ...c0, cannon: i < 30 };
    X.gameUpdate(A.g, c0, DT); X.gameUpdate(B.g, cb, DT);
    for (const e of B.g.events) if (e.type === 'duel-hit') { dmg += e.dmg; if (e.dmg === 20) big++; X.duelReceive(A.d, A.g, { t: 'hit', dmg: e.dmg }, now); }
    X.duelReceive(A.d, A.g, X.duelSnapshot(B.g, cb.gun, cb.cannon), now);
    X.duelReceive(B.d, B.g, X.duelSnapshot(A.g, false, false), now);
    X.duelRemoteStep(A.d, A.g, now, DT); X.duelRemoteStep(B.d, B.g, now, DT);
    remoteCannon += A.g.bullets.filter(b => b.owner === 'remote' && b.group === 'cannon' && b.age < DT * 1.5).length;
  }
  check('Ann sees Bob as a 109, firing its cannon tracers', A.g.remote && A.g.remote.plane.type === 'bf109' && remoteCannon > 0, remoteCannon + ' cannon rounds');
  check("Bob's hits land on Ann's laptop: a cannon hit is 20 HP (five kill), a machine-gun round 1.25", big > 0 && Math.abs(100 - A.g.hp - Math.min(100, dmg)) < 1e-6, big + ' cannon hits, ' + dmg + ' HP');
}

console.log('escort (client side)');
{
  const DT = 1 / 60;
  const g = X.createGame(61, 'escort', 'jet');
  g.bombersRemote = true;
  const d = X.createDuel('Ann', 'escort');
  const rx = m => X.escortReceive(d, g, m, 0);
  rx({ t: 'welcome', id: 1, lan: [], mode: 'escort' });
  rx({ t: 'room', mode: 'escort', phase: 'fight', round: 1, players: [{ id: 1, name: 'Ann', team: 'escort' }, { id: 2, name: 'Bob', team: 'attacker' }, { id: 3, name: 'Cat', team: 'escort' }] });
  const y = X.groundHeight(0, 0) + 6000;
  rx({ t: 'go', round: 1, countdown: 0, spawns: { 1: { x: 400, y: y + 150, z: 0, hx: 0, hz: -1, ty: 'p51', team: 'escort' } } });
  check('the server picks your plane and side: P-51 escort', g.plane.type === 'p51' && g.team === 'escort' && Math.abs(g.plane.pos.y - y - 150) < 1);
  const bomberRow = (id, x, z) => [id, x, y, z, 0, 0, -1, 0, 1, 0, 130, 60, 1, 0, 7];
  const r = rx({ t: 'bombers', b: [bomberRow(10, 0, 0), bomberRow(11, -85, 70)], r: [[0, y, 0, 0, 0, -900]], ev: [] });
  check("the server's bombers appear, and its gunners' rounds", g.bombers.length === 2 && g.bombers[0].alive && g.bullets.some(b => b.owner === 'bomber') && r.ev.length === 0);
  check('bombers and fellow escorts are friends, the 109 a foe', X.escortFriend(g, g.bombers[0]) && X.escortFriend(g, { kind: 'remote', team: 'escort' }) && !X.escortFriend(g, { kind: 'remote', team: 'attacker' }));
  // Snapshots from two laptops become two remote planes.
  rx({ t: 's', from: 2, p: [0, y + 2000, -5000], f: [0, 0, 1], u: [0, 1, 0], v: 150, th: 1, ty: 'bf109', hp: 100, dead: false, gun: false, m: [] });
  rx({ t: 's', from: 3, p: [-400, y + 150, 0], f: [0, 0, -1], u: [0, 1, 0], v: 150, th: 1, ty: 'p51', hp: 100, dead: false, gun: false, m: [] });
  X.duelRemoteStep(d, g, 1, DT);
  check('every other laptop is a plane: the 109 and a fellow P-51', g.remotes.length === 2 && g.remotes.find(R => R.peer === 2).plane.type === 'bf109' && g.remotes.find(R => R.team === 'escort').name === 'Cat');
  // Your rounds into a bomber are sent to the server, not applied here.
  g.bullets = [];
  const b0 = g.bombers[0];
  g.bullets.push({ pos: X.vAdd(b0.pos, X.v3(0, 50, 0)), vel: X.v3(0, -900 * 60, 0), age: 0, owner: 'player', power: 0.4 });
  X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, cannon: false, missile: false }, DT);
  const bh = g.events.find(e => e.type === 'bomber-hit');
  check('your hit on a bomber becomes a bomber-hit for the server (its HP untouched here)', bh && bh.id === 10 && bh.dmg === 0.4 && b0.hp === 60);
  // …and rounds into the fellow escort are friendly fire for its laptop.
  const cat = g.remotes.find(R => R.peer === 3);
  g.bullets.push({ pos: X.vAdd(cat.pos, X.v3(0, 50, 0)), vel: X.v3(0, -900 * 60, 0), age: 0, owner: 'player', power: 1 });
  X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, cannon: false, missile: false }, DT);
  check('friendly fire: hitting a fellow escort sends it a hit', g.events.some(e => e.type === 'duel-hit' && e.to === 3));
  // Bombers fly on between updates; the server's events come back as game events.
  const z0 = b0.pos.z;
  X.escortStep(d, g, 0.5);
  check('bombers carry on between server updates', Math.abs(b0.pos.z - (z0 - 65)) < 0.5);
  const killed = rx({ t: 'bombers', b: [[10, 0, y, 0, 0, -0.5, -0.86, 0, 0.86, -0.5, 140, 0, 0, 15, 0], bomberRow(11, -85, 70)], r: [], ev: [{ type: 'kill', bomber: true, pos: { x: 0, y, z: 0 } }] });
  check("the server's kill arrives as an event; the bomber falls (not a target)", killed.ev[0].type === 'kill' && !g.bombers[0].alive && g.bombers[0].burning.every(Boolean));
  // Shot down: back beside the formation after ESCORT_RESPAWN.
  g.plane.crashed = true;
  rx({ t: 'mission', kills: 1, need: 3, lives: 3, livesMax: 3, left: 200, attacker: 2 });
  for (let t = 0; t < CONFIG.ESCORT_RESPAWN + 0.2; t += DT) { X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 }, DT); X.escortStep(d, g, DT); }
  const near = Math.min(...g.bombers.map(b => X.vDist(b.pos, g.plane.pos)));
  check('shot down: back in by the formation after ' + CONFIG.ESCORT_RESPAWN + ' s, rearmed', !g.plane.crashed && near < 1000 && g.plane.ammo.every((a, i) => a === g.plane.spec.GUNS[i].ammo), Math.round(near) + ' m');
  // The 109 with no lives left stays down.
  g.team = 'attacker';
  g.plane.crashed = true;
  rx({ t: 'mission', kills: 1, need: 3, lives: 0, livesMax: 3, left: 100, attacker: 1 });
  for (let t = 0; t < CONFIG.ESCORT_RESPAWN + 1; t += DT) X.escortStep(d, g, DT);
  check('the 109 out of lives stays down', g.plane.crashed);
  rx({ t: 'mission', kills: 1, need: 3, lives: 2, livesMax: 3, left: 100, attacker: 1 });
  for (let t = 0; t < CONFIG.ESCORT_RESPAWN + 0.2; t += DT) X.escortStep(d, g, DT);
  const above = g.plane.pos.y - g.bombers[1].pos.y, out = Math.hypot(g.plane.pos.x - g.bombers[1].pos.x, g.plane.pos.z - g.bombers[1].pos.z);
  check('…with lives, the 109 comes back high above and well out', !g.plane.crashed && above > 1500 && out > 3500, Math.round(above) + ' m up, ' + Math.round(out) + ' m out');
  const over = rx({ t: 'over', winner: 'escort', why: 'time' });
  check('mission over reaches main.js', d.phase === 'over' && over.ui[0].type === 'escort-over' && over.ui[0].winner === 'escort');
}

console.log('plane specs');
{
  const jet = X.planeSpec('jet');
  check('the jet spec is CONFIG unchanged', ['PITCH_RATE', 'CORNER_SPEED', 'SPEED_MAX', 'TURN_BLEED', 'SLIP_GRIP', 'STALL_SPEED'].every(k => jet[k] === CONFIG[k]));
  check('planes are jets by default, unknown types too', X.createPlane().type === 'jet' && X.createPlane(null, null, 'nope').type === 'jet');
  // A made-up type with half the pull rate: only that plane turns slower.
  X.PLANES.testSlow = { name: 'TEST', PITCH_RATE: CONFIG.PITCH_RATE / 2 };
  const turn = type => {
    const q = X.createPlane(X.v3(0, 3000, 0), null, type);
    q.speed = CONFIG.CORNER_SPEED;
    const f0 = { ...q.fwd };
    for (let i = 0; i < 30; i++) X.flightStep(q, { roll: 0, pitch: 1, yaw: 0, throttle: 0.7 }, 1 / 60, false);
    return Math.acos(Math.max(-1, Math.min(1, X.vDot(f0, q.fwd))));
  };
  const a = turn('jet'), b = turn('testSlow');
  check('a type\'s own numbers change only that plane', Math.abs(b / a - 0.5) < 0.05 && X.planeSpec('jet').PITCH_RATE === CONFIG.PITCH_RATE, (b / a).toFixed(2));
  // Respawn keeps the type; the duel snapshot carries it and the other laptop flies the same spec.
  const g = X.createGame(3);
  g.plane = X.createPlane(g.plane.pos, g.plane.fwd, 'testSlow');
  g.plane.crashed = true;
  for (let i = 0; i < 400 && g.plane.crashed; i++) X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false }, 1 / 60);
  check('respawning keeps your plane type', !g.plane.crashed && g.plane.type === 'testSlow');
  check('the duel snapshot says which plane', X.duelSnapshot(g).ty === 'testSlow');
  delete X.PLANES.testSlow;
}

console.log('bomber');
{
  const idle = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false };
  const g = X.createGame(21);
  const b = X.spawnBomber(g);
  const fwd0 = { ...b.plane.fwd }, y0 = b.pos.y;
  // Its track crosses ~BOMBER_CROSS ahead of where you were.
  const p0 = { ...g.plane.pos }, h = { ...g.plane.fwd };
  let closest = Infinity;
  for (let i = 0; i < 60 * 20; i++) {
    X.gameUpdate(g, idle, 1 / 60);
    const ahead = X.vDot(X.vSub(b.pos, p0), h);
    const side = X.vLen(X.vSub(X.vSub(b.pos, p0), X.vScale(h, ahead)));
    closest = Math.min(closest, Math.abs(ahead - CONFIG.BOMBER_CROSS) + Math.abs(side - Math.abs(b.pos.y - p0.y)));
  }
  check('the bomber flies dead straight and level', X.vDot(fwd0, b.plane.fwd) > 0.9999 && Math.abs(b.pos.y - y0) < 0.5 && b.alive);
  check('…and it is lockable and gets a gun solution', (() => { const g2 = X.createGame(22); const b2 = X.spawnBomber(g2); return g2.bombers.length === 1 && b2.alive && b2.vel && X.vLen(b2.vel) > 100; })());

  // Shooting it: a round at each part point hits; a round 6 m past the wingtip misses.
  const shoot = (bb, gg, at) => {
    const from = X.vAdd(at, X.v3(0, 300, 0));
    gg.bullets.push({ pos: from, vel: X.v3(0, -900 * 60, 0), age: 0, owner: 'player' });
    const hp = bb.hp;
    X.gameUpdate(gg, idle, 1 / 60);
    return bb.hp < hp;
  };
  const g3 = X.createGame(23);
  g3.plane.pos = X.v3(0, 9000, 0);
  const b3 = X.spawnBomber(g3);
  b3.plane.pos = b3.pos = X.v3(0, 8000, -3000);
  const at = part => X.vAdd(X.bomberPartPos(b3, part), X.vScale(b3.vel, 1 / 60));
  const tip = CONFIG.BOMBER_PARTS.find(p => p.zone === 'wing' && p.x > 17);
  check('a round on the wingtip hits', shoot(b3, g3, at(tip)));
  const past = { ...tip, x: tip.x + 6 };
  check('a round 6 m past the wingtip misses', !shoot(b3, g3, at(past)));
  const eng = CONFIG.BOMBER_PARTS.find(p => p.zone === 'engine');
  for (let i = 0; i < CONFIG.BOMBER_ENGINE_HP; i++) shoot(b3, g3, at(eng));
  check('enough rounds into one engine set it on fire', b3.burning[eng.engine] && b3.burning.filter(Boolean).length === 1);
  const hp = b3.hp;
  for (let i = 0; i < 60; i++) X.gameUpdate(g3, idle, 1 / 60);
  check('a burning engine keeps costing it HP', Math.abs(hp - b3.hp - CONFIG.BOMBER_BURN) < 0.1, (hp - b3.hp).toFixed(2));

  // A missile from behind brings BOMBER_MISSILE_DMG; then guns finish it; it falls and crashes.
  const g4 = X.createGame(24);
  const b4 = X.spawnBomber(g4);
  const behind = X.vSub(b4.pos, X.vScale(b4.plane.fwd, 400));
  g4.missiles.push({ id: 900, pos: behind, dir: b4.plane.fwd, speed: 400, target: b4, age: 0, owner: 'player', turn: CONFIG.MISSILE_TURN });
  for (let i = 0; i < 180 && b4.hp === CONFIG.BOMBER_HP; i++) X.gameUpdate(g4, idle, 1 / 60);
  check('a missile hits it for BOMBER_MISSILE_DMG', CONFIG.BOMBER_HP - b4.hp === CONFIG.BOMBER_MISSILE_DMG);
  b4.hp = 0.5;
  shoot(b4, g4, X.vAdd(b4.pos, X.vScale(b4.vel, 1 / 60)));
  check('shot down: not a target any more, but still there, falling', !b4.alive && g4.bombers.includes(b4) && g4.kills === 1 && g4.score >= CONFIG.BOMBER_REWARD);
  let crashed = false;
  for (let i = 0; i < 60 * 120 && !crashed; i++) { X.gameUpdate(g4, idle, 1 / 60); crashed = g4.events.some(e => e.type === 'bomber-crash'); }
  check('…it noses over and hits the ground, then is gone', crashed && !g4.bombers.includes(b4));
}

console.log('bomber gunners');
{
  const idle = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false };
  // Fly formation with a bomber at an offset (in its frame) that may move: offset(t) → {back, up, side}.
  const sit = (offset, secs, setup) => {
    const g = X.createGame(31);
    const b = X.spawnBomber(g);
    if (setup) setup(g, b);
    const P = b.plane, hits = [];
    for (let i = 0; i < secs * 60; i++) {
      const t = i / 60, o = offset(t);
      const p = g.plane;
      p.pos = X.vAdd(b.pos, X.vAdd(X.vScale(P.fwd, -o.back), X.vAdd(X.vScale(P.up, o.up), X.vScale(P.right, o.side || 0))));
      p.fwd = { ...P.fwd }; p.up = { ...P.up }; p.right = { ...P.right }; p.path = { ...P.fwd }; p.speed = CONFIG.BOMBER_SPEED;
      g.hp = 1e9;
      X.gameUpdate(g, idle, 1 / 60);
      for (const e of g.events) if (e.type === 'hurt') hits.push(t);
    }
    return { g, b, hits, fired: g.bullets.filter(x => x.owner === 'bomber').length };
  };
  const six = sit(() => ({ back: 500, up: 30 }), 12);
  const early = six.hits.filter(t => t < 1.5).length, late = six.hits.filter(t => t > 8).length;
  check('sitting on its six: the gunners start loose…', early <= 2, early + ' hits in the first 1.5 s');
  check('…and walk the rounds onto you if you stay', late >= 15, late + ' hits in the last 4 s');
  // Swinging across their view (≈9°/s at 500 m) keeps them loose.
  const weave = sit(t => ({ back: 500, up: 30 + Math.sin(t * 0.6) * 160, side: Math.cos(t * 0.6) * 160 }), 12);
  const wl = weave.hits.filter(t => t > 8).length;
  check('moving across their view keeps them off you', wl < late / 3, wl + ' vs ' + late + ' hits in the last 4 s');
  check('out of gun range they hold fire', sit(() => ({ back: 1200, up: 30 }), 4).fired === 0);
  const silenced = sit(() => ({ back: 500, up: 30 }), 4, (g, b) => b.gunners.forEach(x => { x.hp = 0; }));
  check('gunners that are out don\'t fire', silenced.fired === 0);
  // Shooting a gunner's turret takes him out.
  const g = X.createGame(32);
  const b = X.spawnBomber(g);
  const tail = CONFIG.BOMBER_PARTS.find(p => p.zone === 'gunner' && p.gunner === 2);
  let out = false;
  for (let i = 0; i < CONFIG.GUNNER_HP; i++) {
    const at = X.vAdd(X.bomberPartPos(b, tail), X.vScale(b.vel, 1 / 60));
    g.bullets.push({ pos: X.vAdd(at, X.v3(0, 300, 0)), vel: X.v3(0, -900 * 60, 0), age: 0, owner: 'player' });
    X.gameUpdate(g, idle, 1 / 60);
    out = out || g.events.some(e => e.type === 'gunner-down' && e.name === 'TAIL');
  }
  check('rounds into the tail turret put the tail gunner out', out && b.gunners[2].hp <= 0 && b.gunners[0].hp > 0);
}

console.log('WW2 guns');
{
  const ctl = (o) => ({ roll: 0, pitch: 0, yaw: 0, throttle: 0.6, gun: false, cannon: false, missile: false, ...o });
  const ammoOf = (p, grp) => p.spec.GUNS.reduce((n, gn, i) => n + (gn.group === grp ? p.ammo[i] : 0), 0);
  const g = X.createGame(41, 'range', 'bf109');
  const p = g.plane;
  check('a game in a 109 flies a 109', p.type === 'bf109' && p.spec.ERA === 'ww2');
  const mg0 = ammoOf(p, 'mg'), cn0 = ammoOf(p, 'cannon');
  for (let i = 0; i < 60; i++) X.gameUpdate(g, ctl({ gun: true }), 1 / 60);
  check('pinch: machine guns only', ammoOf(p, 'mg') < mg0 && ammoOf(p, 'cannon') === cn0, (mg0 - ammoOf(p, 'mg')) + ' mg rounds');
  for (let i = 0; i < 60; i++) X.gameUpdate(g, ctl({ cannon: true }), 1 / 60);
  check('fist: cannons join in', ammoOf(p, 'cannon') < cn0);
  for (let i = 0; i < 60 * 10; i++) X.gameUpdate(g, ctl({ cannon: true }), 1 / 60);
  const fired = g.bullets.length;
  check('the cannon drums run dry (~7 s of fire)', ammoOf(p, 'cannon') === 0 && ammoOf(p, 'mg') > 0);
  for (let i = 0; i < 30; i++) X.gameUpdate(g, ctl({ missile: true }), 1 / 60);
  check('no missiles in a WW2 plane, and no lead marker', g.missiles.length === 0 && X.gunSolution(g) === null);
  p.crashed = true;
  for (let i = 0; i < 60 * 3 && g.plane.crashed; i++) X.gameUpdate(g, ctl(), 1 / 60);
  check('respawn rearms', ammoOf(g.plane, 'cannon') === cn0 && ammoOf(g.plane, 'mg') === mg0);

  // Convergence: the Spitfire's eight wing guns spread 6.6 m but cross ~CONVERGENCE ahead; rounds drop.
  const g2 = X.createGame(42, 'range', 'spitfire');
  const q = g2.plane;
  X.fireGuns(g2, q, { mg: true }, 1 / 5, 'player', true);
  const rounds = g2.bullets.slice();
  const lateral = t => { const xs = rounds.map(b => X.vDot(X.vSub(X.vAdd(b.pos, X.vScale(X.vSub(b.vel, X.vScale(q.path, q.speed)), t)), X.vAdd(q.pos, X.vScale(q.fwd, 0))), q.right)); return Math.max(...xs) - Math.min(...xs); };
  const tConv = q.spec.CONVERGENCE / q.spec.GUNS[0].speed;
  check('wing guns: 6.6 m apart at the muzzle, together at the convergence range', rounds.length === 8 && lateral(0) > 6 && lateral(tConv) < 0.5, lateral(0).toFixed(1) + ' m → ' + lateral(tConv).toFixed(2) + ' m');
  const r0 = { ...rounds[0].vel };
  for (let i = 0; i < 30; i++) X.gameUpdate(g2, ctl(), 1 / 60);
  check('WW2 rounds drop under gravity', rounds[0].vel.y < r0.y - 4);

  // A WW2 dogfight: the bandit flies the other side's plane with its own guns, and never pulls
  // its own wings off (the AI keeps under the limit).
  let wings = 0, shots = 0, types = new Set();
  for (const seed of [51, 52, 53]) {
    const d = X.createGame(seed, 'dogfight', 'spitfire');
    for (let i = 0; i < 60 * 60; i++) {
      d.hp = 100;
      X.gameUpdate(d, ctl({ throttle: 0.8 }), 1 / 60);   // straight and level: can it catch you and shoot?
      for (const b of d.bandits) { types.add(b.plane.type); if (b.plane.wingFailed) wings++; }
      shots += d.events.filter(e => e.type === 'enemy-gun').length;
    }
  }
  check('Spitfire dogfight: bandits fly 109s', types.size === 1 && types.has('bf109'), [...types].join());
  check('…they shoot their own guns at you', shots > 50, shots + ' bursts');
  check('…and never pull their own wings off (3 × 60 s)', wings === 0);
}

console.log('gun lead + assist');
{
  // One drone crossing left at 70 m/s, 600 m ahead (a huge circle ≈ a straight line).
  const crossing = (dist, assist, aimFn) => {
    const g = X.createGame(11);
    const p = g.plane;
    const R = 1e5, at = X.vAdd(p.pos, X.vScale(p.fwd, dist));
    const d = { id: 999, kind: 'drone', center: X.v3(at.x, at.y, at.z - R), radius: R, ang: Math.PI / 2, dir: 1, pos: at, vel: X.v3(0, 0, 0), alive: true };
    g.drones = [d];
    g.ring = { pos: X.v3(0, -9999, 0), normal: X.v3(0, 0, -1) };
    let shots = 0;
    for (let i = 0; i < 60 && d.alive; i++) {
      // Hold the nose wherever aimFn says (a perfect pilot), then fire.
      d.vel = X.vScale(X.v3(-1, 0, 0), CONFIG.DRONE_SPEED);
      const sol = X.gunSolution(g);
      if (sol) {
        const f = aimFn(sol, d, p);
        p.fwd = f; p.right = X.vNorm(X.vCross(f, X.v3(0, 1, 0))); p.up = X.vCross(p.right, f); p.path = { ...f };
      }
      X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: i < 20, missile: false, assist: false, gunAssist: assist }, 1 / 60);
      g.drones = g.drones.filter(x => x === d);
      shots++;
    }
    return { killed: !d.alive, sol: X.gunSolution(g) };
  };
  const atLead = (sol) => sol.dir;
  const atTarget = (sol, d, p) => X.vNorm(X.vSub(d.pos, p.pos));
  const nearLead = (sol, d, p) => X.vRotate(sol.dir, X.v3(0, 1, 0), 3.2 * DEG);   // 34 m off at 600 m: clear of the 22 m hit zone
  check('sight on the lead marker hits a crossing target (no assist)', crossing(600, 0, atLead).killed);
  check('sight on the target itself misses it (that is why the marker exists)', !crossing(600, 0, atTarget).killed);
  check('3.2° off the marker: the assist (3.5°) puts the rounds on', crossing(600, 3.5, nearLead).killed);
  check('…and with the assist off, the same aim misses', !crossing(600, 0, nearLead).killed);
  const g = X.createGame(12);
  const p = g.plane;
  const put = dist => { g.drones = [{ id: 1, kind: 'drone', pos: X.vAdd(p.pos, X.vScale(p.fwd, dist)), vel: X.v3(0, 0, 0), alive: true }]; return X.gunSolution(g); };
  check('the marker is green (in range) inside 800 m, dim beyond', put(600).inRange && !put(1000).inRange);
  check('no marker for a target behind you', (() => { g.drones = [{ id: 1, kind: 'drone', pos: X.vAdd(p.pos, X.vScale(p.fwd, -600)), vel: X.v3(0, 0, 0), alive: true }]; return X.gunSolution(g) === null; })());
}

console.log('game');
{
  const g = X.createGame(1);
  const p = g.plane;
  // Park a drone dead ahead, frozen.
  const d = g.drones[0];
  d.center = X.v3(p.pos.x, p.pos.y, p.pos.z - 600);
  d.radius = 0.001;
  let kills = 0;
  for (let i = 0; i < 90; i++) { X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: true, missile: false, assist: true }, 1 / 60); kills = g.kills; }
  check('guns kill a drone dead ahead', kills >= 1);
}
{
  const g = X.createGame(2);
  const p = g.plane;
  const d = g.drones[0];
  d.center = X.v3(p.pos.x + 150, p.pos.y + 60, p.pos.z - 1200);
  d.radius = 120;
  g.drones = [d];
  let fired = false;
  for (let i = 0; i < 600 && g.kills === 0; i++) {
    X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: g.lock.locked && !fired, assist: true }, 1 / 60);
    if (g.missiles.length) fired = true;
    g.drones = g.drones.filter(x => x === d || !d.alive);
  }
  check('missile locks and kills a circling drone off the nose', fired && g.kills === 1, 'fired ' + fired + ', kills ' + g.kills);
}
{
  const g = X.createGame(3);
  const p = g.plane;
  g.ring = { pos: X.v3(p.pos.x, p.pos.y, p.pos.z - 400), normal: X.v3(0, 0, -1) };
  for (let i = 0; i < 180; i++) X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, assist: true }, 1 / 60);
  check('flying through a ring scores it', g.rings === 1);
  g.ring = { pos: X.v3(g.plane.pos.x + 200, g.plane.pos.y, g.plane.pos.z - 400), normal: X.v3(0, 0, -1) };
  for (let i = 0; i < 180; i++) X.gameUpdate(g, { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, assist: true }, 1 / 60);
  check('flying past a ring does not', g.rings === 1);
  check('the next ring is placed ahead', X.vDot({ x: g.ring.pos.x - g.plane.pos.x, y: 0, z: g.ring.pos.z - g.plane.pos.z }, g.plane.fwd) > 0);
}
{
  const g = X.createGame(4);
  g.plane.pos.y = X.groundHeight(g.plane.pos.x, g.plane.pos.z) + 20;
  let crashed = false;
  for (let i = 0; i < 60 * 5; i++) {
    X.gameUpdate(g, { roll: 0, pitch: -1, yaw: 0, throttle: 1, assist: true }, 1 / 60);
    if (g.events.some(e => e.type === 'crash')) crashed = true;
  }
  check('crash is reported once', g.crashes === 1 && crashed, g.crashes + ' crashes');
  // The pitch-down input keeps the respawned plane diving, so drive level after respawn.
  const g2 = X.createGame(4);
  g2.plane.pos.y = X.groundHeight(g2.plane.pos.x, g2.plane.pos.z) + 5;
  for (let i = 0; i < 60 * 3; i++) X.gameUpdate(g2, { roll: 0, pitch: i < 30 ? -1 : 0, yaw: 0, throttle: 0.5, assist: true }, 1 / 60);
  check('respawns level, well above the ground', !g2.plane.crashed && g2.plane.pos.y > X.groundHeight(g2.plane.pos.x, g2.plane.pos.z) + 400);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

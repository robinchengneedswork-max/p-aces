// headless.js — drives hands.js, flight.js and game.js with synthetic hands. No camera needed.
// Run: node test/headless.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Math });
const src = ['config.js', 'math.js', 'flight.js', 'hands.js', 'head.js', 'recorder.js', 'game.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
vm.runInContext(src + '\n;this.__x = { CONFIG, DEG, DEFAULT_NEUTRAL, v3, vDot, vLen, vCross, measureHand, assignHands, createControls, controlsUpdate, calibrateNeutral, createPlane, flightStep, bankAngle, groundHeight, createGame, gameUpdate, assistOn, RECORD_STEPS, createRecorder, recorderStep, recorderAdd, recorderResult, measureFace, createHead, headUpdate, calibrateHead };', ctx);
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
  const pts = handLocal(o).map(p => rot(p, pitch, roll));
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
  check('tilt 40° (past the range) → full roll', drive([hand({ roll: 40 })], 30, s).out.roll === 1);
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
  // Gripping a stick seen from the front: knuckle line near vertical (88°), right where the
  // ±90° fold wraps. Calibrated on the centre grip, as the start-up countdown does.
  const GRIP = 88;
  const fist = o => hand({ fist: true, pitch: 0, cy: 0.6, ...o, roll: GRIP + (o.roll || 0) });
  const s = settings({ scheme: 'stick' });
  X.calibrateNeutral(s, [fist({})]);
  check('fist at centre = no input', (() => { const c = drive([fist({})], 30, s); return c.out.roll === 0 && c.out.pitch === 0; })());
  check('fist slid right → roll right', drive([fist({ cx: 0.62 })], 30, s).out.roll > 0.3);
  const tilt = drive([fist({ roll: 6 })], 30, s);
  check('fist tilted 6° right past vertical → roll right, not a 170° jump', tilt.out.roll > 0 && tilt.out.roll < 0.4, tilt.out.roll.toFixed(2));
  check('fist tilted 25° right (no slide) → strong roll right', drive([fist({ roll: 25 })], 30, s).out.roll > 0.5);
  check('fist tilted left → roll left', drive([fist({ roll: -25 })], 30, s).out.roll < -0.5);
  const pivot = drive([fist({ cx: 0.6, roll: 15 })], 30, s);
  check('pivoting stick (slide + tilt) → full roll, no yaw', pivot.out.roll === 1 && pivot.out.yaw === 0, pivot.out.roll.toFixed(2) + ' / ' + pivot.out.yaw.toFixed(2));
  check('fist moved up (pull back) → nose up', drive([fist({ cy: 0.48 })], 30, s).out.pitch > 0.3);
  check('fist moved down (push) → nose down', drive([fist({ cy: 0.72 })], 30, s).out.pitch < -0.3);
  const push = drive([fist({ size: 1.22 })], 30, s);
  check('fist pushed toward the camera (22% bigger, same height) → nose down', push.out.pitch < -0.4, push.out.pitch.toFixed(2));
  const pull = drive([fist({ size: 0.82 })], 30, s);
  check('fist pulled back (18% smaller) → nose up', pull.out.pitch > 0.4, pull.out.pitch.toFixed(2));
  check('pulling back AND up → full nose up', drive([fist({ size: 0.85, cy: 0.54 })], 30, s).out.pitch === 1);
  check('pull does not leak into roll', drive([fist({ size: 0.82 })], 30, s).out.roll === 0);
  const rud = drive([fist({ roll: 25 })], 30, { ...s, twistRudder: true });
  check('twist rudder on → tilt is yaw, not roll', rud.out.yaw > 0.3 && rud.out.roll === 0);
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
  const s = settings();
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
  for (let i = 0; i < n; i++) X.headUpdate(h, typeof kpFn === 'function' ? kpFn(i) : kpFn, t0 + i / 30, s);
  return h;
}
{
  const auto = look(i => (i < 20 ? face() : face(15)), 50, settings());
  check('uncalibrated: first frames become forward, then turns read', auto.look.yaw > 40 * DEG && Math.abs(auto.look.pitch) < 5 * DEG,
    (auto.look.yaw / DEG).toFixed(0) + '° / ' + (auto.look.pitch / DEG).toFixed(0) + '°');
  const s = settings({ headNeutral: X.measureFace(face()) });
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
  for (let i = 0; i < 60; i++) X.headUpdate(h, null, 1 + i / 30, s);
  check('face lost → view eases back to forward', Math.abs(h.look.yaw) < 3 * DEG, (h.look.yaw / DEG).toFixed(1) + '°');
  check('head look off → always forward', look(face(20), 30, { ...s, headLook: false }).look.yaw === 0);
  const sc = settings();
  check('calibrate takes the current head pose as forward', X.calibrateHead(sc, face(8, -5)) && look(face(8, -5), 30, sc).look.yaw === 0);
  check('calibrating with no face fails', !X.calibrateHead(settings(), null));
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
    pull: () => fist({ size: 0.82, cy: 0.56 }),
    push: () => fist({ size: 1.22, cy: 0.65 }),
    'roll-left': () => fist({ roll: -20, cx: 0.46 }),
    'roll-right': () => fist({ roll: 20, cx: 0.54 }),
    'half-pull': () => fist({ size: 0.91, cy: 0.58 }),
    'pull-right': () => fist({ size: 0.84, cy: 0.57, roll: 18, cx: 0.53 }),
    circle: i => fist({ cx: 0.5 + 0.04 * Math.cos(i / 8), size: 1 + 0.12 * Math.sin(i / 8) }),
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
}

console.log('flight');
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
    const loop = fly({ pitch: 1 }, 2 * Math.PI / CONFIG.PITCH_RATE, true);
    check('assist: …and on round a full loop, heading unchanged', loop.fwd.z < -0.97 && Math.abs(loop.fwd.x) < 0.05 && loop.up.y > 0.97,
      'fwd ' + loop.fwd.x.toFixed(2) + ',' + loop.fwd.y.toFixed(2) + ',' + loop.fwd.z.toFixed(2));
    // Pull to inverted at the top, then let go: assist should roll back upright.
    const top = fly({ pitch: 1 }, Math.PI / CONFIG.PITCH_RATE, true);
    const before = top.up.y;
    fly({}, 2, true, top);
    check('assist: let go upside down → rolls back upright', before < -0.9 && top.up.y > 0.95, before.toFixed(2) + ' → ' + top.up.y.toFixed(2));
  }
  const ex = fly({ roll: 1 }, 0.3, false);
  check('expert: roll right drops the right wing', ex.right.y < -0.5);
  const loop = fly({ pitch: 1 }, 2 * Math.PI / CONFIG.PITCH_RATE, false);
  check('expert: full pull loops back to level', Math.abs(loop.fwd.y) < 0.05 && loop.fwd.z < -0.99);
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

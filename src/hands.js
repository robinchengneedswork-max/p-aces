// hands.js — MediaPipe hands → flight controls. Pure: no DOM.
// A hand is { lm, world }: 21 image landmarks (x mirrored, y down, z relative depth in x units)
// and 21 world landmarks (metres, same axes, centred on the hand).
//
// Flying hand, 'flat' scheme: roll = tilt of the knuckle line on screen; pitch = palm tipping
// toward/away from the camera (from the 3D world landmarks), or hand height if pitchSrc='height'.
// Flying hand, 'stick' scheme: a fist round a stick is a stack of finger rings, and the line
// through the ring centres is the stick's axis (the user's idea). Pitch = that axis leaning
// toward/away from the camera: an angle, so sitting closer doesn't steer. Roll = the fist sliding
// sideways (a stick pinned at its base slides the fist as it leans); on the recordings that leaked
// least into pitch (5-8%), less than the axis's own sideways lean (up to 76%, pushes tilt it).
// Together: rms error 0.31-0.46 on the mid-frame recordings vs 0.80-0.85 for the old
// slide + height + fist-size mapping, which read pulls as pushes and rolls as dives.
// Other hand: height = throttle, pinch thumb+index = gun, close the fist = missile, and turning
// it like a dial (knuckle line clockwise on screen) = right rudder.

function oneEuroAlpha(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function createOneEuro() {
  return { x: null, dx: 0, t: 0 };
}

function oneEuroStep(f, x, t, minCutoff, beta) {
  if (f.x === null) { f.x = x; f.t = t; return x; }
  const dt = Math.max(1e-3, t - f.t);
  f.t = t;
  const dx = (x - f.x) / dt;
  f.dx += oneEuroAlpha(dt, 1.0) * (dx - f.dx);
  f.x += oneEuroAlpha(dt, minCutoff + beta * Math.abs(f.dx)) * (x - f.x);
  return f.x;
}

const RING_FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

// Line through the centres of the four finger rings (each finger's 4 joints averaged), as a unit
// vector oriented pinky → index. Principal axis by power iteration on the 3x3 covariance.
function ringAxis(pts) {
  const rings = RING_FINGERS.map(f => {
    let x = 0, y = 0, z = 0;
    for (const i of f) { x += pts[i].x; y += pts[i].y; z += pts[i].z; }
    return v3(x / 4, y / 4, z / 4);
  });
  let c = v3(0, 0, 0);
  for (const r of rings) c = vAdd(c, vScale(r, 1 / rings.length));
  const q = rings.map(r => vSub(r, c));
  const C = (a, b) => q.reduce((s, p) => s + p[a] * p[b], 0);
  const M = [['x', 'y', 'z'].map(b => C('x', b)), ['x', 'y', 'z'].map(b => C('y', b)), ['x', 'y', 'z'].map(b => C('z', b))];
  const seed = vSub(rings[0], rings[3]);
  let v = vNorm(seed);
  for (let it = 0; it < 20; it++) v = vNorm(v3(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z, M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z, M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z));
  return vDot(v, seed) < 0 ? vScale(v, -1) : v;
}

// How axis d leans relative to the neutral axis d0, radians: side = in the screen plane
// (+ = top toward screen right), fwd = out of it (+ = top away from the camera = pulled back).
function stickLean(d, d0) {
  const w = a => Math.atan2(Math.sin(a), Math.cos(a));
  return {
    side: w(Math.atan2(d.x, -d.y) - Math.atan2(d0.x, -d0.y)),
    fwd: w(Math.atan2(d.z, Math.hypot(d.x, d.y)) - Math.atan2(d0.z, Math.hypot(d0.x, d0.y))),
  };
}

// Raw geometry of one hand. Everything here is independent of which hand it is.
function measureHand(h) {
  const L = h.lm, W = h.world;
  // Knuckle line angle folded to ±90°, so left and right hands read the same:
  // + = rotated clockwise on the (mirrored) screen = bank right.
  let roll = Math.atan2(L[HL.PINKY_MCP].y - L[HL.INDEX_MCP].y, L[HL.PINKY_MCP].x - L[HL.INDEX_MCP].x);
  if (roll > Math.PI / 2) roll -= Math.PI;
  if (roll < -Math.PI / 2) roll += Math.PI;

  // Finger direction in 3D, with the screen roll taken out so tilting doesn't leak into pitch.
  const f = vNorm(vSub(W[HL.MIDDLE_MCP], W[HL.WRIST]));
  const c = Math.cos(-roll), s = Math.sin(-roll);
  const fy = f.x * s + f.y * c;
  // + = fingertips tipping away from the camera = nose up. Upright palm = 0, pointing at screen = -90°.
  const pitch = Math.atan2(f.z, -fy);

  const palm = [HL.WRIST, HL.INDEX_MCP, HL.MIDDLE_MCP, HL.RING_MCP, HL.PINKY_MCP];
  let cx = 0, cy = 0;
  for (const i of palm) { cx += L[i].x; cy += L[i].y; }
  cx /= palm.length;
  cy /= palm.length;
  const scale = vDist(L[HL.WRIST], L[HL.MIDDLE_MCP]);

  const palmLen = vDist(W[HL.WRIST], W[HL.MIDDLE_MCP]) || 1;
  let reach = 0;
  for (const i of [HL.INDEX_TIP, HL.MIDDLE_TIP, HL.RING_TIP, HL.PINKY_TIP]) reach += vDist(W[i], W[HL.WRIST]);
  const open = reach / 4 / palmLen;
  const pinch = vDist(W[HL.THUMB_TIP], W[HL.INDEX_TIP]) / palmLen;
  // Stick axis from the image landmarks (best for roll) and the 3D world ones (bigger push/pull).
  return { roll, pitch, cx, cy, scale, open, pinch, axI: ringAxis(L), axW: ringAxis(W) };
}

// Two hands: split by screen side. One hand: once both roles have been seen, whichever role it
// was last near (memo holds the last palm positions); before that, it flies. A lone hand used to always fly, so when the
// stick fist dropped out the open throttle hand took over and flung the plane around (seen in
// the user's first recording).
function assignHands(hands, s, memo) {
  if (!hands || !hands.length) return { fly: null, thr: null };
  if (hands.length === 2) {
    const [a, b] = hands[0].lm[0].x < hands[1].lm[0].x ? [hands[0], hands[1]] : [hands[1], hands[0]];
    return s.hand === 'right' ? { fly: b, thr: a } : { fly: a, thr: b };
  }
  const h = hands[0], x = h.lm[HL.MIDDLE_MCP].x, y = h.lm[HL.MIDDLE_MCP].y;
  const d = p => (p ? Math.hypot(p.x - x, p.y - y) : Infinity);
  const isFly = !(memo && memo.fly && memo.thr) || d(memo.fly) <= d(memo.thr);
  return isFly ? { fly: h, thr: null } : { fly: null, thr: h };
}

function rememberHands(memo, a) {
  const pos = h => ({ x: h.lm[HL.MIDDLE_MCP].x, y: h.lm[HL.MIDDLE_MCP].y });
  if (a.fly) memo.fly = pos(a.fly);
  if (a.thr) memo.thr = pos(a.thr);
}

function createControls() {
  return {
    f: { roll: createOneEuro(), pitch: createOneEuro(), yaw: createOneEuro() },
    raw: { roll: 0, pitch: 0, yaw: 0 },     // before deadzone/expo, -1..1-ish
    out: { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false },
    flyM: null, thrM: null,                // last measurements, for the debug view
    flySeen: -1,
    assigned: { fly: null, thr: null },
    memo: { fly: null, thr: null },        // last palm positions per role, for assignHands
    still: null,                           // { t, cx, cy } where the flying hand went still
    offCentre: false,                      // hand still for a while but still steering
    edge: false,                           // flying hand near the edge of the camera view
    lastT: 0,
    pinched: false,
    pinchReads: 0,                         // fresh readings the pinch has been held
    fist: false,
    flyLast: null,                         // last accepted flying-hand palm { cx, cy, scale }
    jumps: 0,                              // readings rejected in a row as impossible jumps
    jumped: false,                         // this reading was rejected
    thrHist: [],                           // { t, throttle, yaw } over the last ~0.3 s
    thrFrozenUntil: -1,                    // throttle + rudder held until then (fist settling)
  };
}

// Knuckle-line angles are folded to ±90°, so differences must fold too: a stick grip holds the
// line near vertical, where a small tilt would otherwise jump from +89° to -89°.
function foldHalf(a) {
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

function assistOn(s) {
  return typeof s.assist === 'object' ? !!s.assist[s.scheme] : !!s.assist;
}

function shapeAxis(v, s) {
  const a = Math.abs(v);
  if (a <= s.deadzone) return 0;
  const n = Math.min(1, (a - s.deadzone) / (1 - s.deadzone));
  return Math.sign(v) * Math.pow(n, s.expo);
}

function isCalibrated(s) {
  const n = s.neutral && s.neutral[s.scheme];
  return !!n && (s.scheme !== 'stick' || !!n.axI);   // pre-ring-axis stick calibrations don't count
}

function neutralFor(s) {
  return isCalibrated(s) ? s.neutral[s.scheme] : DEFAULT_NEUTRAL[s.scheme];
}

// fresh: hands is a new camera reading (main calls this every drawn frame, and the tracker only
// updates ~20x/s). Jump rejection and the gun hold count readings, not frames.
// Flying-hand axes before your range calibration: 1 = the slider's "for full" setting.
function flyAxes(m, n, s) {
  const scale = n.scale || m.scale;
  if (s.scheme === 'stick') {
    const li = stickLean(m.axI, n.axI), lw = stickLean(m.axW, n.axW);
    return {
      roll: (m.cx - n.cx) / scale / s.stickThrow,
      // Push/pull: the 3D and image estimates averaged (the most consistent across recordings).
      // The image one swings about half as far, so its full scale is halved.
      pitch: (lw.fwd / (s.stickPitch * DEG) + li.fwd / (s.stickPitch * CONFIG.STICK_IMAGE_PITCH * DEG)) / 2,
    };
  }
  return {
    roll: foldHalf(m.roll - n.roll) / (s.rollRange * DEG),
    pitch: s.pitchSrc === 'height'
      ? -(m.cy - n.cy) / scale / s.stickThrow
      : wrapAngle(m.pitch - n.pitch) / (s.pitchRange * DEG),
  };
}

// Rudder from the other hand turned like a dial, before range calibration.
function thrYaw(m, s) {
  const nt = s.neutral && s.neutral.thr;
  return foldHalf(m.roll - (nt ? nt.roll : 0)) / (s.yawRange * DEG);
}

// r = [reach toward -, reach toward +] (positive numbers, in raw units): divide by your reach.
function applyRange(v, r) {
  if (!r) return v;
  return v / (v < 0 ? r[0] : r[1]);
}

function controlsUpdate(c, hands, t, s, fresh = true) {
  const dt = Math.max(0, t - c.lastT);
  c.lastT = t;
  c.out.missile = false;
  c.assigned = assignHands(hands, s, c.memo);
  rememberHands(c.memo, c.assigned);
  const { fly, thr } = c.assigned;
  const n = neutralFor(s);

  c.flyM = fly ? measureHand(fly) : null;
  c.thrM = thr ? measureHand(thr) : null;

  // Impossible jump: real moves on the recordings top out at ~0.5 palm lengths per reading; a
  // swapped or glitched hand leaps 3-4. Hold the last input for up to JUMP_CONFIRM readings, and
  // if the hand is still over there it really moved. After a dropout, wherever it comes back is fine.
  if (fresh) {
    c.jumped = false;
    const L = c.flyLast, hold = s.scheme === 'stick' ? CONFIG.STICK_LOST_HOLD : CONFIG.HAND_LOST_HOLD;
    if (c.flyM && L && t - c.flySeen <= hold
      && Math.hypot(c.flyM.cx - L.cx, c.flyM.cy - L.cy) / L.scale > CONFIG.JUMP_MAX
      && c.jumps < CONFIG.JUMP_CONFIRM) {
      c.jumps++;
      c.jumped = true;
    } else if (c.flyM) {
      c.jumps = 0;
      c.flyLast = { cx: c.flyM.cx, cy: c.flyM.cy, scale: c.flyM.scale };
    }
  }

  if (c.flyM && c.jumped) {
    c.flySeen = t;                         // a hand is there; just not believable yet — hold
  } else if (c.flyM) {
    const m = c.flyM;
    const scale = n.scale || m.scale;
    const a = flyAxes(m, n, s);
    // Your own reach, from the range sweep: each direction scaled so your comfortable limit = full.
    const roll = applyRange(a.roll, n.range && n.range.roll);
    let pitch = applyRange(a.pitch, n.range && n.range.pitch);
    if (s.invertPitch) pitch = -pitch;
    c.raw.roll = oneEuroStep(c.f.roll, roll, t, s.minCutoff, s.beta);
    // Pitch has the worse signal (it's a lean toward the camera): its own, usually lower, cutoff.
    c.raw.pitch = oneEuroStep(c.f.pitch, pitch, t, s.pitchSmooth ?? s.minCutoff, s.beta);
    c.flySeen = t;
    // Still hand that's still steering = the centre has drifted (sat closer, moved the stick).
    const moved = c.still && Math.hypot(m.cx - c.still.cx, m.cy - c.still.cy) / scale > CONFIG.STILL_MOVE;
    if (!c.still || moved) c.still = { t, cx: m.cx, cy: m.cy };
    c.offCentre = t - c.still.t > CONFIG.STILL_TIME
      && Math.max(Math.abs(c.raw.roll), Math.abs(c.raw.pitch)) > CONFIG.OFF_CENTRE;
    c.edge = m.cx < CONFIG.EDGE_MARGIN || m.cx > 1 - CONFIG.EDGE_MARGIN || m.cy < CONFIG.EDGE_MARGIN || m.cy > 1 - CONFIG.EDGE_MARGIN;
  } else if (t - c.flySeen > (s.scheme === 'stick' ? CONFIG.STICK_LOST_HOLD : CONFIG.HAND_LOST_HOLD)) {
    // Hand gone: hold briefly (blur, a dropped frame), then let the stick spring back.
    const k = Math.exp(-CONFIG.HAND_LOST_DECAY * dt);
    c.raw.roll *= k;
    c.raw.pitch *= k;
    c.f = { roll: createOneEuro(), pitch: createOneEuro(), yaw: c.f.yaw };
  }

  const ease = 1 - Math.exp(-CONFIG.INPUT_EASE * dt);
  c.out.roll += (shapeAxis(c.raw.roll, s) - c.out.roll) * ease;
  c.out.pitch += (shapeAxis(c.raw.pitch, s) - c.out.pitch) * ease;

  // Closing a fist tugs the palm and knuckles, so a missile would also nudge throttle and rudder.
  // On the fist, roll both back to just before the fingers started curling and hold them
  // until the hand has been open again for a moment. Missiles themselves fire instantly.
  const fistNow = !!c.thrM && (c.fist ? c.thrM.open < CONFIG.FIST_OFF : c.thrM.open < CONFIG.FIST_ON);
  if (fistNow && !c.fist) {
    // The value as of FIST_ROLLBACK ago (or the oldest kept, if the hand is newer than that).
    const old = c.thrHist.filter(h => h.t <= t - CONFIG.FIST_ROLLBACK);
    const before = old.length ? old[old.length - 1] : c.thrHist[0];
    if (before) { c.out.throttle = before.throttle; c.raw.yaw = before.yaw; }
  }
  if (fistNow) c.thrFrozenUntil = t + CONFIG.FIST_SETTLE;
  const thrFrozen = t < c.thrFrozenUntil;

  if (thrFrozen) {
    // hold c.raw.yaw where it is
  } else if (c.thrM && s.thrRudder) {
    const nt = s.neutral && s.neutral.thr;
    const yaw = applyRange(thrYaw(c.thrM, s), nt && nt.yaw);
    c.raw.yaw = oneEuroStep(c.f.yaw, yaw, t, s.minCutoff, s.beta);
  } else {
    c.raw.yaw *= Math.exp(-CONFIG.HAND_LOST_DECAY * 2 * dt);
    c.f.yaw = createOneEuro();
  }
  // The rudder hand also throttles and fires, so it wobbles: it gets its own, wider deadzone.
  c.out.yaw += (shapeAxis(c.raw.yaw, { ...s, deadzone: s.yawDeadzone }) - c.out.yaw) * ease;

  if (c.thrM) {
    const m = c.thrM;
    if (!thrFrozen) {
      const nt = s.neutral && s.neutral.thr, cyR = nt && nt.cy;   // [top, bottom] from the range sweep
      const lo = cyR ? cyR[1] : CONFIG.THROTTLE_LOW, hi = cyR ? cyR[0] : CONFIG.THROTTLE_HIGH;
      const target = clamp((lo - m.cy) / (lo - hi), 0, 1);
      c.out.throttle += (target - c.out.throttle) * (1 - Math.exp(-8 * dt));
      c.thrHist.push({ t, throttle: c.out.throttle, yaw: c.raw.yaw });
    }
    const wasFist = c.fist;
    c.fist = fistNow;
    c.pinched = c.pinched ? m.pinch < CONFIG.PINCH_OFF : m.pinch < CONFIG.PINCH_ON;
    // Guns wait for the pinch to hold GUN_HOLD readings (one glitched frame won't fire); release is
    // immediate. Missiles stay instant: hysteresis alone keeps them clean, and they need to be quick.
    if (!c.pinched) c.pinchReads = 0;
    else if (fresh) c.pinchReads++;
    c.out.gun = c.pinchReads >= CONFIG.GUN_HOLD && !c.fist;
    c.out.missile = c.fist && !wasFist;
  } else {
    c.out.gun = false;
    c.pinched = false;
    c.pinchReads = 0;
    c.fist = false;
  }
  while (c.thrHist.length > 1 && c.thrHist[1].t <= t - 0.3) c.thrHist.shift();   // keep one at or before 0.3 s ago
  return c;
}

// Snapshot the flying hand's current pose as centre for the current scheme.
// A centre near the frame edge leaves no room to roll that way (the user's fist sat at 75-80%
// across, and rolling right ran out of frame). Returns a warning, or ''.
function neutralRoom(n) {
  if (!n) return '';
  if (n.cx > 1 - CONFIG.ROOM_MARGIN || n.cx < CONFIG.ROOM_MARGIN || n.cy > 1 - CONFIG.ROOM_MARGIN || n.cy < CONFIG.ROOM_MARGIN) {
    return 'Your flying hand is near the edge of the camera — move it (or the camera) toward the middle for room to roll';
  }
  return '';
}

// Double clap → calibrate. Watches the gap between the two palms (in palm lengths): each
// apart → together transition is a clap, and two within CLAP_WINDOW fire. Palms touching often
// merge into one detection, so two close hands suddenly becoming one also counts as together.
function createClap() {
  return { together: false, lastGap: Infinity, lastSeen2: -1, claps: [] };
}

// Returns true on the frame the second clap lands.
function clapUpdate(cl, hands, t) {
  let together = cl.together;
  if (hands.length === 2) {
    const a = measureHand(hands[0]), b = measureHand(hands[1]);
    const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy) / ((a.scale + b.scale) / 2 || 1);
    if (gap < CONFIG.CLAP_TOGETHER) together = true;
    else if (gap > CONFIG.CLAP_APART) together = false;
    cl.lastGap = gap;
    cl.lastSeen2 = t;
  } else if (hands.length === 1 && t - cl.lastSeen2 < 0.2 && cl.lastGap < CONFIG.CLAP_MERGE) {
    together = true;
  } else if (hands.length === 0) {
    together = false;
  }
  const clapped = together && !cl.together;
  cl.together = together;
  if (!clapped) return false;
  cl.claps = cl.claps.filter(c => t - c <= CONFIG.CLAP_WINDOW);
  cl.claps.push(t);
  if (cl.claps.length >= 2) { cl.claps = []; return true; }
  return false;
}

// Range sweep: after the centre is set, you move the stick (and the other hand) to its limits
// for a few seconds. Each direction's reach becomes full deflection, so a short comfortable
// throw still gets full roll/pull, and an over-sensitive axis gets calmed down.
function createRangeSweep() {
  return { roll: [], pitch: [], yaw: [], cy: [] };
}

function rangeSweepAdd(sw, hands, s) {
  const { fly, thr } = assignHands(hands, s);
  if (fly) {
    const a = flyAxes(measureHand(fly), neutralFor(s), s);
    sw.roll.push(a.roll);
    sw.pitch.push(a.pitch);
  }
  if (thr) {
    const m = measureHand(thr);
    sw.yaw.push(thrYaw(m, s));
    sw.cy.push(m.cy);
  }
}

// q-th quantile of a list (q 0..1).
function quantile(xs, q) {
  if (!xs.length) return NaN;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
}

// Reach each way = the 95th percentile of the sweep (ignores a glitch or two), times RANGE_USE
// so full deflection comes a little before your limit. A direction you barely moved keeps the
// slider's scale. Writes s.neutral; returns the directions it set (for the message).
function rangeSweepFinish(sw, s) {
  const C = CONFIG, set = [];
  const reach = (xs, sign, name) => {
    const side = xs.map(v => v * sign).filter(v => v > 0);
    const r = quantile(side, 0.95) * C.RANGE_USE;
    if (!(side.length >= C.RANGE_MIN_SAMPLES && r >= C.RANGE_MIN)) return 1;
    set.push(name);
    return clamp(r, C.RANGE_MIN, C.RANGE_MAX);
  };
  s.neutral = { ...(s.neutral || {}) };
  const n = s.neutral[s.scheme];
  if (n && sw.roll.length) {
    s.neutral[s.scheme] = { ...n, range: {
      roll: [reach(sw.roll, -1, 'roll left'), reach(sw.roll, 1, 'roll right')],
      pitch: [reach(sw.pitch, -1, s.invertPitch ? 'pull' : 'push'), reach(sw.pitch, 1, s.invertPitch ? 'push' : 'pull')],
    } };
  }
  if (sw.cy.length >= C.RANGE_MIN_SAMPLES) {
    const nt = { ...(s.neutral.thr || { roll: 0 }) };
    nt.yaw = [reach(sw.yaw, -1, 'rudder left'), reach(sw.yaw, 1, 'rudder right')];
    const top = quantile(sw.cy, 0.05), bottom = quantile(sw.cy, 0.95);
    if (bottom - top > C.THROTTLE_MIN_TRAVEL) {
      const inset = (bottom - top) * (1 - C.RANGE_USE) / 2;
      nt.cy = [top + inset, bottom - inset];
      set.push('throttle');
    }
    s.neutral.thr = nt;
  }
  return set;
}

function calibrateNeutral(s, hands) {
  const { fly, thr } = assignHands(hands, s);
  if (!fly) return false;
  const m = measureHand(fly);
  s.neutral = { ...(s.neutral || {}) };
  // The rudder hand's resting angle, if it's in view (shared by both schemes).
  if (thr) s.neutral.thr = { ...(s.neutral.thr || {}), roll: measureHand(thr).roll };
  const old = s.neutral[s.scheme];
  s.neutral[s.scheme] = { roll: m.roll, pitch: m.pitch, cx: m.cx, cy: m.cy, scale: m.scale, axI: m.axI, axW: m.axW, range: old && old.range };
  return true;
}

// hands.js — MediaPipe hands → flight controls. Pure: no DOM.
// A hand is { lm, world }: 21 image landmarks (x mirrored, y down, z relative depth in x units)
// and 21 world landmarks (metres, same axes, centred on the hand).
//
// Flying hand, 'flat' scheme: roll = tilt of the knuckle line on screen; pitch = palm tipping
// toward/away from the camera (from the 3D world landmarks), or hand height if pitchSrc='height'.
// Flying hand, 'stick' scheme: a pivoting stick seen from the front. Roll = fist tilting (the
// knuckle line rotating) plus sliding sideways; pitch = fist height plus depth (a fist pushed
// toward the camera looks bigger). Pull/push is mostly depth with a front camera, so height alone
// read pulls weakly and made you shove the fist out of the bottom of the frame.
// Other hand: height = throttle, pinch thumb+index = gun, close the fist = missile.

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
  return { roll, pitch, cx, cy, scale, open, pinch };
}

// Two hands: split by screen side. One hand: it's the flying hand.
function assignHands(hands, s) {
  if (!hands || !hands.length) return { fly: null, thr: null };
  if (hands.length === 1) return { fly: hands[0], thr: null };
  const [a, b] = hands[0].lm[0].x < hands[1].lm[0].x ? [hands[0], hands[1]] : [hands[1], hands[0]];
  return s.hand === 'right' ? { fly: b, thr: a } : { fly: a, thr: b };
}

function createControls() {
  return {
    f: { roll: createOneEuro(), pitch: createOneEuro(), yaw: createOneEuro() },
    raw: { roll: 0, pitch: 0, yaw: 0 },     // before deadzone/expo, -1..1-ish
    out: { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, gun: false, missile: false },
    flyM: null, thrM: null,                // last measurements, for the debug view
    flySeen: -1,
    edge: false,                           // flying hand near the edge of the camera view
    lastT: 0,
    pinched: false,
    fist: false,
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

function neutralFor(s) {
  return (s.neutral && s.neutral[s.scheme]) || DEFAULT_NEUTRAL[s.scheme];
}

function controlsUpdate(c, hands, t, s) {
  const dt = Math.max(0, t - c.lastT);
  c.lastT = t;
  c.out.missile = false;
  const { fly, thr } = assignHands(hands, s);
  const n = neutralFor(s);

  c.flyM = fly ? measureHand(fly) : null;
  c.thrM = thr ? measureHand(thr) : null;

  if (c.flyM) {
    const m = c.flyM;
    const scale = n.scale || m.scale;
    let roll, pitch, yaw = 0;
    if (s.scheme === 'stick') {
      const tilt = foldHalf(m.roll - n.roll) / (s.rollRange * DEG);
      roll = (m.cx - n.cx) / scale / s.stickThrow;
      // Tilting the fist is how most people roll an imaginary stick. With twistRudder on it's
      // rudder instead (and leaks into rolls, since a pivoting stick tilts the fist as it goes over).
      if (s.twistRudder) yaw = tilt;
      else roll += tilt;
      const depth = -Math.log(m.scale / scale) / s.stickDepth;   // + = smaller = pulled back
      pitch = -(m.cy - n.cy) / scale / s.stickThrow + depth;
    } else {
      roll = foldHalf(m.roll - n.roll) / (s.rollRange * DEG);
      pitch = s.pitchSrc === 'height'
        ? -(m.cy - n.cy) / scale / s.stickThrow
        : wrapAngle(m.pitch - n.pitch) / (s.pitchRange * DEG);
    }
    if (s.invertPitch) pitch = -pitch;
    c.raw.roll = oneEuroStep(c.f.roll, roll, t, s.minCutoff, s.beta);
    c.raw.pitch = oneEuroStep(c.f.pitch, pitch, t, s.minCutoff, s.beta);
    c.raw.yaw = oneEuroStep(c.f.yaw, yaw, t, s.minCutoff, s.beta);
    c.flySeen = t;
    c.edge = m.cx < CONFIG.EDGE_MARGIN || m.cx > 1 - CONFIG.EDGE_MARGIN || m.cy < CONFIG.EDGE_MARGIN || m.cy > 1 - CONFIG.EDGE_MARGIN;
  } else if (t - c.flySeen > (s.scheme === 'stick' ? CONFIG.STICK_LOST_HOLD : CONFIG.HAND_LOST_HOLD)) {
    // Hand gone: hold briefly (blur, a dropped frame), then let the stick spring back.
    const k = Math.exp(-CONFIG.HAND_LOST_DECAY * dt);
    c.raw.roll *= k;
    c.raw.pitch *= k;
    c.raw.yaw *= k;
    c.f = { roll: createOneEuro(), pitch: createOneEuro(), yaw: createOneEuro() };
  }

  c.out.roll = shapeAxis(c.raw.roll, s);
  c.out.pitch = shapeAxis(c.raw.pitch, s);
  c.out.yaw = shapeAxis(c.raw.yaw, s);

  if (c.thrM) {
    const m = c.thrM;
    const target = clamp((CONFIG.THROTTLE_LOW - m.cy) / (CONFIG.THROTTLE_LOW - CONFIG.THROTTLE_HIGH), 0, 1);
    c.out.throttle += (target - c.out.throttle) * (1 - Math.exp(-8 * dt));
    const wasFist = c.fist;
    c.fist = c.fist ? m.open < CONFIG.FIST_OFF : m.open < CONFIG.FIST_ON;
    c.pinched = c.pinched ? m.pinch < CONFIG.PINCH_OFF : m.pinch < CONFIG.PINCH_ON;
    c.out.gun = c.pinched && !c.fist;
    c.out.missile = c.fist && !wasFist;
  } else {
    c.out.gun = false;
    c.pinched = false;
    c.fist = false;
  }
  return c;
}

// Snapshot the flying hand's current pose as centre for the current scheme.
function calibrateNeutral(s, hands) {
  const { fly } = assignHands(hands, s);
  if (!fly) return false;
  const m = measureHand(fly);
  s.neutral = { ...(s.neutral || {}) };
  s.neutral[s.scheme] = { roll: m.roll, pitch: m.pitch, cx: m.cx, cy: m.cy, scale: m.scale };
  return true;
}

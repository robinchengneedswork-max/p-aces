// flight.js — arcade flight model with a little energy. A plane is a position, an orthonormal
// basis (fwd, up, right) for where the nose points, and a flight path (path, unit) that trails the
// nose a little: pull hard and the plane slips, travelling slightly outside where it points.
// Every number comes from the plane's own spec (planes.js: CONFIG + that type's overrides).
// Pure: no DOM, no THREE.
//
// ctrl = { roll, pitch, yaw } in -1..1 (roll + = bank right, pitch + = nose up), throttle 0..1.
// The nose answers the stick at once (no added lag); realism only decides how hard it can go and
// what that costs: pull rate peaks at CORNER_SPEED, turns bleed speed, climbs trade it for height,
// below STALL_SPEED the nose drops. Sustained high G builds strain, which only tunnels the view
// (looks, never takes control: user's call). Assist mode is position control for bank (hold the hand at 20° and it
// holds 20°, turning); rate mode: stick = how fast it rolls/pitches.

const WORLD_UP = v3(0, 1, 0);

function createPlane(pos, fwd, type) {
  const spec = planeSpec(type);
  const p = {
    type: spec.type, spec,
    pos: pos || v3(0, CONFIG.START_ALT, 0),
    fwd: v3(0, 0, -1), up: v3(0, 1, 0), right: v3(1, 0, 0), path: v3(0, 0, -1),
    speed: (spec.SPEED_MIN + spec.SPEED_MAX) / 2,
    throttle: 0.5,
    g: 1, slip: 0, stall: 0,
    strain: 0, red: 0,
    crashed: false,
    wingStress: 0, overG: 0, wingFailed: false,   // WW2: over-G damage, 0..1 (1 = the wing lets go)
    engineCut: 0,                                  // WW2 float carburettor: seconds of no power left
    ammo: spec.GUNS ? spec.GUNS.map(gn => gn.ammo) : null,
    gunAcc: spec.GUNS ? spec.GUNS.map(() => 0) : null,
  };
  if (fwd) orientPlane(p, fwd);
  return p;
}

// Level flight along heading fwd (its vertical part is dropped).
function orientPlane(p, fwd) {
  const h = vNorm(v3(fwd.x, 0, fwd.z));
  p.fwd = h.x || h.z ? h : v3(0, 0, -1);
  p.right = vNorm(vCross(p.fwd, WORLD_UP));
  p.up = vCross(p.right, p.fwd);
  p.path = { ...p.fwd };
  return p;
}

function planeVelocity(p) {   // world velocity, m/s
  return vScale(p.path, p.speed);
}

// Bank angle: + when the right wing is down.
function bankAngle(p) {
  return Math.atan2(-p.right.y, p.up.y);
}

function rotatePlane(p, axis, a) {
  if (!a) return;
  p.fwd = vRotate(p.fwd, axis, a);
  p.up = vRotate(p.up, axis, a);
  p.right = vRotate(p.right, axis, a);
}

// Share of PITCH_RATE available at this speed: 1 at corner speed. Slower, the wing runs out of
// lift. Faster: the jet is g-limited (∝ 1/speed); a WW2 wing has lift to spare (PITCH_HIGH_EXP 1,
// so G grows with speed², past the wing's limit) and only heavy stick forces hold it back.
function pitchEnvelope(speed, spec = CONFIG) {
  const v = Math.max(1, speed), c = spec.CORNER_SPEED;
  if (v < c) return Math.pow(v / c, spec.PITCH_LOW_EXP);
  return Math.pow(v / c, spec.PITCH_HIGH_EXP ?? -1) * stickForce(v, spec);
}

// 1, falling to STIFF_MIN as the controls grow heavy past STIFF_SPEED (WW2; the jet never stiffens).
function stickForce(speed, spec) {
  if (!spec.STIFF_SPEED) return 1;
  return clamp(1 - (speed - spec.STIFF_SPEED) / spec.STIFF_RANGE, spec.STIFF_MIN, 1);
}

// How hard the nose is being hauled round (pitch or turn, not roll: fwd doesn't move in a pure
// roll), as 0..1 wingtip vapour. Real planes pull vapour off the tips under high g, i.e. hard pulls.
function vaporAmount(prevFwd, fwd, dt) {
  if (!prevFwd || dt <= 0) return 0;
  const rate = Math.acos(clamp(vDot(prevFwd, fwd), -1, 1)) / dt;
  return clamp((rate - CONFIG.VAPOR_MIN_RATE) / CONFIG.VAPOR_FULL_RATE, 0, 1);
}

function flightStep(p, ctrl, dt, assist) {
  if (p.crashed) return p;
  const C = p.spec || CONFIG;
  const env = pitchEnvelope(p.speed, C);
  p.stall = clamp((C.STALL_SPEED - p.speed) / 20, 0, 1);
  const pull = ctrl.pitch * (1 - 0.7 * p.stall);
  const pitchRate = (pull > 0 ? pull : pull * C.PUSH_SHARE) * C.PITCH_RATE * env;
  const rollK = clamp(p.speed / C.ROLL_FULL_SPEED, C.ROLL_MIN, 1) * (0.5 + 0.5 * stickForce(p.speed, C));

  // Assist hands over to plain rate control while you're pulling through vertical or upside
  // down: there "wings level" means rolling 180°, which would fight every loop. Let go of the
  // stick while inverted and assist takes back over and rolls you upright.
  const looping = assist && Math.abs(ctrl.pitch) > C.LOOP_PITCH
    && (p.up.y < C.LOOP_UP || Math.abs(p.fwd.y) > C.LOOP_VERTICAL);
  p.looping = looping;
  if (assist && !looping) {
    const target = ctrl.roll * C.MAX_BANK;
    const rate = clamp((target - bankAngle(p)) * C.BANK_GAIN, -C.ROLL_RATE, C.ROLL_RATE) * rollK;
    rotatePlane(p, p.fwd, rate * dt);
    // Pitch about the plane's own wing axis: pulling while banked tightens the turn, toward
    // the canopy, like Ace Combat. (Pitching about the world horizontal instead made a banked
    // pull slide the nose sideways across the screen, which read as yaw.)
    rotatePlane(p, p.right, pitchRate * dt);
    // Banked = turning, like a coordinated turn, as hard as the speed allows.
    const turn = C.TURN_RATE * Math.sin(bankAngle(p)) * Math.min(env, 1) + ctrl.yaw * C.YAW_RATE;
    rotatePlane(p, WORLD_UP, -turn * dt);
  } else {
    rotatePlane(p, p.fwd, ctrl.roll * C.ROLL_RATE * rollK * dt);
    rotatePlane(p, p.right, pitchRate * dt);
    rotatePlane(p, p.up, -ctrl.yaw * C.YAW_RATE * dt);
  }
  // Stalled: the nose falls toward the ground on its own.
  if (p.stall > 0) {
    // Straight up there's no "toward the ground" side: it falls over toward the belly.
    const axis = vCross(p.fwd, v3(0, -1, 0));
    if (vLen(axis) > 1e-3) rotatePlane(p, vNorm(axis), C.STALL_DROP * p.stall * dt);
    else rotatePlane(p, p.right, -C.STALL_DROP * p.stall * dt);
  }

  // Re-orthonormalise so rounding never shears the basis.
  p.fwd = vNorm(p.fwd);
  p.right = vNorm(vCross(p.fwd, p.up));
  p.up = vCross(p.right, p.fwd);

  // The flight path follows the nose at a rate that grows with speed (lift): slip.
  const before = p.path;
  const slip = Math.acos(clamp(vDot(p.path, p.fwd), -1, 1));
  if (slip > 1e-6) {
    const grip = C.SLIP_GRIP * clamp(p.speed / C.CORNER_SPEED, 0.35, 1.3);
    const keep = slip * Math.exp(-grip * dt);
    p.path = vNorm(vRotate(p.path, vNorm(vCross(p.path, p.fwd)), slip - keep));
  } else p.path = { ...p.fwd };
  p.slip = Math.acos(clamp(vDot(p.path, p.fwd), -1, 1));

  // G felt along the canopy: the flight path's turn (arcade-scaled) plus gravity's share.
  if (dt > 0) {
    const turnAcc = vScale(vSub(p.path, before), p.speed / dt);
    p.g = vDot(turnAcc, p.up) / C.A_PER_G + p.up.y;
  }

  // Energy: thrust − drag, gravity on climbs and dives, turns bleed. The jet eases toward the
  // throttle's speed; a propeller's thrust is power ÷ speed against drag ∝ speed².
  p.throttle = clamp(ctrl.throttle, 0, 1);
  const over = Math.max(0, Math.abs(p.g) - 1);
  let thrust;
  if (C.PROP) {
    // Float carburettor: negative G starves it; power comes back a moment after.
    if (C.NEG_G_CUT && p.g < -0.2) p.engineCut = C.NEG_G_CUT;
    p.engineCut = Math.max(0, p.engineCut - dt);
    thrust = (p.engineCut > 0 ? 0 : C.POWER * p.throttle / Math.max(p.speed, C.V_STATIC)) - C.DRAG_K * p.speed * p.speed;
  } else {
    thrust = (C.SPEED_MIN + p.throttle * (C.SPEED_MAX - C.SPEED_MIN) - p.speed) * C.ACCEL;
  }
  // WW2: induced drag ∝ (G / speed)², so the same pull costs far more slow than fast.
  const bleed = C.TURN_BLEED * over * over * (C.PROP ? Math.min(4, Math.pow(C.CORNER_SPEED / Math.max(p.speed, 30), 2)) : 1);
  p.speed += (thrust - C.CLIMB_DRAG * p.path.y - bleed) * dt;
  p.speed = clamp(p.speed, C.SPEED_FLOOR, C.SPEED_MAX * 1.4);

  // G strain (tunnel vision, drawn by the HUD): builds above onset, drains below it.
  p.strain = clamp(p.strain + (p.g > C.G_ONSET ? (p.g - C.G_ONSET) / C.G_STRAIN_TIME : -C.G_RECOVER) * dt, 0, 1);
  p.red = clamp(p.red + (p.g < C.REDOUT_G ? 1.2 : -1) * dt, 0, 1);

  // WW2 wing: past G_LIMIT (either way) it takes stress; held too long, it fails.
  if (C.G_LIMIT) {
    p.overG = Math.max(p.g / C.G_LIMIT, -p.g / (C.G_LIMIT * 0.5));
    p.wingStress = p.overG > 1 ? p.wingStress + (p.overG - 1) * C.OVER_G_STRESS * dt : Math.max(0, p.wingStress - C.OVER_G_HEAL * dt);
    if (p.wingStress >= 1) { p.wingFailed = true; p.crashed = true; return p; }
  }

  p.pos = vAdd(p.pos, vScale(p.path, p.speed * dt));
  if (p.pos.y > C.CEILING) p.pos.y = C.CEILING;
  if (p.pos.y < groundHeight(p.pos.x, p.pos.z) + C.CRASH_MARGIN) p.crashed = true;
  return p;
}

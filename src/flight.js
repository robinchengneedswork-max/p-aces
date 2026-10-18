// flight.js — arcade flight model. A plane is a position plus an orthonormal basis
// (fwd, up, right). Pure: no DOM, no THREE.
//
// ctrl = { roll, pitch, yaw } in -1..1 (roll + = bank right, pitch + = nose up), throttle 0..1.
// Assist mode is position control for bank: hold the hand at 20° and the plane banks and stays
// at the matching angle, turning. Expert mode is rate control: stick = how fast it rolls.

const WORLD_UP = v3(0, 1, 0);

function createPlane(pos) {
  return {
    pos: pos || v3(0, CONFIG.START_ALT, 0),
    fwd: v3(0, 0, -1),
    up: v3(0, 1, 0),
    right: v3(1, 0, 0),
    speed: (CONFIG.SPEED_MIN + CONFIG.SPEED_MAX) / 2,
    throttle: 0.5,
    crashed: false,
  };
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

// How hard the nose is being hauled round (pitch or turn, not roll: fwd doesn't move in a pure
// roll), as 0..1 wingtip vapour. Real planes pull vapour off the tips under high g, i.e. hard pulls.
function vaporAmount(prevFwd, fwd, dt) {
  if (!prevFwd || dt <= 0) return 0;
  const rate = Math.acos(clamp(vDot(prevFwd, fwd), -1, 1)) / dt;
  return clamp((rate - CONFIG.VAPOR_MIN_RATE) / CONFIG.VAPOR_FULL_RATE, 0, 1);
}

function flightStep(p, ctrl, dt, assist) {
  if (p.crashed) return p;
  // Assist hands over to plain rate control while you're pulling through vertical or upside
  // down: there "wings level" means rolling 180°, which would fight every loop. Let go of the
  // stick while inverted and assist takes back over and rolls you upright.
  const looping = assist && Math.abs(ctrl.pitch) > CONFIG.LOOP_PITCH
    && (p.up.y < CONFIG.LOOP_UP || Math.abs(p.fwd.y) > CONFIG.LOOP_VERTICAL);
  p.looping = looping;
  if (assist && !looping) {
    const target = ctrl.roll * CONFIG.MAX_BANK;
    const rate = clamp((target - bankAngle(p)) * CONFIG.BANK_GAIN, -CONFIG.ROLL_RATE, CONFIG.ROLL_RATE);
    rotatePlane(p, p.fwd, rate * dt);

    // Pitch about the plane's own wing axis: pulling while banked tightens the turn, toward
    // the canopy, like Ace Combat. (Pitching about the world horizontal instead made a banked
    // pull slide the nose sideways across the screen, which read as yaw.)
    rotatePlane(p, p.right, ctrl.pitch * CONFIG.PITCH_RATE * dt);

    // Banked = turning. Heading change comes from the bank, like a coordinated turn.
    const turn = CONFIG.TURN_RATE * Math.sin(bankAngle(p)) + ctrl.yaw * CONFIG.YAW_RATE;
    rotatePlane(p, WORLD_UP, -turn * dt);
  } else {
    rotatePlane(p, p.fwd, ctrl.roll * CONFIG.ROLL_RATE * dt);
    rotatePlane(p, p.right, ctrl.pitch * CONFIG.PITCH_RATE * dt);
    rotatePlane(p, p.up, -ctrl.yaw * CONFIG.YAW_RATE * dt);
  }

  // Re-orthonormalise so rounding never shears the basis.
  p.fwd = vNorm(p.fwd);
  p.right = vNorm(vCross(p.fwd, p.up));
  p.up = vCross(p.right, p.fwd);

  p.throttle = clamp(ctrl.throttle, 0, 1);
  const target = CONFIG.SPEED_MIN + p.throttle * (CONFIG.SPEED_MAX - CONFIG.SPEED_MIN);
  p.speed += (target - p.speed) * CONFIG.ACCEL * dt - CONFIG.CLIMB_DRAG * p.fwd.y * dt;
  p.speed = clamp(p.speed, CONFIG.SPEED_MIN * 0.7, CONFIG.SPEED_MAX * 1.25);

  p.pos = vAdd(p.pos, vScale(p.fwd, p.speed * dt));
  if (p.pos.y > CONFIG.CEILING) p.pos.y = CONFIG.CEILING;
  if (p.pos.y < groundHeight(p.pos.x, p.pos.z) + CONFIG.CRASH_MARGIN) p.crashed = true;
  return p;
}

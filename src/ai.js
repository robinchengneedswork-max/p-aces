// ai.js — enemy pilots. Pure: no DOM, no THREE.
// A bandit is an ordinary plane flown through the same flightStep as the player (rate mode), by a
// pilot that produces the same { roll, pitch, yaw, throttle } a hand does. So it bleeds energy,
// stalls and blacks out like you do.
//
// The core move is "lift vector on target": roll until the point you want sits straight above the
// canopy, then pull. Priorities, highest first: don't hit the ground, dodge a missile, break when
// someone's on your tail, rebuild speed when slow, else chase and shoot (lead pursuit).
// Skill = how stale its picture of you is (reaction), how sloppy its aim, how hard it dares pull.

// dodge: how far off the ideal distance (m) it starts its missile break; panic: chance it breaks far too early.
// joust: takes head-on gun passes (it loses them: your gun and its hitbox are bigger). Others slide
// off to one side and hold fire until they can turn in behind. throttle: the most it uses — lower = less energy to fight with (user lost 0-10 to rookies flying
// by hand: they out-turned and out-energied him). gunCone: trigger discipline (rookies spray). energy: below corner speed by more than this (m/s) it eases
// off the pull to keep its speed (Infinity = never: rookies yank and bleed). G strain is looks only, so
// pilots ignore it; energy is what makes hard turning tiring.
const SKILLS = {
  rookie:  { name: 'ROOKIE',  react: 0.5,  aim: 3.5 * DEG, pull: 0.6,  throttle: 0.7,  joust: true,  gunRange: 650, gunCone: 5 * DEG,   missileCd: 16, energy: Infinity, breakAt: 0.55, dodge: 330, panic: 0.3, hp: 8,  reward: 200 },
  regular: { name: 'REGULAR', react: 0.3,  aim: 2 * DEG,   pull: 0.8,  throttle: 0.85, joust: false, gunRange: 800, gunCone: 4 * DEG,   missileCd: 11, energy: 40, breakAt: 0.8,  dodge: 160, panic: 0.1, hp: 10, reward: 350 },
  ace:     { name: 'ACE',     react: 0.15, aim: 0.8 * DEG, pull: 1,    throttle: 1,    joust: false, gunRange: 900, gunCone: 3.5 * DEG, missileCd: 7,  energy: 15, breakAt: 1,    dodge: 70,  panic: 0,   hp: 16, reward: 800 },
};
const DODGE_IDEAL = 1200;  // m: start the break mid CONFIG.BREAK_DIST

function createBandit(id, skill, pos, fwd, rng, type) {
  const plane = createPlane(pos, fwd, type);
  plane.speed = plane.spec.CORNER_SPEED + 20;
  const sk = SKILLS[skill];
  return {
    id, kind: 'bandit', skill, plane, alive: true,
    hp: sk.hp, maxHp: sk.hp,
    pos: plane.pos, vel: planeVelocity(plane),
    rng,
    pilot: { think: 0, seen: null, aim: v3(0, 0, 0), mode: 'attack', jinkT: 0, jinkRoll: 0, extendT: 0, dodgeFor: null, dodgeAt: 0 },
    gunAcc: 0, firing: false,
    missileCd: sk.missileCd * 0.6,        // not on the first merge: get your bearings first
    lockT: 0,
  };
}

// Stick commands that put `point` on the nose: lift vector on it, then pull. maxPull caps the pull.
function steerTo(p, point, maxPull) {
  const d = vNorm(vSub(point, p.pos));
  const lx = vDot(d, p.right), ly = vDot(d, p.up), lz = vDot(d, p.fwd);
  const off = Math.acos(clamp(lz, -1, 1));
  // Roll error to put the point straight "up" from the nose. Close to the nose, fine aim uses a
  // little roll + rudder instead of rolling 90° for a sideways nudge.
  let rollErr = Math.atan2(lx, ly);
  // Just below the nose: push, don't roll over. Not while inverted, though (diving in on a bomber):
  // a push is weak, and the nose would hang a few degrees off the target for the whole pass.
  if (ly < 0 && off < 15 * DEG && (p.up.y > -0.2 || off < 2 * DEG)) rollErr = -Math.atan2(lx, -ly);
  const roll = clamp(rollErr * 2.5, -1, 1) * clamp(off / (6 * DEG), 0, 1);
  const aligned = Math.abs(rollErr) < 50 * DEG || off < 15 * DEG;
  const pitch = clamp(Math.atan2(ly, Math.max(lz, 0.05)) * 4, -0.5, maxPull) * (aligned ? 1 : 0.25);
  const yaw = off < 15 * DEG ? clamp(Math.atan2(lx, lz) * 5, -1, 1) : 0;
  return { roll, pitch, yaw, off };
}

// Wings level and climb: ground recovery. Roll the canopy toward the sky first, then pull.
function recoverCtrl(p) {
  const bank = bankAngle(p);
  const inverted = p.up.y < 0.2;
  const roll = clamp(-bank * 2.5, -1, 1);
  return { roll: inverted && Math.abs(roll) < 0.3 ? 1 : roll, pitch: inverted ? 0.2 : 1, yaw: 0 };
}

// Will we hit the ground, flying on as we are? soon = within ~2 s (drop everything), else ~3.5 s.
function groundDanger(p, soon) {
  for (const t of soon ? [0.7, 1.4, 2] : [3, 4]) {
    const q = vAdd(p.pos, vScale(p.path, p.speed * t));
    if (q.y < groundHeight(q.x, q.z) + 100 + 60 * t) return true;
  }
  return soon && p.pos.y - groundHeight(p.pos.x, p.pos.z) < 150 && p.path.y < 0.1;
}

// One pilot decision. target = { pos, vel, plane?, bomber? }, threats = [{ ref, pos, tti, dist }] missiles coming for us.
// Returns ctrl plus { fire, lockOn } wishes; the game decides what actually happens.
function pilotStep(b, target, threats, dt) {
  const p = b.plane, P = b.pilot, sk = SKILLS[b.skill];
  const rng = b.rng;
  // Energy: a hard turn bleeds speed (flight.js), so a good pilot eases off below corner speed.
  let pullMax = p.speed < p.spec.CORNER_SPEED - sk.energy ? Math.min(sk.pull, 0.7) : sk.pull;
  // WW2 wings break: pull no more than ~95% of the limit (G ≈ 1 + pull × available rate × speed / g).
  if (p.spec.G_LIMIT) {
    const perPull = p.spec.PITCH_RATE * pitchEnvelope(p.speed, p.spec) * p.speed / p.spec.A_PER_G;
    pullMax = Math.min(pullMax, Math.max(0.2, (p.spec.G_LIMIT * 0.95 - 1) / perPull));
  }
  const ww2 = p.spec.ERA === 'ww2';
  const gunRange = sk.gunRange * (ww2 ? 0.55 : 1);   // WW2 guns are short-ranged
  // Reaction: refresh our picture of the target every `react` s, extrapolate it in between.
  P.think -= dt;
  if (target && (P.think <= 0 || !P.seen)) {
    P.think = sk.react * (0.7 + rng() * 0.6);
    P.seen = { pos: { ...target.pos }, vel: { ...target.vel }, age: 0 };
    const e = sk.aim * (target.bomber ? 0.4 : 1);   // a bomber flies straight: easy to hold
    P.aim = v3((rng() - 0.5) * 2 * e, (rng() - 0.5) * 2 * e, 0);
  }
  if (!target) P.seen = null;          // you're dead (or gone): forget you, patrol
  if (P.seen) P.seen.age += dt;
  const tp = P.seen ? vAdd(P.seen.pos, vScale(P.seen.vel, P.seen.age)) : null;

  let ctrl, fire = false, lockOn = false, good = false;
  let throttle = 0.85;
  const toT = tp ? vSub(tp, p.pos) : null;
  const dist = toT ? vLen(toT) : Infinity;
  // Is the target behind us and close (on our six)?
  const onSix = toT && dist < 1400 && vDot(vScale(toT, 1 / dist), p.fwd) < -0.55
    && target && target.plane && vDot(target.plane.fwd, vScale(toT, -1 / dist)) > 0.8;
  const missile = threats.reduce((m, t) => (!m || t.tti < m.tti ? t : m), null);
  // A new missile: decide when we'll break (skill = how close to the right moment).
  if (missile && P.dodgeFor !== missile.ref) {
    P.dodgeFor = missile.ref;
    P.dodgeAt = rng() < sk.panic ? 2000 + rng() * 800 : DODGE_IDEAL + (rng() - 0.5) * 2 * sk.dodge;
  }

  if (groundDanger(p, true)) {
    P.mode = 'recover';
    ctrl = recoverCtrl(p);
    throttle = 1;
  } else if (missile && missile.dist < P.dodgeAt) {
    // Missile: pull as hard as we dare across its line of sight (lift vector perpendicular to it,
    // whichever way the canopy already faces), so it has to out-turn us at the last moment.
    P.mode = 'evade';
    const los = vNorm(vSub(missile.pos, p.pos));
    let perp = vSub(p.up, vScale(los, vDot(p.up, los)));
    perp = vLen(perp) > 0.1 ? vNorm(perp) : p.right;
    const s = steerTo(p, vAdd(p.pos, vScale(perp, 1000)), pullMax);
    ctrl = { roll: s.roll, pitch: pullMax, yaw: 0 };
    // Fast = g-limited = turns wide: chop the throttle to get down toward corner speed.
    throttle = p.speed > p.spec.CORNER_SPEED + 20 ? 0 : 1;
  } else if (groundDanger(p, false)) {
    P.mode = 'recover';
    ctrl = recoverCtrl(p);
    throttle = 1;
  } else if (onSix && rng() < sk.breakAt + 0.3) {
    // Break turn into the attacker, with a jink now and then so a gun solution won't settle.
    P.mode = 'break';
    P.jinkT -= dt;
    if (P.jinkT <= 0) { P.jinkT = 0.8 + rng() * 1.2; P.jinkRoll = (rng() - 0.5) * 1.2; }
    const s = steerTo(p, tp, pullMax);
    ctrl = { roll: clamp(s.roll + P.jinkRoll, -1, 1), pitch: pullMax, yaw: 0 };
    throttle = 1;
  } else if (P.extendT > 0 || (p.speed < p.spec.CORNER_SPEED * 0.62 && P.mode !== 'extend')) {
    // Too slow to fight: unload, nose a little low, full burner, until fast again.
    if (P.mode !== 'extend') P.extendT = 3;
    P.mode = 'extend';
    P.extendT -= dt;
    if (p.speed > p.spec.CORNER_SPEED) P.extendT = 0;
    const ahead = vAdd(p.pos, vScale(vNorm(v3(p.fwd.x, -0.15, p.fwd.z)), 1000));
    ctrl = steerTo(p, ahead, 0.4);
    throttle = 1;
  } else if (tp) {
    // Attack: lead pursuit — aim where the target will be when the rounds get there.
    P.mode = 'attack';
    const gunSpeed = p.spec.GUNS ? p.spec.GUNS[0].speed : CONFIG.GUN_SPEED;
    const tof = dist / (gunSpeed + p.speed);
    let lead = vAdd(tp, vScale(P.seen.vel, tof));
    if (target.bomber) {
      // A bomber attack is mostly diving and pulling (the path slips off the nose): solve the shot
      // the way your lead marker does, in our moving frame (rounds carry our velocity).
      const rel = vSub(P.seen.vel, planeVelocity(p));
      let aim = toT;
      for (let i = 0; i < 4; i++) aim = vAdd(toT, vScale(rel, vLen(aim) / gunSpeed));
      lead = vAdd(p.pos, aim);
    }
    // Aim error turns the lead point a little.
    let aimDir = vNorm(vSub(lead, p.pos));
    aimDir = vRotate(aimDir, p.up, P.aim.x);
    aimDir = vRotate(aimDir, p.right, P.aim.y);
    // Head-on and closing: a non-jouster aims ~12° off to whichever side it's already on.
    const headOn = !sk.joust && target && target.plane && dist < 1500
      && vDot(target.plane.fwd, vScale(toT, -1 / dist)) > 0.9 && vDot(p.fwd, vScale(toT, 1 / dist)) > 0.7;
    if (headOn) aimDir = vRotate(aimDir, p.up, vDot(toT, p.right) > 0 ? 12 * DEG : -12 * DEG);
    // Against a bomber, steer ahead of the line of sight by how fast it's swinging (a diving pass
    // sweeps it steadily; steering at it alone lags a few degrees behind the whole way down).
    let steerDir = aimDir;
    if (target.bomber && P.lastAim && dt > 0) steerDir = vNorm(vAdd(aimDir, vScale(vSub(aimDir, P.lastAim), 0.6 / dt)));
    P.lastAim = target.bomber ? aimDir : null;
    const s = steerTo(p, vAdd(p.pos, vScale(steerDir, dist)), pullMax);
    ctrl = s;
    // Close and closing fast = about to overshoot: throttle back.
    const closing = -vDot(vSub(P.seen.vel, planeVelocity(p)), vScale(toT, 1 / dist));
    // A bomber (target.bomber) is a slashing pass: keep the speed up, no overshoot worries.
    if (target.bomber) throttle = 1;
    else if (dist < 600 && closing > 40) throttle = 0.3;
    else if (dist > 2000) throttle = 1;
    // Fire inside its cone, or whenever the rounds would pass within ~15 m of the target. A bomber
    // is a far bigger target: open up from further out, with more slack.
    const range = target.bomber ? gunRange * CONFIG.RAID_FIRE_RANGE : gunRange, slack = target.bomber ? 2 : 1;
    fire = !headOn && dist < range && (s.off < sk.gunCone * slack || dist * Math.sin(s.off) < 15 * slack);
    good = fire && (target.bomber ? dist < range * 0.7 : dist < range * 0.6 && dist * Math.sin(s.off) < 8);   // cannons: only a sure shot (any bomber shot in close)
    lockOn = s.off < CONFIG.LOCK_CONE && dist < CONFIG.LOCK_RANGE && dist > CONFIG.ENEMY_MIN_RANGE;
  } else {
    P.mode = 'patrol';
    ctrl = recoverCtrl(p);
    ctrl.pitch = clamp((CONFIG.START_ALT + groundHeight(p.pos.x, p.pos.z) - p.pos.y) / 400, -0.3, 0.3);
  }
  // A prop loses far more speed to a throttle cap than the jet did (thrust ∝ power): WW2 pilots
  // keep most of it, or a rookie could never catch you.
  const cap = ww2 ? 1 - (1 - sk.throttle) * 0.3 : sk.throttle;
  return { roll: ctrl.roll, pitch: ctrl.pitch, yaw: ctrl.yaw || 0, throttle: Math.min(throttle, cap), fire, good, lockOn: lockOn && !ww2 };
}

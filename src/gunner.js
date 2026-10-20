// gunner.js — crewing a bomber's top turret (solo escort role 'gunner', raid.js). Pure: no DOM.
//
// Hands (the user's design): both fists in view = you're holding the gun's two grips. Move them and
// the gun swings like a pivoting mount: fists down = muzzle up, fists right = muzzle left
// (settings.gunnerPivot; off = the muzzle follows the fists). Shake them, any direction or toward
// and away from the camera, to fire. Let go and grab again anywhere and the gun stays where it was
// (a clutch, like lifting a mouse). Head look swings the gun too: big and coarse, the hands aim
// fine. The view looks down the gun. Keyboard: arrows swing it, Space fires.
//
// Aim reads a smoothed fist position (AIM_SMOOTH); fire reads the jolt (second difference of the
// raw position per reading, in palm lengths): a shake is all jolt, a deliberate swing hardly any.

function createGunnerInput() {
  return { grip: false, lostT: 0, lp: null, anchor: null, base: { az: 0, el: 0 }, az: 0, el: 0, prev: [], shake: 0, fire: false, t: null };
}

// One camera reading (fresh = a new reading; main calls this every drawn frame).
function gunnerInputUpdate(gi, hands, t, s, fresh = true) {
  if (!fresh) return gi;
  const dt = gi.t === null ? 1 / 20 : clamp(t - gi.t, 1e-3, 0.2);
  gi.t = t;
  const ms = (hands || []).slice(0, 2).map(measureHand);
  const fists = ms.length === 2 && ms.every(m => m.open < (gi.grip ? CONFIG.FIST_OFF : CONFIG.FIST_ON));
  if (!fists) {
    gi.lostT += dt;
    if (gi.grip && gi.lostT > CONFIG.GRIP_HOLD) { gi.grip = false; gi.fire = false; gi.shake = 0; gi.prev = []; }
    return gi;
  }
  gi.lostT = 0;
  const [a, b] = ms;
  const scale = (a.scale + b.scale) / 2 || 0.1;
  const raw = { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2, d: Math.log(scale) };
  // Aim: the smoothed midpoint of the fists, relative to where you grabbed.
  const k = 1 - Math.exp(-dt / CONFIG.AIM_SMOOTH);
  if (!gi.grip) {
    gi.grip = true;
    gi.lp = { x: raw.x, y: raw.y };
    gi.anchor = { ...gi.lp };
    gi.base = { az: gi.az, el: gi.el };
    gi.prev = [];
  } else gi.lp = { x: gi.lp.x + (raw.x - gi.lp.x) * k, y: gi.lp.y + (raw.y - gi.lp.y) * k };
  const gain = s.gunnerGain * DEG / 0.1, sign = s.gunnerPivot ? -1 : 1;
  gi.az = gi.base.az + sign * (gi.lp.x - gi.anchor.x) * gain;
  gi.el = clamp(gi.base.el + sign * (gi.anchor.y - gi.lp.y) * gain, -Math.PI / 2, Math.PI / 2);   // (image y is down)
  // Fire: the fists' jolt, smoothed, with hysteresis.
  gi.prev.push(raw);
  if (gi.prev.length > 3) gi.prev.shift();
  if (gi.prev.length === 3) {
    const [p0, p1, p2] = gi.prev;
    const j = Math.hypot((p2.x - 2 * p1.x + p0.x) / scale, (p2.y - 2 * p1.y + p0.y) / scale, p2.d - 2 * p1.d + p0.d) * s.gunnerShake;
    gi.shake += (j - gi.shake) * (1 - Math.exp(-dt / CONFIG.SHAKE_SMOOTH));
  }
  gi.fire = gi.fire ? gi.shake > CONFIG.SHAKE_OFF : gi.shake > CONFIG.SHAKE_ON;
  return gi;
}

// The gun's direction in the world: az right of the bomber's nose about its up, el above its wings.
function crewDir(b, az, el) {
  const P = b.plane;
  const h = vRotate(P.fwd, P.up, -az);
  return vNorm(vRotate(h, vNorm(vCross(h, P.up)), el));
}

// Put the player in bomber b's top turret (its AI gunner stands down). Keeps the gun's angles.
function crewTurret(g, b) {
  for (const x of g.bombers) x.gunners.forEach(gu => { gu.human = false; });
  const gu = b.gunners[CONFIG.CREW_TURRET];
  gu.human = true;
  const old = g.crew;
  g.plane = b.plane;
  g.crew = { b, gu, az: old ? old.az : 0, el: old ? old.el : 20 * DEG, ammo: CONFIG.CREW_BELT, reloadT: 0, acc: 0, downT: 0, firing: false, sol: null, assisted: false, side: 1 };
  g.crew.at = bomberPartPos(b, gu);
  g.crew.dir = crewDir(b, g.crew.az, g.crew.el);
  syncPlayer(g);
}

// The best AI 109 near the gun's line and the direction to fire so the rounds meet it (rounds carry
// the bomber's velocity: same moving-frame solve as gunSolution). → { target, dir, dist, off } or null.
function crewSolution(g, c) {
  let best = null;
  for (const t of g.bandits) {
    if (!t.alive || t.team !== 'attacker') continue;
    const to = vSub(t.pos, c.at), dist = vLen(to);
    if (dist > CONFIG.GUNNER_RANGE * 1.5 || dist < 1) continue;
    const rel = vSub(t.vel, c.b.vel);
    let aim = to;
    for (let i = 0; i < 4; i++) aim = vAdd(to, vScale(rel, vLen(aim) / CONFIG.GUN_SPEED));
    const dir = vNorm(aim);
    const off = Math.acos(clamp(vDot(dir, c.dir), -1, 1));
    if (!best || off < best.off) best = { target: t, dir, dist, off };
  }
  return best;
}

// Your turn at the turret. ctrl.gunAz / gunEl = where you're asking the gun to point (hands + head +
// keys); the turret drive swings toward it at CREW_SLEW, inside its limits. ctrl.gun fires.
// Your turret shot out, or your bomber going down: after ESCORT_RESPAWN you move to the next.
function crewStep(g, ctrl, dt) {
  const c = g.crew, b = c.b;
  if (!b.alive || c.gu.hp <= 0) {
    if (c.downT === 0) { g.deaths++; g.events.push({ type: 'turret-out', how: b.alive ? 'hit' : 'bomber', pos: b.pos }); }
    c.downT += dt;
    c.firing = false;
    const next = g.bombers.find(x => x.alive && x !== b && x.gunners[CONFIG.CREW_TURRET].hp > 0);
    if (c.downT >= CONFIG.ESCORT_RESPAWN && next) {
      crewTurret(g, next);
      g.events.push({ type: 'crew-move', pos: next.pos });
    }
    return;
  }
  const step = CONFIG.CREW_SLEW * dt;
  const dAz = Math.atan2(Math.sin((ctrl.gunAz || 0) - c.az), Math.cos((ctrl.gunAz || 0) - c.az));
  c.az += clamp(dAz, -step, step);
  c.az = Math.atan2(Math.sin(c.az), Math.cos(c.az));
  c.el += clamp(clamp(ctrl.gunEl ?? c.el, CONFIG.CREW_EL_MIN, CONFIG.CREW_EL_MAX) - c.el, -step, step);
  c.at = bomberPartPos(b, c.gu);
  c.dir = crewDir(b, c.az, c.el);
  // Gun assist, like the fighters' hidden one: close to the lead, the rounds go to it.
  c.sol = crewSolution(g, c);
  const assist = (ctrl.gunAssist ?? CONFIG.DEFAULTS.gunAssist) * DEG * CONFIG.CREW_ASSIST_SCALE;
  c.assisted = !!c.sol && c.sol.off <= assist && c.sol.dist <= CONFIG.CREW_ASSIST_RANGE;
  // Belt: CREW_BELT rounds, then CREW_RELOAD s to change it.
  if (c.reloadT > 0) {
    c.reloadT -= dt;
    if (c.reloadT <= 0) { c.reloadT = 0; c.ammo = CONFIG.CREW_BELT; g.events.push({ type: 'reloaded', group: 'belt', pos: c.at }); }
  }
  c.firing = !!ctrl.gun && c.ammo > 0 && !(c.reloadT > 0);
  c.acc = c.firing ? c.acc + dt * CONFIG.CREW_RATE : Math.min(c.acc, 1);
  while (c.firing && c.acc >= 1 && c.ammo > 0) {
    c.acc -= 1;
    c.ammo--;
    c.side = -c.side;   // the twin guns take turns
    const d = c.assisted ? c.sol.dir : c.dir;
    const side = vNorm(vCross(d, b.plane.up));
    // (From the muzzles, 3 m out: rounds starting under the eye smear a streak across the view.)
    g.bullets.push({ pos: vAdd(c.at, vAdd(vScale(d, 3), vScale(side, 0.35 * c.side))), vel: vAdd(vScale(d, CONFIG.GUN_SPEED), b.vel), age: 0, owner: 'player', power: CONFIG.CREW_POWER, drop: true, from: b.id });
    g.events.push({ type: 'gun', pos: c.at });
  }
  if (c.ammo <= 0 && !(c.reloadT > 0)) { c.reloadT = CONFIG.CREW_RELOAD; g.events.push({ type: 'reload-start', group: 'belt', pos: c.at }); }
}

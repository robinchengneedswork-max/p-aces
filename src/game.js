// game.js — three modes. 'range': drones to shoot and a chain of rings to fly through.
// 'dogfight' (B): one bandit at a time, flown by ai.js, that shoots back; rookies, then regulars,
// then aces. 'duel': a human on another laptop (g.remote, kept up to date by duel.js); your hits on
// them become 'duel-hit' events for main.js to send, theirs arrive as messages. No respawn there:
// the duel server starts each round. 'escort': several humans (g.remotes) around a bomber formation
// the server flies (escort.js applies its states; g.bombersRemote): your hits on a bomber become
// 'bomber-hit' events for the server to judge. Solo escort (raid.js, g.solo): the same mission on one
// laptop, with AI pilots for the other side and this game flying the bombers. Pure: no DOM. gameUpdate pushes { type, pos } onto g.events.
//
// Bullets and missiles carry an owner ('player' or a bandit id) and hit only the other side.
// Things a missile can chase are { pos, vel, alive }: drones, bandits, bombers, and g.player (you).
// Bombers (N, range and dogfight) are big straight-flying targets that never shoot.

function createGame(seed, mode, planeType) {
  const rng = makeRng(seed || 12345);
  const start = v3(0, 0, 0);
  start.y = groundHeight(0, 0) + CONFIG.START_ALT;
  const g = {
    rng,
    mode: mode || 'range',
    plane: createPlane(start, null, planeType),
    player: { pos: start, vel: v3(0, 0, 0), alive: true, plane: null },
    hp: CONFIG.PLAYER_HP,
    bullets: [],
    missiles: [],
    drones: [],
    bandits: [],
    bombers: [],
    remote: null,                           // duel: the other laptop's plane (duel.js) = remotes[0]
    remotes: [],                            // duel / escort: every other laptop's plane
    ring: null,
    gunAcc: 0,
    missileCd: 0,
    lock: { target: null, time: 0, locked: false },
    warn: { lock: false, missile: null },   // a bandit is locking you / nearest missile coming for you
    respawnT: 0,
    wave: 0, waveT: 1.5,
    score: 0, kills: 0, rings: 0, crashes: 0, deaths: 0,
    events: [],
    nextId: 1,
  };
  syncPlayer(g);
  if (g.mode === 'range') {
    for (let i = 0; i < CONFIG.DRONE_COUNT; i++) spawnDrone(g);
    placeRing(g);
  }
  return g;
}

// Seconds until missile m reaches pos (moving at vel), from the closing speed along the line of sight.
function missileTti(m, pos, vel) {
  const to = vSub(pos, m.pos), d = vLen(to) || 1;
  const closing = vDot(vSub(vScale(m.dir, m.speed), vel), vScale(to, 1 / d));
  return closing > 1 ? d / closing : Infinity;
}

function syncPlayer(g) {
  const P = g.player, p = g.plane;
  P.pos = p.pos;
  P.vel = planeVelocity(p);
  P.alive = !p.crashed && !g.crew;   // (crewing a turret, you are not a plane anyone shoots at)
  P.plane = p;
}

function spawnDrone(g) {
  const p = g.plane;
  const [d0, d1] = CONFIG.DRONE_SPAWN_DIST;
  const ang = (g.rng() - 0.5) * 1.6;
  const dir = vRotate(vNorm(v3(p.fwd.x, 0, p.fwd.z)), WORLD_UP, ang);
  const c = vAdd(p.pos, vScale(dir, d0 + g.rng() * (d1 - d0)));
  c.y = Math.max(groundHeight(c.x, c.z) + 250, p.pos.y + (g.rng() - 0.5) * 400);
  const drone = { id: g.nextId++, kind: 'drone', center: c, radius: 150 + g.rng() * 250, ang: g.rng() * 6.28, dir: g.rng() < 0.5 ? 1 : -1, pos: v3(0, 0, 0), vel: v3(0, 0, 0), alive: true };
  moveDrone(drone, 0);
  g.drones.push(drone);
}

function moveDrone(d, dt) {
  d.ang += d.dir * CONFIG.DRONE_SPEED / d.radius * dt;
  const prev = d.pos;
  d.pos = v3(d.center.x + Math.cos(d.ang) * d.radius, d.center.y + Math.sin(d.ang * 2) * 30, d.center.z + Math.sin(d.ang) * d.radius);
  d.vel = dt > 0 ? vScale(vSub(d.pos, prev), 1 / dt) : v3(0, 0, 0);
}

// Bandits arrive ahead of you, heading roughly at you: a merge.
function waveSkill(wave) {
  return wave <= 2 ? 'rookie' : wave <= 4 ? 'regular' : 'ace';
}

function spawnBandit(g, skill) {
  const p = g.plane;
  const heading = vNorm(v3(p.fwd.x, 0, p.fwd.z));
  const dir = vRotate(heading.x || heading.z ? heading : v3(0, 0, -1), WORLD_UP, (g.rng() - 0.5) * 1.2);
  const pos = vAdd(p.pos, vScale(dir, CONFIG.BANDIT_SPAWN_DIST));
  pos.y = clamp(p.pos.y + (g.rng() - 0.5) * 600, groundHeight(pos.x, pos.z) + 400, CONFIG.CEILING - 300);
  const b = createBandit(g.nextId++, skill, pos, vScale(dir, -1), makeRng(Math.floor(g.rng() * 1e9)), PLANE_ENEMY[g.plane.type]);
  g.bandits.push(b);
  g.events.push({ type: 'bandit', pos, skill });
  return b;
}

// A bomber crossing your nose: its track passes BOMBER_CROSS ahead of you about BOMBER_LEAD_TIME
// after it appears, at 30-150° to your heading, either side. Straight and level from then on.
function spawnBomber(g) {
  const p = g.plane;
  const h = vNorm(v3(p.fwd.x, 0, p.fwd.z));
  const heading = h.x || h.z ? h : v3(0, 0, -1);
  const cross = vAdd(p.pos, vScale(heading, CONFIG.BOMBER_CROSS));
  const ang = (30 + g.rng() * 120) * DEG * (g.rng() < 0.5 ? 1 : -1);
  const dir = vRotate(heading, WORLD_UP, ang);
  const pos = vSub(cross, vScale(dir, CONFIG.BOMBER_SPEED * CONFIG.BOMBER_LEAD_TIME));
  pos.y = clamp(p.pos.y + (g.rng() - 0.5) * 300, groundHeight(pos.x, pos.z) + 500, CONFIG.CEILING - 300);
  const b = makeBomber(g, pos, dir);
  g.events.push({ type: 'bomber', pos });
  return b;
}

// A combat box of bombers (escort mode): lead at centre, the rest stepped back, out and up/down
// (FORMATION, in the lead's frame: right, back, up), all flying heading.
function spawnFormation(g, center, heading) {
  const right = vNorm(vCross(heading, WORLD_UP));
  return CONFIG.FORMATION.map(([x, back, y]) => makeBomber(g, vAdd(center, vAdd(vScale(right, x), vAdd(vScale(heading, -back), v3(0, y, 0)))), heading, CONFIG.FORMATION_SPEED));
}

function makeBomber(g, pos, dir, speed) {
  const plane = createPlane(pos, dir);
  plane.speed = speed || CONFIG.BOMBER_SPEED;
  const b = {
    id: g.nextId++, kind: 'bomber', plane, pos: plane.pos, vel: vScale(plane.fwd, plane.speed),
    hp: CONFIG.BOMBER_HP, maxHp: CONFIG.BOMBER_HP,
    engines: [0, 1, 2, 3].map(() => CONFIG.BOMBER_ENGINE_HP), burning: [false, false, false, false],
    gunners: CONFIG.BOMBER_GUNNERS.map(G => ({ ...G, hp: CONFIG.GUNNER_HP, err: CONFIG.GUNNER_ERR_MAX, los: null, acc: 0, wander: g.rng() * 6.28, firing: false })),
    alive: true, spin: (g.rng() < 0.5 ? -1 : 1) * (0.15 + g.rng() * 0.2),
  };
  g.bombers.push(b);
  return b;
}

// World position of one of a bomber's parts.
function bomberPartPos(b, part) {
  const P = b.plane;
  return vAdd(b.pos, vAdd(vScale(P.right, part.x), vAdd(vScale(P.up, part.y), vScale(P.fwd, -part.z))));
}

// The part of bomber b that segment a→c passes within (its radius + extra), closest first, or null.
function bomberHit(b, a, c, extra) {
  if (segPointDist(a, c, b.pos) > 22 + extra) return null;
  let best = null, bd = Infinity;
  for (const part of CONFIG.BOMBER_PARTS) {
    const d = segPointDist(a, c, bomberPartPos(b, part));
    if (d < part.r + extra && d < bd) { bd = d; best = part; }
  }
  return best;
}

function hitBomber(g, b, dmg, part, pos, how) {
  if (!b.alive) return;
  b.hp -= dmg;
  g.events.push({ type: 'hit', pos });
  if (part && part.zone === 'engine') {
    const i = part.engine;
    b.engines[i] -= dmg;
    if (b.engines[i] <= 0 && !b.burning[i]) { b.burning[i] = true; g.events.push({ type: 'engine-fire', pos }); }
  }
  if (part && part.zone === 'gunner') {
    const gu = b.gunners[part.gunner];
    if (gu.hp > 0 && (gu.hp -= dmg) <= 0) g.events.push({ type: 'gunner-down', pos, name: gu.name });
  }
  if (b.hp <= 0) killBomber(g, b, how);
}

function killBomber(g, b, how) {
  b.alive = false;
  // Yours, unless an AI 109 got it or you're the solo escort (then it's a loss, not a kill).
  if (how !== 'ai' && !(g.solo && g.team === 'escort')) {
    g.kills++;
    g.score += CONFIG.BOMBER_REWARD;
  }
  g.events.push({ type: 'kill', pos: b.pos, bomber: true, how });
}

// The bomber's gunners: each covers its side, leads you like your own sight does, and misses by
// an error that tightens while your line of sight holds steady (see BOMBER_GUNNERS in config).
// Who a gunner can shoot at: g.gunTargets (escort server: the 109) or you.
function gunnerSees(gu, b, Y) {
  const at = bomberPartPos(b, gu);
  const to = vSub(Y.pos, at), dist = vLen(to);
  const u = vScale(to, 1 / (dist || 1));
  const up = vDot(u, b.plane.up), back = -vDot(u, b.plane.fwd);
  const covered = gu.covers === 'up' ? up > -0.1 : gu.covers === 'down' ? up < 0.1 : back > 0.35;
  return { at, to, dist, u, can: Y.alive && covered && dist < CONFIG.GUNNER_RANGE };
}

function updateGunners(g, b, dt) {
  const P = b.plane;
  for (const gu of b.gunners) {
    gu.firing = false;
    if (gu.hp <= 0 || gu.human) continue;   // (human: you crew it, gunner.js)
    // The nearest target it can bear on; a new target starts its aim over.
    let Y = null, best = Infinity;
    for (const t of g.gunTargets || [g.player]) {
      const s = gunnerSees(gu, b, t);
      if (s.can && s.dist < best) { best = s.dist; Y = t; }
    }
    if (Y !== gu.target) { gu.target = Y; gu.los = null; gu.err = CONFIG.GUNNER_ERR_MAX; }
    if (!Y) { gu.acc = Math.min(gu.acc, 1); continue; }
    const { at, to, u, can } = gunnerSees(gu, b, Y);
    // How fast you move across its view (the bomber flies straight, so world = its frame).
    const rate = gu.los && dt > 0 ? Math.acos(clamp(vDot(gu.los, u), -1, 1)) / dt : Infinity;
    gu.los = can ? u : null;
    const steady = can && rate < CONFIG.GUNNER_STEADY;
    const goal = steady ? CONFIG.GUNNER_ERR_MIN : CONFIG.GUNNER_ERR_MAX;
    gu.err += (goal - gu.err) * (1 - Math.exp(-dt / (steady ? CONFIG.GUNNER_SETTLE : CONFIG.GUNNER_UNSETTLE)));
    if (!can) { gu.acc = Math.min(gu.acc, 1); continue; }
    gu.firing = true;
    gu.wander += dt * 0.9;
    gu.acc += dt * CONFIG.GUNNER_RATE;
    while (gu.acc >= 1) {
      gu.acc -= 1;
      // Lead: rounds carry the bomber's velocity, so you drift by (your velocity − its).
      const rel = vSub(Y.vel, b.vel);
      let aim = to;
      for (let i = 0; i < 4; i++) aim = vAdd(to, vScale(rel, vLen(aim) / CONFIG.GUN_SPEED));
      aim = vNorm(aim);
      // Miss by err in a slowly wandering direction (rounds walk round you, then onto you).
      const side = vLen(vCross(aim, WORLD_UP)) > 1e-3 ? vNorm(vCross(aim, WORLD_UP)) : v3(1, 0, 0);
      const vert = vCross(side, aim);
      const s = CONFIG.GUNNER_SPREAD;
      const ox = Math.cos(gu.wander) * Math.tan(gu.err) + (g.rng() - 0.5) * 2 * s;
      const oy = Math.sin(gu.wander) * Math.tan(gu.err) + (g.rng() - 0.5) * 2 * s;
      const dir = vNorm(vAdd(aim, vAdd(vScale(side, ox), vScale(vert, oy))));
      g.bullets.push({ pos: at, vel: vAdd(vScale(dir, CONFIG.GUN_SPEED), b.vel), age: 0, owner: 'bomber', power: CONFIG.GUNNER_POWER });
      g.events.push({ type: 'enemy-gun', pos: at });
    }
  }
}

// Alive: straight and level, burning engines eat its HP. Shot down: it noses over, rolls and
// falls burning until it hits the ground.
function updateBombers(g, dt) {
  for (const b of g.bombers) {
    const P = b.plane;
    if (b.alive) {
      const fires = b.burning.filter(Boolean).length;
      if (fires) { b.hp -= fires * CONFIG.BOMBER_BURN * dt; if (b.hp <= 0) killBomber(g, b, 'fire'); }
      if (g.mode !== 'escort' && vDist(b.pos, g.plane.pos) > CONFIG.BOMBER_MAX_DIST) b.gone = true;
      if (b.alive) updateGunners(g, b, dt);
    } else {
      // Nose toward the ground (world down, not its own belly: it is rolling as it falls).
      const axis = vCross(P.fwd, v3(0, -1, 0));
      if (P.fwd.y > -0.75 && vLen(axis) > 1e-3) rotatePlane(P, vNorm(axis), 0.3 * dt);
      rotatePlane(P, P.fwd, b.spin * dt);
      P.fwd = vNorm(P.fwd);
      P.right = vNorm(vCross(P.fwd, P.up));
      P.up = vCross(P.right, P.fwd);
      P.speed = Math.min(P.speed + 12 * dt, 230);
      if (P.pos.y < groundHeight(P.pos.x, P.pos.z)) { b.gone = true; g.events.push({ type: 'bomber-crash', pos: P.pos }); }
    }
    P.path = { ...P.fwd };
    P.pos = vAdd(P.pos, vScale(P.fwd, P.speed * dt));
    b.pos = P.pos;
    b.vel = vScale(P.fwd, P.speed);
  }
  g.bombers = g.bombers.filter(b => !b.gone);
}

function placeRing(g) {
  const p = g.plane;
  const from = g.ring ? g.ring.pos : p.pos;
  const heading = g.ring ? g.ring.normal : vNorm(v3(p.fwd.x, 0, p.fwd.z));
  const dir = vRotate(heading, WORLD_UP, (g.rng() - 0.5) * 1.2);
  const pos = vAdd(from, vScale(dir, CONFIG.RING_AHEAD));
  pos.y = clamp(from.y + (g.rng() - 0.5) * 350, groundHeight(pos.x, pos.z) + 150, CONFIG.CEILING - 200);
  g.ring = { pos, normal: vNorm(v3(dir.x, 0, dir.z)) };
}

function lockables(g) {
  return g.drones.concat(g.bandits, g.bombers, g.remotes).filter(t => t.alive);
}

function updateLock(g, dt) {
  const p = g.plane;
  let best = null, bestAng = CONFIG.LOCK_CONE;
  for (const d of lockables(g)) {
    const to = vSub(d.pos, p.pos);
    const dist = vLen(to);
    if (dist > CONFIG.LOCK_RANGE) continue;
    const ang = Math.acos(clamp(vDot(vScale(to, 1 / dist), p.fwd), -1, 1));
    if (ang < bestAng) { bestAng = ang; best = d; }
  }
  const L = g.lock;
  if (best !== L.target) { L.target = best; L.time = 0; L.locked = false; }
  if (best) {
    L.time += dt;
    if (!L.locked && L.time >= CONFIG.LOCK_TIME) { L.locked = true; g.events.push({ type: 'lock', pos: best.pos }); }
  }
}

function killDrone(g, d, how) {
  d.alive = false;
  g.kills++;
  g.score += how === 'missile' ? 100 : 150;
  g.events.push({ type: 'kill', pos: d.pos });
}

function hitBandit(g, b, dmg, how) {
  if (!b.alive) return;
  b.hp -= dmg;
  g.events.push({ type: 'hit', pos: b.pos });
  if (b.hp <= 0) killBandit(g, b, how);
}

function killBandit(g, b, how) {
  b.alive = false;
  if (how !== 'gunner') {   // the bombers' gunners (solo escort) don't score for you
    g.kills++;
    g.score += how === 'crashed' ? Math.round(SKILLS[b.skill].reward / 2) : SKILLS[b.skill].reward;
  }
  g.waveT = CONFIG.WAVE_GAP;
  g.events.push({ type: 'kill', pos: b.pos, bandit: true, how, skill: b.skill, team: b.team });
}

function hurtPlayer(g, dmg, pos) {
  if (g.plane.crashed) return;
  g.hp = Math.max(0, g.hp - dmg);
  g.events.push({ type: 'hurt', pos, dmg });
  if (g.hp === 0) {
    g.plane.crashed = true;
    g.plane.shotDown = true;
  }
}

// Gun firing solution: the best target ahead (closest to the nose, within GUN_LEAD_CONE and
// GUN_LEAD_RANGE) and the direction to fire so the rounds meet it. Rounds carry the plane's own
// velocity, so in the plane's moving frame the target drifts by (its velocity − ours); solve for
// where it will be after the rounds' flight time (a few fixed-point steps converge).
// → { target, dir, dist, off (angle between nose and dir), inRange } or null.
function gunSolution(g) {
  const p = g.plane;
  if (p.crashed) return null;   // (WW2: worked out for the hidden assist, but not drawn)
  const pv = planeVelocity(p), gunSpeed = p.spec.GUNS ? p.spec.GUNS[0].speed : CONFIG.GUN_SPEED;
  let best = null;
  for (const t of lockables(g)) {
    if (typeof escortFriend === 'function' && escortFriend(g, t)) continue;   // never pull rounds onto a friend
    const to = vSub(t.pos, p.pos), dist = vLen(to);
    if (dist > CONFIG.GUN_LEAD_RANGE || dist < 1) continue;
    const rel = vSub(t.vel || v3(0, 0, 0), pv);
    let aim = to;
    for (let i = 0; i < 4; i++) aim = vAdd(to, vScale(rel, vLen(aim) / gunSpeed));
    const dir = vNorm(aim);
    const off = Math.acos(clamp(vDot(dir, p.fwd), -1, 1));
    if (off > CONFIG.GUN_LEAD_CONE) continue;
    if (!best || off < best.off) best = { target: t, dir, dist, off, inRange: dist <= CONFIG.GUN_RANGE };
  }
  return best;
}

// A WW2 plane's guns (spec.GUNS): each gun fires from its own spot on the wing or cowl, aimed to
// cross the nose line at CONVERGENCE. triggers = { mg, cannon } (cannon fires everything).
// ammo: false = unlimited (AI). aim: the assist's direction (the guns converge on it instead of the
// nose line), or null. Rounds carry power and drop under gravity. Returns the groups fired.
function fireGuns(g, p, triggers, dt, owner, ammo, aim) {
  const S = p.spec, fired = { mg: false, cannon: false };
  const conv = vScale(aim || p.fwd, S.CONVERGENCE);
  S.GUNS.forEach((gn, i) => {
    const on = gn.group === 'cannon' ? triggers.cannon : (triggers.mg || triggers.cannon);
    if (!on || (ammo && p.ammo[i] <= 0)) { p.gunAcc[i] = Math.min(p.gunAcc[i], 1); return; }
    p.gunAcc[i] += dt * gn.rate;
    while (p.gunAcc[i] >= 1 && (!ammo || p.ammo[i] > 0)) {
      p.gunAcc[i] -= 1;
      if (ammo) p.ammo[i]--;
      const off = vAdd(vScale(p.right, gn.x), vScale(p.up, gn.y));
      const dir = vNorm(vSub(conv, off));
      g.bullets.push({ pos: vAdd(p.pos, off), vel: vAdd(vScale(dir, gn.speed), planeVelocity(p)), age: 0, owner, power: gn.power, drop: true, group: gn.group });
      fired[gn.group] = true;
    }
  });
  return fired;
}

// Reloading (settings.reload): a gun group that has run dry (all its guns empty) is rearmed
// RELOAD[group] s later. p.reloadT[group] = seconds left while it's at it.
function reloadGuns(g, p, dt) {
  p.reloadT = p.reloadT || {};
  for (const grp of ['mg', 'cannon']) {
    const idx = p.spec.GUNS.map((gn, i) => gn.group === grp ? i : -1).filter(i => i >= 0);
    if (!idx.length) continue;
    if (!(p.reloadT[grp] > 0)) {
      if (idx.every(i => p.ammo[i] <= 0)) { p.reloadT[grp] = CONFIG.RELOAD[grp]; g.events.push({ type: 'reload-start', group: grp, pos: p.pos }); }
      continue;
    }
    p.reloadT[grp] -= dt;
    if (p.reloadT[grp] <= 0) {
      p.reloadT[grp] = 0;
      for (const i of idx) p.ammo[i] = p.spec.GUNS[i].ammo;
      g.events.push({ type: 'reloaded', group: grp, pos: p.pos });
    }
  }
}

function fireBullet(g, from, dir, owner) {
  const side = (g.bullets.length % 2 ? 1 : -1) * 3;
  g.bullets.push({ pos: vAdd(from.pos, vScale(from.right, side)), vel: vAdd(vScale(dir, CONFIG.GUN_SPEED), planeVelocity(from)), age: 0, owner });
}

function respawnPlayer(g) {
  const p = g.plane;
  const pos = v3(p.pos.x, 0, p.pos.z);
  pos.y = groundHeight(pos.x, pos.z) + CONFIG.START_ALT;
  g.plane = createPlane(pos, p.fwd, p.type);
  g.hp = CONFIG.PLAYER_HP;
  g.respawnT = 0;
  if (g.mode === 'range') {
    g.ring = null;
    placeRing(g);
  } else {
    // Start the fight again fresh: same wave, a new merge.
    g.bandits = [];
    g.missiles = g.missiles.filter(m => m.owner === 'player');
    g.waveT = 1.5;
    g.wave = Math.max(0, g.wave - 1);
  }
}

function gameUpdate(g, ctrl, dt) {
  const p = g.plane;
  g.events.length = 0;

  if (g.crew) crewStep(g, ctrl, dt);   // in a bomber's turret (gunner.js): no flying
  else if (p.crashed) {
    if (g.respawnT === 0) {
      if (p.shotDown) g.deaths++; else g.crashes++;
      g.events.push({ type: p.shotDown ? 'shot-down' : 'crash', pos: p.pos });
    }
    g.respawnT += dt;
    if (g.respawnT >= CONFIG.RESPAWN_TIME && g.mode !== 'duel' && g.mode !== 'escort') respawnPlayer(g);   // escort.js respawns there
  } else {
    const before = p.pos;
    flightStep(p, ctrl, dt, ctrl.assist);
    if (g.mode === 'range') updateRing(g, before);

    // Gun. Magnetism: with the sight within the assist angle of the lead marker (and close enough),
    // the rounds go to the marker.
    g.gunSol = gunSolution(g);
    const assist = (ctrl.gunAssist ?? CONFIG.DEFAULTS.gunAssist) * DEG * (p.spec.ASSIST_SCALE || 1), sol = g.gunSol;
    g.gunAssisted = !!sol && sol.off <= assist && sol.dist <= p.spec.GUN_ASSIST_RANGE;
    if (p.spec.GUNS) {
      const fired = fireGuns(g, p, { mg: ctrl.gun, cannon: ctrl.cannon }, dt, 'player', true, g.gunAssisted ? sol.dir : null);
      if (fired.mg) g.events.push({ type: 'gun', pos: p.pos });
      if (fired.cannon) g.events.push({ type: 'cannon', pos: p.pos });
      if (ctrl.reload) reloadGuns(g, p, dt);
    } else {
      g.gunAcc = ctrl.gun ? g.gunAcc + dt * CONFIG.GUN_RATE : Math.min(g.gunAcc, 1);
      while (ctrl.gun && g.gunAcc >= 1) {
        g.gunAcc -= 1;
        fireBullet(g, p, g.gunAssisted ? sol.dir : p.fwd, 'player');
        g.events.push({ type: 'gun', pos: p.pos });
      }
    }

    // Missile: fires at the locked target, or dumb if there's no lock. (No missiles in WW2.)
    g.missileCd = Math.max(0, g.missileCd - dt);
    if (p.spec.MISSILES !== false) updateLock(g, dt);
    if (ctrl.missile && g.missileCd === 0 && p.spec.MISSILES !== false) {
      g.missileCd = CONFIG.MISSILE_COOLDOWN;
      const target = g.lock.locked ? g.lock.target : null;
      g.missiles.push({ id: g.nextId++, pos: vAdd(p.pos, vScale(p.up, -3)), dir: p.fwd, speed: p.speed + 40, target, age: 0, owner: 'player', turn: CONFIG.MISSILE_TURN });
      g.events.push({ type: 'missile', pos: p.pos });
    }
  }
  syncPlayer(g);
  if (p.crashed) { g.gunSol = null; g.gunAssisted = false; }

  if (g.mode === 'dogfight') updateBandits(g, dt);
  if (g.solo) raidAi(g, dt);
  if (!g.bombersRemote) updateBombers(g, dt);   // escort: the server flies them (escort.js)
  updateBullets(g, dt);
  updateMissiles(g, dt);

  if (g.mode === 'range') {
    for (const d of g.drones) moveDrone(d, dt);
    g.drones = g.drones.filter(d => d.alive && vDist(d.pos, g.plane.pos) < CONFIG.DRONE_MAX_DIST);
    while (g.drones.length < CONFIG.DRONE_COUNT) spawnDrone(g);
  }
  if (g.lock.target && !g.lock.target.alive) g.lock = { target: null, time: 0, locked: false };
  if (g.solo) raidRules(g, dt);
  return g;
}

// Ring: crossed its plane this frame, inside the radius.
function updateRing(g, before) {
  const p = g.plane, r = g.ring;
  const s0 = vDot(vSub(before, r.pos), r.normal), s1 = vDot(vSub(p.pos, r.pos), r.normal);
  if (s0 < 0 && s1 >= 0) {
    const t = s0 / (s0 - s1);
    const cross = vAdd(before, vScale(vSub(p.pos, before), t));
    if (vDist(cross, r.pos) <= CONFIG.RING_R) {
      g.rings++;
      g.score += 50;
      g.events.push({ type: 'ring', pos: r.pos });
    } else {
      g.events.push({ type: 'ring-miss', pos: r.pos });
    }
    placeRing(g);
  } else if (vDist(p.pos, r.pos) > CONFIG.RING_AHEAD * 3) {
    g.ring = null;
    placeRing(g);
  }
}

function updateBandits(g, dt) {
  const P = g.player;
  g.warn.lock = false;
  for (const b of g.bandits) {
    if (!b.alive) continue;
    const threats = [];
    for (const m of g.missiles) {
      if (m.owner !== 'player' || m.target !== b) continue;
      threats.push({ ref: m, pos: m.pos, tti: missileTti(m, b.pos, b.vel), dist: vDist(m.pos, b.pos) });
    }
    const w = flyBandit(g, b, P.alive ? P : null, threats, dt);
    if (!w) continue;

    // Missiles: hold you in the cone for ENEMY_LOCK_TIME (you get LOCK WARNING), then launch.
    b.missileCd = Math.max(0, b.missileCd - dt);
    b.lockT = w.lockOn && P.alive && b.plane.spec.MISSILES !== false ? b.lockT + dt : 0;
    if (b.lockT > 0) g.warn.lock = true;
    if (b.lockT >= CONFIG.ENEMY_LOCK_TIME && b.missileCd === 0) {
      b.missileCd = SKILLS[b.skill].missileCd;
      b.lockT = 0;
      g.missiles.push({ pos: vAdd(b.pos, vScale(b.plane.up, -3)), dir: b.plane.fwd, speed: b.plane.speed + 40, target: P, age: 0, owner: b.id, turn: CONFIG.ENEMY_MISSILE_TURN });
      g.events.push({ type: 'enemy-missile', pos: b.pos });
    }
  }
  g.bandits = g.bandits.filter(b => b.alive);   // never culled by distance: it's the fight, and it hunts you
  if (!g.bandits.length && P.alive) {
    g.waveT -= dt;
    if (g.waveT <= 0) {
      g.wave++;
      spawnBandit(g, waveSkill(g.wave));
      g.waveT = CONFIG.WAVE_GAP;
    }
  }
}

// One bandit's turn: its pilot flies it at target ({ pos, vel, plane? }, null = patrol) and it fires
// its guns when it has a shot (holdFire: never). Returns the pilot's wishes, or null if it crashed.
function flyBandit(g, b, target, threats, dt, holdFire) {
  const w = pilotStep(b, target, threats, dt);
  flightStep(b.plane, w, dt, false);
  b.pos = b.plane.pos;
  b.vel = planeVelocity(b.plane);
  if (b.plane.crashed) { killBandit(g, b, 'crashed'); return null; }

  // Guns: bursts while it has a solution, a little spread. WW2 bandits fire their real guns
  // (unlimited ammo), cannons only when the shot is good.
  b.firing = w.fire && !!target && !holdFire;
  if (b.plane.spec.GUNS) {
    const fired = fireGuns(g, b.plane, { mg: b.firing, cannon: b.firing && w.good }, dt, b.id, false);
    if (fired.mg || fired.cannon) g.events.push({ type: 'enemy-gun', pos: b.pos });
  }
  const jetGun = b.firing && !b.plane.spec.GUNS;
  b.gunAcc = jetGun ? b.gunAcc + dt * CONFIG.BANDIT_GUN_RATE : Math.min(b.gunAcc, 1);
  while (jetGun && b.gunAcc >= 1) {
    b.gunAcc -= 1;
    const s = CONFIG.BANDIT_GUN_SPREAD;
    let dir = vRotate(b.plane.fwd, b.plane.up, (b.rng() - 0.5) * 2 * s);
    dir = vRotate(dir, b.plane.right, (b.rng() - 0.5) * 2 * s);
    fireBullet(g, b.plane, dir, b.id);
    g.events.push({ type: 'enemy-gun', pos: b.pos });
  }
  return w;
}

function updateBullets(g, dt) {
  for (const b of g.bullets) {
    const prev = b.pos;
    if (b.drop) b.vel = vAdd(b.vel, v3(0, -9.81 * dt, 0));
    b.pos = vAdd(b.pos, vScale(b.vel, dt));
    b.age += dt;
    const power = b.power ?? 1;
    if (b.owner === 'player') {
      for (const d of g.drones) {
        if (d.alive && segPointDist(prev, b.pos, d.pos) < CONFIG.DRONE_R) { killDrone(g, d, 'gun'); b.age = 99; break; }
      }
      for (const t of g.bandits) {
        if (t.alive && segPointDist(prev, b.pos, t.pos) < (t.plane.spec.HIT_R ?? CONFIG.BANDIT_R)) { hitBandit(g, t, power, 'gun'); b.age = 99; break; }
      }
      for (const t of g.bombers) {
        const part = b.age < 99 && t.alive && t.id !== b.from && bomberHit(t, prev, b.pos, 0);   // (from: your own bomber, crewing it)
        if (!part) continue;
        // Escort: the server keeps the bombers; tell it (and show the spark here).
        if (g.bombersRemote) g.events.push({ type: 'bomber-hit', id: t.id, part: CONFIG.BOMBER_PARTS.indexOf(part), dmg: power, pos: b.pos }, { type: 'hit', pos: b.pos });
        else hitBomber(g, t, power, part, b.pos, 'gun');
        b.age = 99;
        break;
      }
      // Other laptops' planes (friend or foe: there's friendly fire). Their laptop takes the hit.
      for (const R of g.remotes) {
        if (b.age < 99 && R.alive && segPointDist(prev, b.pos, R.pos) < (R.plane.spec.HIT_R ?? CONFIG.DUEL_HIT_R)) {
          g.events.push({ type: 'duel-hit', dmg: CONFIG.BANDIT_GUN_DMG * power, pos: b.pos, to: R.peer });
          b.age = 99;
        }
      }
    } else if (b.owner === 'remote') {
      // The other laptop's rounds: drawn here, but only their laptop decides what they hit.
    } else {
      if (g.solo) raidBulletHits(g, b, prev, power);   // gunners vs AI 109s, AI 109s vs bombers
      if (b.age < 99 && g.player.alive && segPointDist(prev, b.pos, g.plane.pos) < (g.plane.spec.HIT_R ?? CONFIG.PLANE_HIT_R)) {
        hurtPlayer(g, CONFIG.BANDIT_GUN_DMG * power, b.pos);
        b.age = 99;
      }
    }
    if (b.pos.y < groundHeight(b.pos.x, b.pos.z)) b.age = 99;
  }
  g.bullets = g.bullets.filter(b => b.age < CONFIG.GUN_LIFE);
}

function updateMissiles(g, dt) {
  g.warn.missile = null;
  for (const m of g.missiles) {
    if (m.remote) {
      // Flown by the other laptop (duel.js moves it); here it only raises your warning.
      if (m.tracking && g.player.alive) {
        const tti = missileTti(m, g.plane.pos, g.player.vel);
        if (!g.warn.missile || tti < g.warn.missile.tti) g.warn.missile = { pos: m.pos, tti, dist: vDist(m.pos, g.plane.pos) };
      }
      continue;
    }
    const prev = m.pos;
    m.age += dt;
    m.speed = Math.min(CONFIG.MISSILE_SPEED + 180, m.speed + 300 * dt);
    if (m.target && m.target.alive) {
      // Steer at the target (pure pursuit unless m.lead), limited turn rate. Out past the gimbal = lost you.
      const tti = vDist(m.target.pos, m.pos) / m.speed;
      const aim = vNorm(vSub(vAdd(m.target.pos, vScale(m.target.vel, tti * (m.lead || 0))), m.pos));
      const ang = Math.acos(clamp(vDot(m.dir, aim), -1, 1));
      if (ang > CONFIG.MISSILE_GIMBAL) m.target = null;
      else if (ang > 1e-4) {
        const axis = vNorm(vCross(m.dir, aim));
        m.dir = vNorm(vRotate(m.dir, axis, Math.min(ang, m.turn * dt)));
      }
    }
    m.pos = vAdd(m.pos, vScale(m.dir, m.speed * dt));
    if (m.owner === 'player') {
      for (const d of g.drones) {
        if (d.alive && segPointDist(prev, m.pos, d.pos) < CONFIG.DRONE_R * 1.5) { killDrone(g, d, 'missile'); m.age = 99; break; }
      }
      for (const R of g.remotes) {
        if (R.alive && m.age < 99 && segPointDist(prev, m.pos, R.pos) < CONFIG.MISSILE_FUSE) {
          g.events.push({ type: 'duel-hit', dmg: CONFIG.ENEMY_MISSILE_DMG, pos: m.pos, to: R.peer }, { type: 'boom', pos: m.pos });
          m.age = 99;
        }
      }
      for (const t of g.bombers) {
        const part = m.age < 99 && t.alive && bomberHit(t, prev, m.pos, CONFIG.MISSILE_FUSE);
        if (part) {
          hitBomber(g, t, CONFIG.BOMBER_MISSILE_DMG, part, m.pos, 'missile');
          g.events.push({ type: 'boom', pos: m.pos });
          m.age = 99;
          break;
        }
      }
      for (const t of g.bandits) {
        if (m.age < 99 && t.alive && segPointDist(prev, m.pos, t.pos) < CONFIG.MISSILE_FUSE) {
          hitBandit(g, t, CONFIG.MISSILE_DMG, 'missile');
          g.events.push({ type: 'boom', pos: m.pos });
          m.age = 99;
          break;
        }
      }
    } else {
      if (g.player.alive && segPointDist(prev, m.pos, g.plane.pos) < CONFIG.MISSILE_FUSE) {
        hurtPlayer(g, CONFIG.ENEMY_MISSILE_DMG, m.pos);
        g.events.push({ type: 'boom', pos: m.pos });
        m.age = 99;
      } else if (m.target && m.age < 99) {
        const tti = missileTti(m, g.plane.pos, g.player.vel);
        if (!g.warn.missile || tti < g.warn.missile.tti) g.warn.missile = { pos: m.pos, tti, dist: vDist(m.pos, g.plane.pos) };
      }
    }
    if (m.pos.y < groundHeight(m.pos.x, m.pos.z)) { m.age = 99; g.events.push({ type: 'boom', pos: m.pos }); }
  }
  g.missiles = g.missiles.filter(m => m.remote || m.age < CONFIG.MISSILE_LIFE);
}

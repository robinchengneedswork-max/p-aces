// game.js — three modes. 'range': drones to shoot and a chain of rings to fly through.
// 'dogfight' (B): one bandit at a time, flown by ai.js, that shoots back; rookies, then regulars,
// then aces. 'duel': a human on another laptop (g.remote, kept up to date by duel.js); your hits on
// them become 'duel-hit' events for main.js to send, theirs arrive as messages. No respawn there:
// the duel server starts each round. Pure: no DOM. gameUpdate pushes { type, pos } onto g.events.
//
// Bullets and missiles carry an owner ('player' or a bandit id) and hit only the other side.
// Things a missile can chase are { pos, vel, alive }: drones, bandits, and g.player (you).

function createGame(seed, mode) {
  const rng = makeRng(seed || 12345);
  const start = v3(0, 0, 0);
  start.y = groundHeight(0, 0) + CONFIG.START_ALT;
  const g = {
    rng,
    mode: mode || 'range',
    plane: createPlane(start),
    player: { pos: start, vel: v3(0, 0, 0), alive: true, plane: null },
    hp: CONFIG.PLAYER_HP,
    bullets: [],
    missiles: [],
    drones: [],
    bandits: [],
    remote: null,                           // duel: the other laptop's plane (duel.js)
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
  P.alive = !p.crashed;
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
  const b = createBandit(g.nextId++, skill, pos, vScale(dir, -1), makeRng(Math.floor(g.rng() * 1e9)));
  g.bandits.push(b);
  g.events.push({ type: 'bandit', pos, skill });
  return b;
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
  return g.drones.concat(g.bandits, g.remote ? [g.remote] : []).filter(t => t.alive);
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
  g.kills++;
  g.score += how === 'crashed' ? Math.round(SKILLS[b.skill].reward / 2) : SKILLS[b.skill].reward;
  g.waveT = CONFIG.WAVE_GAP;
  g.events.push({ type: 'kill', pos: b.pos, bandit: true, how, skill: b.skill });
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

function fireBullet(g, from, dir, owner) {
  const side = (g.bullets.length % 2 ? 1 : -1) * 3;
  g.bullets.push({ pos: vAdd(from.pos, vScale(from.right, side)), vel: vAdd(vScale(dir, CONFIG.GUN_SPEED), planeVelocity(from)), age: 0, owner });
}

function respawnPlayer(g) {
  const p = g.plane;
  const pos = v3(p.pos.x, 0, p.pos.z);
  pos.y = groundHeight(pos.x, pos.z) + CONFIG.START_ALT;
  g.plane = createPlane(pos, p.fwd);
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

  if (p.crashed) {
    if (g.respawnT === 0) {
      if (p.shotDown) g.deaths++; else g.crashes++;
      g.events.push({ type: p.shotDown ? 'shot-down' : 'crash', pos: p.pos });
    }
    g.respawnT += dt;
    if (g.respawnT >= CONFIG.RESPAWN_TIME && g.mode !== 'duel') respawnPlayer(g);
  } else {
    const before = p.pos;
    flightStep(p, ctrl, dt, ctrl.assist);
    if (g.mode === 'range') updateRing(g, before);

    // Gun
    g.gunAcc = ctrl.gun ? g.gunAcc + dt * CONFIG.GUN_RATE : Math.min(g.gunAcc, 1);
    while (ctrl.gun && g.gunAcc >= 1) {
      g.gunAcc -= 1;
      fireBullet(g, p, p.fwd, 'player');
      g.events.push({ type: 'gun', pos: p.pos });
    }

    // Missile: fires at the locked target, or dumb if there's no lock.
    g.missileCd = Math.max(0, g.missileCd - dt);
    updateLock(g, dt);
    if (ctrl.missile && g.missileCd === 0) {
      g.missileCd = CONFIG.MISSILE_COOLDOWN;
      const target = g.lock.locked ? g.lock.target : null;
      g.missiles.push({ id: g.nextId++, pos: vAdd(p.pos, vScale(p.up, -3)), dir: p.fwd, speed: p.speed + 40, target, age: 0, owner: 'player', turn: CONFIG.MISSILE_TURN });
      g.events.push({ type: 'missile', pos: p.pos });
    }
  }
  syncPlayer(g);

  if (g.mode === 'dogfight') updateBandits(g, dt);
  updateBullets(g, dt);
  updateMissiles(g, dt);

  if (g.mode === 'range') {
    for (const d of g.drones) moveDrone(d, dt);
    g.drones = g.drones.filter(d => d.alive && vDist(d.pos, g.plane.pos) < CONFIG.DRONE_MAX_DIST);
    while (g.drones.length < CONFIG.DRONE_COUNT) spawnDrone(g);
  }
  if (g.lock.target && !g.lock.target.alive) g.lock = { target: null, time: 0, locked: false };
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
    const w = pilotStep(b, P.alive ? P : null, threats, dt);
    flightStep(b.plane, w, dt, false);
    b.pos = b.plane.pos;
    b.vel = planeVelocity(b.plane);
    if (b.plane.crashed) { killBandit(g, b, 'crashed'); continue; }

    // Guns: bursts while it has a solution, a little spread.
    b.firing = w.fire && P.alive;
    b.gunAcc = b.firing ? b.gunAcc + dt * CONFIG.BANDIT_GUN_RATE : Math.min(b.gunAcc, 1);
    while (b.firing && b.gunAcc >= 1) {
      b.gunAcc -= 1;
      const s = CONFIG.BANDIT_GUN_SPREAD;
      let dir = vRotate(b.plane.fwd, b.plane.up, (b.rng() - 0.5) * 2 * s);
      dir = vRotate(dir, b.plane.right, (b.rng() - 0.5) * 2 * s);
      fireBullet(g, b.plane, dir, b.id);
      g.events.push({ type: 'enemy-gun', pos: b.pos });
    }

    // Missiles: hold you in the cone for ENEMY_LOCK_TIME (you get LOCK WARNING), then launch.
    b.missileCd = Math.max(0, b.missileCd - dt);
    b.lockT = w.lockOn && P.alive ? b.lockT + dt : 0;
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

function updateBullets(g, dt) {
  for (const b of g.bullets) {
    const prev = b.pos;
    b.pos = vAdd(b.pos, vScale(b.vel, dt));
    b.age += dt;
    if (b.owner === 'player') {
      for (const d of g.drones) {
        if (d.alive && segPointDist(prev, b.pos, d.pos) < CONFIG.DRONE_R) { killDrone(g, d, 'gun'); b.age = 99; break; }
      }
      for (const t of g.bandits) {
        if (t.alive && segPointDist(prev, b.pos, t.pos) < CONFIG.BANDIT_R) { hitBandit(g, t, 1, 'gun'); b.age = 99; break; }
      }
      const R = g.remote;
      if (b.age < 99 && R && R.alive && segPointDist(prev, b.pos, R.pos) < CONFIG.DUEL_HIT_R) {
        g.events.push({ type: 'duel-hit', dmg: CONFIG.BANDIT_GUN_DMG, pos: b.pos });
        b.age = 99;
      }
    } else if (b.owner === 'remote') {
      // The other laptop's rounds: drawn here, but only their laptop decides what they hit.
    } else if (g.player.alive && segPointDist(prev, b.pos, g.plane.pos) < CONFIG.PLANE_HIT_R) {
      hurtPlayer(g, CONFIG.BANDIT_GUN_DMG, b.pos);
      b.age = 99;
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
      const R = g.remote;
      if (R && R.alive && m.age < 99 && segPointDist(prev, m.pos, R.pos) < CONFIG.MISSILE_FUSE) {
        g.events.push({ type: 'duel-hit', dmg: CONFIG.ENEMY_MISSILE_DMG, pos: m.pos }, { type: 'boom', pos: m.pos });
        m.age = 99;
      }
      for (const t of g.bandits) {
        if (t.alive && segPointDist(prev, m.pos, t.pos) < CONFIG.MISSILE_FUSE) {
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

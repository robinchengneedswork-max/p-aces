// game.js — the test range: drones to shoot, a chain of rings to fly through. Pure: no DOM.
// gameUpdate pushes { type, pos } onto g.events for audio/render to consume each frame.

function createGame(seed) {
  const rng = makeRng(seed || 12345);
  const start = v3(0, 0, 0);
  start.y = groundHeight(0, 0) + CONFIG.START_ALT;
  const g = {
    rng,
    plane: createPlane(start),
    bullets: [],
    missiles: [],
    drones: [],
    ring: null,
    gunAcc: 0,
    missileCd: 0,
    lock: { target: null, time: 0, locked: false },
    respawnT: 0,
    score: 0, kills: 0, rings: 0, crashes: 0,
    events: [],
    nextId: 1,
  };
  for (let i = 0; i < CONFIG.DRONE_COUNT; i++) spawnDrone(g);
  placeRing(g);
  return g;
}

function spawnDrone(g) {
  const p = g.plane;
  const [d0, d1] = CONFIG.DRONE_SPAWN_DIST;
  const ang = (g.rng() - 0.5) * 1.6;
  const dir = vRotate(vNorm(v3(p.fwd.x, 0, p.fwd.z)), WORLD_UP, ang);
  const c = vAdd(p.pos, vScale(dir, d0 + g.rng() * (d1 - d0)));
  c.y = Math.max(groundHeight(c.x, c.z) + 250, p.pos.y + (g.rng() - 0.5) * 400);
  const drone = { id: g.nextId++, center: c, radius: 150 + g.rng() * 250, ang: g.rng() * 6.28, dir: g.rng() < 0.5 ? 1 : -1, pos: v3(0, 0, 0), vel: v3(0, 0, 0), alive: true };
  moveDrone(drone, 0);
  g.drones.push(drone);
}

function moveDrone(d, dt) {
  d.ang += d.dir * CONFIG.DRONE_SPEED / d.radius * dt;
  const prev = d.pos;
  d.pos = v3(d.center.x + Math.cos(d.ang) * d.radius, d.center.y + Math.sin(d.ang * 2) * 30, d.center.z + Math.sin(d.ang) * d.radius);
  d.vel = dt > 0 ? vScale(vSub(d.pos, prev), 1 / dt) : v3(0, 0, 0);
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

function updateLock(g, dt) {
  const p = g.plane;
  let best = null, bestAng = CONFIG.LOCK_CONE;
  for (const d of g.drones) {
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

function gameUpdate(g, ctrl, dt) {
  const p = g.plane;
  g.events.length = 0;

  if (p.crashed) {
    if (g.respawnT === 0) { g.crashes++; g.events.push({ type: 'crash', pos: p.pos }); }
    g.respawnT += dt;
    if (g.respawnT >= CONFIG.RESPAWN_TIME) {
      const pos = v3(p.pos.x, 0, p.pos.z);
      pos.y = groundHeight(pos.x, pos.z) + CONFIG.START_ALT;
      const heading = vNorm(v3(p.fwd.x, 0, p.fwd.z));
      g.plane = createPlane(pos);
      g.plane.fwd = heading.x || heading.z ? heading : v3(0, 0, -1);
      g.plane.right = vNorm(vCross(g.plane.fwd, WORLD_UP));
      g.plane.up = vCross(g.plane.right, g.plane.fwd);
      g.respawnT = 0;
      g.ring = null;
      placeRing(g);
    }
  } else {
    const before = p.pos;
    flightStep(p, ctrl, dt, ctrl.assist);

    // Ring: crossed its plane this frame, inside the radius.
    const r = g.ring;
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

    // Gun
    g.gunAcc = ctrl.gun ? g.gunAcc + dt * CONFIG.GUN_RATE : Math.min(g.gunAcc, 1);
    while (ctrl.gun && g.gunAcc >= 1) {
      g.gunAcc -= 1;
      const side = (g.bullets.length % 2 ? 1 : -1) * 3;
      g.bullets.push({ pos: vAdd(p.pos, vScale(p.right, side)), vel: vAdd(vScale(p.fwd, CONFIG.GUN_SPEED), vScale(p.fwd, p.speed)), age: 0 });
      g.events.push({ type: 'gun', pos: p.pos });
    }

    // Missile: needs a lock; fires at the locked drone.
    g.missileCd = Math.max(0, g.missileCd - dt);
    updateLock(g, dt);
    if (ctrl.missile && g.missileCd === 0) {
      g.missileCd = CONFIG.MISSILE_COOLDOWN;
      const target = g.lock.locked ? g.lock.target : null;
      g.missiles.push({ pos: vAdd(p.pos, vScale(p.up, -3)), dir: p.fwd, speed: p.speed + 40, target, age: 0 });
      g.events.push({ type: 'missile', pos: p.pos });
    }
  }

  for (const b of g.bullets) {
    const prev = b.pos;
    b.pos = vAdd(b.pos, vScale(b.vel, dt));
    b.age += dt;
    for (const d of g.drones) {
      if (d.alive && segPointDist(prev, b.pos, d.pos) < CONFIG.DRONE_R) { killDrone(g, d, 'gun'); b.age = 99; break; }
    }
    if (b.pos.y < groundHeight(b.pos.x, b.pos.z)) b.age = 99;
  }
  g.bullets = g.bullets.filter(b => b.age < CONFIG.GUN_LIFE);

  for (const m of g.missiles) {
    const prev = m.pos;
    m.age += dt;
    m.speed = Math.min(CONFIG.MISSILE_SPEED + p.speed, m.speed + 300 * dt);
    if (m.target && m.target.alive) {
      // Steer toward an intercept point, limited turn rate.
      const tti = vDist(m.target.pos, m.pos) / m.speed;
      const aim = vNorm(vSub(vAdd(m.target.pos, vScale(m.target.vel, tti)), m.pos));
      const ang = Math.acos(clamp(vDot(m.dir, aim), -1, 1));
      const maxTurn = CONFIG.MISSILE_TURN * dt;
      if (ang > 1e-4) {
        const axis = vNorm(vCross(m.dir, aim));
        m.dir = vNorm(vRotate(m.dir, axis, Math.min(ang, maxTurn)));
      }
    }
    m.pos = vAdd(m.pos, vScale(m.dir, m.speed * dt));
    for (const d of g.drones) {
      if (d.alive && segPointDist(prev, m.pos, d.pos) < CONFIG.DRONE_R * 1.5) { killDrone(g, d, 'missile'); m.age = 99; break; }
    }
    if (m.pos.y < groundHeight(m.pos.x, m.pos.z)) { m.age = 99; g.events.push({ type: 'boom', pos: m.pos }); }
  }
  g.missiles = g.missiles.filter(m => m.age < CONFIG.MISSILE_LIFE);

  for (const d of g.drones) moveDrone(d, dt);
  g.drones = g.drones.filter(d => d.alive && vDist(d.pos, g.plane.pos) < CONFIG.DRONE_MAX_DIST);
  while (g.drones.length < CONFIG.DRONE_COUNT) spawnDrone(g);
  if (g.lock.target && !g.lock.target.alive) g.lock = { target: null, time: 0, locked: false };
  return g;
}

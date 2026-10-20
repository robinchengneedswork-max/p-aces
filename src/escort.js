// escort.js — your side of a bomber-escort mission (LAN: duel-server.js /escort). Pure: no DOM, no
// WebSocket. The server flies the bomber formation and its gunners; ~20 times a second it sends
// every bomber's state, the rounds its gunners fired (they can only hurt the 109, and each laptop
// judges hits on itself) and what happened (kills, fires, gunners out). Everything else — your own
// plane, the other laptops' planes, hits on people — works like a duel (duel.js).
//
// Roles: one laptop flies the 109 (bring down ESCORT_KILLS bombers), the rest fly P-51 escorts (shoot
// the 109 down ESCORT_LIVES times, or keep it off until the bombers reach the target). Friendly fire
// is on. Shot down, you're back after ESCORT_RESPAWN s: the 109 high above, escorts by the bombers.

// Messages for an escort mission. Returns { ui: [...] for main.js, ev: [...] game events to replay }.
function escortReceive(d, g, m, now) {
  if (m.t === 'bombers') return { ui: [], ev: escortBombers(g, m) };
  if (m.t === 'mission') { d.mission = m; return { ui: [], ev: [] }; }
  if (m.t === 'over') {
    d.phase = 'over';
    return { ui: [{ type: 'escort-over', winner: m.winner, why: m.why }], ev: [] };
  }
  if (m.t === 'go') { d.respawnT = 0; g.bombers = []; }
  return { ui: duelReceive(d, g, m, now), ev: [] };
}

// The server's bombers → g.bombers (created, updated, dropped once they've hit the ground), its
// gunners' rounds → your bullets. Returns the server's events with plain positions.
function escortBombers(g, m) {
  const keep = new Set();
  for (const [id, x, y, z, fx, fy, fz, ux, uy, uz, speed, hp, alive, burn, guns] of m.b) {
    keep.add(id);
    let b = g.bombers.find(q => q.id === id);
    if (!b) {
      b = { id, kind: 'bomber', plane: createPlane(v3(x, y, z)), maxHp: CONFIG.BOMBER_HP,
        engines: [0, 1, 2, 3].map(() => CONFIG.BOMBER_ENGINE_HP), gunners: CONFIG.BOMBER_GUNNERS.map(G => ({ ...G, hp: 1 })) };
      g.bombers.push(b);
    }
    const P = b.plane;
    P.pos = v3(x, y, z);
    P.fwd = v3(fx, fy, fz);
    P.up = v3(ux, uy, uz);
    P.right = vNorm(vCross(P.fwd, P.up));
    P.path = { ...P.fwd };
    P.speed = speed;
    b.pos = P.pos;
    b.vel = vScale(P.fwd, speed);
    b.hp = hp;
    b.alive = !!alive;
    b.burning = [0, 1, 2, 3].map(i => !!(burn & (1 << i)));
    b.gunners.forEach((gu, i) => { gu.hp = guns & (1 << i) ? 1 : 0; });
  }
  g.bombers = g.bombers.filter(b => keep.has(b.id));
  for (const r of m.r || []) g.bullets.push({ pos: v3(r[0], r[1], r[2]), vel: v3(r[3], r[4], r[5]), age: 0, owner: 'bomber', power: CONFIG.GUNNER_POWER });
  return (m.ev || []).map(e => ({ ...e, pos: v3(e.pos.x, e.pos.y, e.pos.z) }));
}

// Every frame: carry the bombers on between server updates, and bring you back after being shot down.
function escortStep(d, g, dt) {
  for (const b of g.bombers) {
    b.plane.pos = vAdd(b.plane.pos, vScale(b.plane.fwd, b.plane.speed * dt));
    b.pos = b.plane.pos;
  }
  const m = d.mission;
  if (d.phase === 'fight' && d.countdown <= 0 && g.plane.crashed) {
    d.respawnT = (d.respawnT || 0) + dt;
    const canReturn = g.team !== 'attacker' || !m || m.lives > 0;
    if (d.respawnT >= CONFIG.ESCORT_RESPAWN && canReturn && g.bombers.length) escortRespawn(g);
  } else d.respawnT = 0;
}

// Back in: the 109 ~5 km out and 2 km above the formation, diving in; an escort beside it.
function escortRespawn(g) {
  const live = g.bombers.filter(b => b.alive);
  const ref = live.length ? live : g.bombers;
  const c = vScale(ref.reduce((s, b) => vAdd(s, b.pos), v3(0, 0, 0)), 1 / ref.length);
  const h = vNorm(v3(ref[0].plane.fwd.x, 0, ref[0].plane.fwd.z));
  const heading = h.x || h.z ? h : v3(0, 0, -1);
  let pos, dir;
  if (g.team === 'attacker') {
    const out = vRotate(heading, WORLD_UP, (40 + g.rng() * 100) * DEG * (g.rng() < 0.5 ? 1 : -1));
    pos = vAdd(c, vAdd(vScale(out, 5000), v3(0, 2000, 0)));
    dir = vScale(out, -1);
  } else {
    const right = vNorm(vCross(heading, WORLD_UP)), side = g.rng() < 0.5 ? 1 : -1;
    pos = vAdd(c, vAdd(vScale(right, side * (400 + g.rng() * 300)), vAdd(v3(0, 150, 0), vScale(heading, -450))));
    dir = heading;
  }
  g.plane = createPlane(pos, dir, g.plane.type);
  g.plane.speed = g.plane.spec.CORNER_SPEED + 20;
  g.hp = CONFIG.PLAYER_HP;
  g.respawnT = 0;
  g.bullets = g.bullets.filter(b => b.owner !== 'player');
  syncPlayer(g);
}

// Is this target on your side? (Markers: friends cyan, foes red.)
function escortFriend(g, t) {
  if (g.mode !== 'escort' || !g.team) return false;
  if (t.kind === 'bomber') return g.team === 'escort';
  return t.team === g.team;
}

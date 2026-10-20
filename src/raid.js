// raid.js — bomber escort on one laptop (g.solo). The same mission as the LAN escort room
// (duel-server.js + escort.js), but this game flies the formation and AI pilots fly the other side:
//   role 'attacker': you fly the 109 (ESCORT_LIVES lives) against RAID_ESCORTS AI P-51s that stay
//     with the bombers until you come near, then come after you. Down ESCORT_KILLS bombers to win.
//   role 'escort': you fly a P-51 (back in after ESCORT_RESPAWN, no limit) against RAID_109S AI 109s,
//     RAID_109_AT_ONCE at a time, diving in from high up. They go for the bombers, and turn on you
//     when you get on their tail. Down them all, or keep ESCORT_KILLS bombers flying until the target.
// The gunners shoot at whoever flies the 109. Friendly fire is on for you; the AI holds it.
// Pure: no DOM. Hooks: gameUpdate calls raidAi (before the bullets fly) and raidRules (after).

function createRaid(seed, role) {
  const g = createGame(seed, 'escort', role === 'attacker' ? 'bf109' : 'p51');
  g.team = role === 'attacker' ? 'attacker' : 'escort';
  const a = g.rng() * Math.PI * 2;
  const heading = v3(Math.sin(a), 0, Math.cos(a));
  const center = v3(0, groundHeight(0, 0) + CONFIG.ESCORT_ALT, 0);
  spawnFormation(g, center, heading);
  g.solo = {
    role, kills: 0, need: CONFIG.ESCORT_KILLS, left: CONFIG.ESCORT_TIME, over: null,
    lives: role === 'attacker' ? CONFIG.ESCORT_LIVES : CONFIG.RAID_109S,
    livesMax: role === 'attacker' ? CONFIG.ESCORT_LIVES : CONFIG.RAID_109S,
    livesLabel: role === 'attacker' ? '109 LIVES' : '109s LEFT',
    team: {},           // bandit id → 'attacker' / 'escort' (its rounds outlive it)
    gap: 0,             // s until the next AI 109 (escort role) or AI escort comes back in
    slots: [],          // attacker role: the AI escorts' places beside the formation (null = empty)
  };
  if (role === 'gunner') crewTurret(g, g.bombers[0]);   // the lead bomber's top turret (gunner.js)
  else escortRespawn(g);
  if (role === 'attacker') {
    g.plane.pos = vAdd(g.plane.pos, vScale(vNorm(v3(g.plane.fwd.x, 0, g.plane.fwd.z)), -1000));   // 6 km out to start
    syncPlayer(g);
    for (let i = 0; i < CONFIG.RAID_ESCORTS; i++) raidEscort(g, i);
  } else {
    for (let i = 0; i < CONFIG.RAID_109_AT_ONCE; i++) raidAttacker(g);
  }
  return g;
}

// The formation's middle and heading (live bombers if any).
function raidForm(g) {
  const live = g.bombers.filter(b => b.alive);
  const ref = live.length ? live : g.bombers;
  if (!ref.length) return null;
  const c = vScale(ref.reduce((s, b) => vAdd(s, b.pos), v3(0, 0, 0)), 1 / ref.length);
  const h = vNorm(v3(ref[0].plane.fwd.x, 0, ref[0].plane.fwd.z));
  const heading = h.x || h.z ? h : v3(0, 0, -1);
  return { c, heading, right: vNorm(vCross(heading, WORLD_UP)), vel: vScale(heading, ref[0].plane.speed) };
}

// An AI P-51 in escort slot i: beside the formation (alternate sides), a little high and behind.
function raidSlotPos(f, i) {
  const side = i % 2 ? 1 : -1, k = Math.floor(i / 2);
  return vAdd(f.c, vAdd(vScale(f.right, side * (350 + 220 * k)), vAdd(vScale(f.heading, -300), v3(0, 150, 0))));
}

function raidEscort(g, i) {
  const f = raidForm(g);
  if (!f) return null;
  const b = createBandit(g.nextId++, i === 0 ? 'regular' : 'rookie', raidSlotPos(f, i), f.heading, makeRng(Math.floor(g.rng() * 1e9)), 'p51');
  b.team = 'escort';
  b.slot = i;
  b.plane.speed = CONFIG.FORMATION_SPEED + 10;
  g.solo.team[b.id] = 'escort';
  g.solo.slots[i] = b;
  g.bandits.push(b);
  return b;
}

// An AI 109: ~5 km out from the formation, 2 km above, diving in. Later ones are better pilots.
function raidAttacker(g) {
  const f = raidForm(g);
  if (!f) return null;
  const n = CONFIG.RAID_109S - g.solo.lives + g.bandits.filter(b => b.alive && b.team === 'attacker').length;   // how many came before
  const out = vRotate(f.heading, WORLD_UP, (40 + g.rng() * 100) * DEG * (g.rng() < 0.5 ? 1 : -1));
  const pos = vAdd(f.c, vAdd(vScale(out, 5000), v3(0, 2000, 0)));
  const b = createBandit(g.nextId++, n < 3 ? 'regular' : 'ace', pos, vScale(out, -1), makeRng(Math.floor(g.rng() * 1e9)), 'bf109');
  b.team = 'attacker';
  b.fightT = 0;
  g.solo.team[b.id] = 'attacker';
  g.bandits.push(b);
  g.events.push({ type: 'bandit', pos, skill: b.skill });
  return b;
}

// Is plane q sitting behind b and pointing at it, within dist?
function raidOnTail(b, q, dist) {
  const to = vSub(b.pos, q.pos), d = vLen(to);
  return d < dist && vDot(q.fwd, vScale(to, 1 / (d || 1))) > 0.8;
}

// The AI pilots fly and shoot. Escorts: hold the slot until the 109 comes within RAID_ENGAGE of
// the formation (or of them), then hunt it until it's well clear again. 109s: dive on the nearest
// bomber in slashing passes (break off, extend, come round); with you on their tail, fight you instead.
function raidAi(g, dt) {
  const P = g.player, me = g.plane, s = g.solo, f = raidForm(g);
  g.warn.lock = false;
  for (const b of g.bandits) {
    if (!b.alive) continue;
    let target = null, hold = false;
    if (b.team === 'escort') {
      const near = P.alive && f && (vDist(me.pos, f.c) < (b.engaged ? CONFIG.RAID_ENGAGE * 1.5 : CONFIG.RAID_ENGAGE) || vDist(me.pos, b.pos) < 1500);
      b.engaged = !!near;
      if (near) target = P;
      else if (f) {
        // Back to the slot: chase a point a little ahead of it, moving with the bombers.
        target = { pos: vAdd(raidSlotPos(f, b.slot), vScale(f.heading, 400)), vel: f.vel };
        hold = true;
      }
    } else {
      b.fightT = Math.max(0, (b.fightT || 0) - dt);
      if (P.alive && raidOnTail(b, me, 900)) b.fightT = 8;
      b.awayT = Math.max(0, (b.awayT || 0) - dt);
      if (b.fightT > 0 && P.alive) target = P;
      else if (b.awayT > 0) {
        // Breaking away after a pass: dive on past and out, then turn back for another.
        target = { pos: vAdd(b.pos, vScale(b.away, 2000)), vel: v3(0, 0, 0) };
        hold = true;
      } else {
        // The whole Staffel goes for one bomber at a time: the most damaged one, unless another is
        // far nearer.
        let best = Infinity;
        for (const t of g.bombers) {
          const d = t.alive ? vDist(t.pos, b.pos) - (t.maxHp - t.hp) * 40 : Infinity;
          if (d < best) { best = d; target = t; }
        }
        if (target) best = vDist(target.pos, b.pos);
        // (No plane: head-on passes are fine against a bomber, and it never gets on your six.)
        if (target) target = { pos: target.pos, vel: target.vel, alive: true, bomber: true };
        // A slashing pass, not a duel with the gunners: fire inside ~650 m, then break off before
        // getting too close (after RAID_PASS s in range, or once the pass is lost) and come round again.
        b.runT = best < 650 ? (b.runT || 0) + dt : 0;
        const lost = target && b.runT > 0.5 && vDot(b.plane.fwd, vNorm(vSub(target.pos, b.pos))) < Math.cos(30 * DEG);   // overshot: it's behind the wing
        if (target && (best < CONFIG.RAID_BREAK || b.runT > CONFIG.RAID_PASS || lost)) {
          const h = vNorm(v3(b.plane.fwd.x, 0, b.plane.fwd.z));
          b.away = vNorm(vAdd(vRotate(h.x || h.z ? h : v3(0, 0, -1), WORLD_UP, (b.rng() < 0.5 ? 1 : -1) * 35 * DEG), v3(0, -0.35, 0)));
          b.awayT = CONFIG.RAID_AWAY;
          b.runT = 0;
        }
      }
    }
    const n0 = g.bullets.length;
    flyBandit(g, b, target, [], dt, hold);
    for (let i = n0; i < g.bullets.length; i++) g.bullets[i].team = b.team;
  }
  // The gunners shoot at whoever flies the 109.
  g.gunTargets = s.role === 'attacker' ? [P] : g.bandits.filter(b => b.alive && b.team === 'attacker');
  g.bandits = g.bandits.filter(b => b.alive);
  for (let i = 0; i < s.slots.length; i++) if (s.slots[i] && !s.slots[i].alive) s.slots[i] = null;
}

// Rounds that aren't yours or the other laptop's: the gunners' can hit the AI 109s, the AI 109s'
// can hit the bombers. (Both can still hit you: updateBullets checks that after this.)
function raidBulletHits(g, b, prev, power) {
  if (b.owner === 'bomber') {
    for (const t of g.bandits) {
      if (t.alive && t.team === 'attacker' && segPointDist(prev, b.pos, t.pos) < (t.plane.spec.HIT_R ?? CONFIG.BANDIT_R)) {
        hitBandit(g, t, power * CONFIG.RAID_GUNNER_VS_AI, 'gunner');
        b.age = 99;
        return;
      }
    }
  } else if ((b.team || g.solo.team[b.owner]) === 'attacker') {
    for (const t of g.bombers) {
      const part = t.alive && bomberHit(t, prev, b.pos, 0);
      if (part) { hitBomber(g, t, power, part, b.pos, 'ai'); b.age = 99; return; }
    }
  }
}

// The score: bombers down, the 109's lives (yours, or the AI's pool), the clock; respawns; the end.
function raidRules(g, dt) {
  const s = g.solo;
  if (!s.over) {
    for (const e of g.events) {
      if (e.type === 'kill' && e.bomber) s.kills++;
      if (s.role === 'attacker' && (e.type === 'shot-down' || e.type === 'crash')) s.lives--;
      if (s.role !== 'attacker' && e.type === 'kill' && e.bandit && e.team === 'attacker') s.lives--;
    }
    s.left = Math.max(0, s.left - dt);
    const end = (winner, why) => {
      s.over = { winner, why };
      g.events.push({ type: 'raid-over', winner, why, pos: g.plane.pos });
    };
    if (s.kills >= s.need) end('attacker', 'bombers');
    else if (s.lives <= 0) end('escort', 'shot');
    else if (s.left <= 0) end('escort', 'time');
  }
  // You: back in after ESCORT_RESPAWN (the 109 only while it has lives).
  if (g.plane.crashed && g.respawnT >= CONFIG.ESCORT_RESPAWN && g.bombers.length && (s.role === 'escort' || s.lives > 0) && !s.over) escortRespawn(g);
  // The AI side: a fresh 109 (while the pool lasts) or a lost escort, RAID_GAP after the last went down.
  if (s.over) return;
  if (s.role !== 'attacker') {
    const up = g.bandits.filter(b => b.team === 'attacker').length;
    if (up < Math.min(CONFIG.RAID_109_AT_ONCE, s.lives)) {
      s.gap += dt;
      if (s.gap >= CONFIG.RAID_GAP) { s.gap = 0; raidAttacker(g); }
    } else s.gap = 0;
  } else {
    const empty = [...Array(CONFIG.RAID_ESCORTS).keys()].find(i => !s.slots[i]);
    if (empty !== undefined) {
      s.gap += dt;
      if (s.gap >= CONFIG.RAID_GAP) { s.gap = 0; raidEscort(g, empty); }
    } else s.gap = 0;
  }
}

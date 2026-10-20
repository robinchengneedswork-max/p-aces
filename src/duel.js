// duel.js — your side of a 1v1 LAN duel. Pure: no DOM, no WebSocket (main.js owns the socket and
// hands messages in here). Each laptop flies its own plane; ~30 times a second it sends where it is
// (duelSnapshot) and draws the other plane a beat in the past, between two updates it already has,
// so it moves smoothly (duelRemoteStep). The shooter decides hits: game.js turns your hits into
// 'duel-hit' events that main.js sends; the other laptop's hits arrive as 'hit' messages.

function createDuel(name) {
  return {
    name: name || 'Pilot',
    myId: null, phase: 'connecting', round: 0, target: 5,
    players: [], lan: [],
    ready: false,              // sent 'ready' this calibration
    countdown: 0,              // seconds left before the round starts
    result: null,              // { text, color, until } after a round
    snaps: [],                 // the other plane's recent states: { at, ... }
    gunAcc: 0,
    sendAcc: 0,
  };
}

function duelOpponent(d) {
  return d.players.find(p => p.id !== d.myId) || null;
}

function duelMe(d) {
  return d.players.find(p => p.id === d.myId) || null;
}

// The sim runs only between the countdown and someone going down.
function duelFlying(d) {
  return d.phase === 'fight' && d.countdown <= 0;
}

const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;
const vec = (v, r) => [r(v.x), r(v.y), r(v.z)];
const unvec = a => v3(a[0], a[1], a[2]);

// What we tell the other laptop about ourselves.
function duelSnapshot(g, firing) {
  const p = g.plane;
  return {
    t: 's', p: vec(p.pos, r1), f: vec(p.fwd, r3), u: vec(p.up, r3), v: r1(p.speed), th: r3(p.throttle), ty: p.type,
    hp: g.hp, dead: !!p.crashed, gun: !!firing && !p.crashed,
    m: g.missiles.filter(m => m.owner === 'player').map(m => [m.id, ...vec(m.pos, r1), ...vec(m.dir, r3), r1(m.speed), m.target ? 1 : 0]),
  };
}

// A round starts: our plane at the server's spawn point, everything else cleared.
function duelSpawn(g, sp) {
  const pos = v3(sp.x, 0, sp.z);
  pos.y = groundHeight(pos.x, pos.z) + sp.alt;
  g.plane = createPlane(pos, v3(sp.hx, 0, sp.hz), g.plane.type);
  g.plane.speed = g.plane.spec.CORNER_SPEED + 30;
  g.hp = CONFIG.PLAYER_HP;
  g.bullets = [];
  g.missiles = [];
  g.respawnT = 0;
  g.lock = { target: null, time: 0, locked: false };
  g.missileCd = 0;
  syncPlayer(g);
}

// Messages from the server (or relayed from the other laptop). Returns UI events for main.js:
// { type: 'calib' | 'go' | 'round' | 'over' | 'left' | 'full' | 'hit', … }.
function duelReceive(d, g, m, now) {
  const out = [];
  if (m.t === 'welcome') { d.myId = m.id; d.lan = m.lan || []; d.target = m.target || 5; d.phase = 'lobby'; }
  else if (m.t === 'room') {
    const hadTwo = d.players.length === 2;
    d.players = m.players;
    d.round = m.round;
    if (m.phase === 'lobby') { d.phase = 'lobby'; if (hadTwo && m.players.length < 2) out.push({ type: 'left' }); }
  } else if (m.t === 'full') out.push({ type: 'full' });
  else if (m.t === 'calib') {
    d.phase = 'calib';
    d.round = m.round;
    d.ready = false;
    d.result = null;
    out.push({ type: 'calib', round: m.round });
  } else if (m.t === 'go') {
    d.phase = 'fight';
    d.round = m.round;
    d.countdown = m.countdown;
    d.snaps = [];
    duelSpawn(g, m.spawns[d.myId]);
    g.remote = null;
    out.push({ type: 'go', round: m.round });
  } else if (m.t === 'roundEnd') {
    d.phase = 'roundEnd';
    const won = m.winner === d.myId;
    out.push({ type: 'round', won, how: m.how });
  } else if (m.t === 'over') {
    d.phase = 'over';
    out.push({ type: 'over', won: m.winner === d.myId });
  } else if (m.t === 's') {
    d.snaps.push({ at: now, ...m });
    if (d.snaps.length > 30) d.snaps.shift();
  } else if (m.t === 'hit') {
    if (duelFlying(d)) { hurtPlayer(g, m.dmg, g.plane.pos); out.push({ type: 'hit', dmg: m.dmg }); }
  }
  return out;
}

// Normalised blend of two directions.
function nlerp(a, b, k) {
  return vNorm(v3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k));
}

// Place the other plane (and its missiles and tracers) for this frame.
function duelRemoteStep(d, g, now, dt) {
  const S = d.snaps;
  if (!S.length) { g.remote = null; g.missiles = g.missiles.filter(m => !m.remote); return; }
  const at = now - CONFIG.DUEL_INTERP;
  let a = S[0], b = null;
  for (let i = 0; i < S.length - 1; i++) if (S[i].at <= at && S[i + 1].at >= at) { a = S[i]; b = S[i + 1]; break; }
  if (!b) a = S[S.length - 1];
  let pos, fwd, up;
  if (b) {
    const k = (at - a.at) / Math.max(1e-6, b.at - a.at);
    const pa = unvec(a.p), pb = unvec(b.p);
    pos = vAdd(pa, vScale(vSub(pb, pa), k));
    fwd = nlerp(unvec(a.f), unvec(b.f), k);
    up = nlerp(unvec(a.u), unvec(b.u), k);
  } else {
    // Ran past the newest update: carry on along its heading for a little while.
    const ahead = clamp(at - a.at, 0, CONFIG.DUEL_EXTRAP_MAX);
    fwd = unvec(a.f);
    up = unvec(a.u);
    pos = vAdd(unvec(a.p), vScale(fwd, a.v * ahead));
  }
  const last = S[S.length - 1];
  const right = vNorm(vCross(fwd, up));
  up = vCross(right, fwd);
  const R = g.remote || (g.remote = { id: 'remote', kind: 'remote', plane: createPlane(pos, null, last.ty) });
  // The other pilot picked a different plane this round: swap the model's flight spec.
  if (R.plane.type !== planeSpec(last.ty).type) R.plane = createPlane(pos, null, last.ty);
  const op = duelOpponent(d);
  R.name = op ? op.name : 'OPPONENT';
  R.hp = last.hp;
  R.alive = !last.dead;
  R.plane.pos = pos; R.plane.fwd = fwd; R.plane.up = up; R.plane.right = right; R.plane.path = fwd;
  R.plane.speed = a.v; R.plane.throttle = a.th; R.plane.crashed = !!last.dead;
  R.pos = pos;
  R.vel = vScale(fwd, a.v);

  // Their missiles: newest positions, carried forward to now.
  const seen = new Set();
  for (const q of last.m || []) {
    const key = 'r' + q[0];
    seen.add(key);
    const dir = v3(q[4], q[5], q[6]);
    const pos2 = vAdd(v3(q[1], q[2], q[3]), vScale(dir, q[7] * clamp(now - last.at, 0, CONFIG.DUEL_EXTRAP_MAX)));
    let m = g.missiles.find(x => x.remote && x.key === key);
    if (!m) { m = { remote: true, key, owner: 'remote', age: 0 }; g.missiles.push(m); }
    m.pos = pos2; m.dir = dir; m.speed = q[7]; m.tracking = !!q[8];
  }
  g.missiles = g.missiles.filter(m => !m.remote || seen.has(m.key));

  // Their guns: tracers from their plane while they're firing (looks only; their laptop scores).
  d.gunAcc = last.gun && R.alive ? d.gunAcc + dt * CONFIG.GUN_RATE : Math.min(d.gunAcc, 1);
  while (last.gun && R.alive && d.gunAcc >= 1) {
    d.gunAcc -= 1;
    fireBullet(g, R.plane, R.plane.fwd, 'remote');
  }
}

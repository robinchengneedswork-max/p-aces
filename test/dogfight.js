// dogfight.js — headless dogfights: bandits against stand-in players, hundreds of fights, no camera.
// The stand-in player is flown by the same pilot code (or flies straight / breaks on missiles), so
// we can ask: do bandits fly into hills? does an ace beat a rookie? can a hard turn beat a missile?
// Run: node test/dogfight.js          (checks)
//      node test/dogfight.js report   (also prints per-matchup tables)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Math });
const src = ['config.js', 'math.js', 'flight.js', 'ai.js', 'game.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
vm.runInContext(src + '\n;this.__x = { CONFIG, SKILLS, createGame, gameUpdate, spawnBandit, createBandit, pilotStep, flightStep, createPlane, planeVelocity, groundHeight, makeRng, v3, vAdd, vSub, vScale, vNorm, vDist, vDot, missileTti };', ctx);
const X = ctx.__x;
const REPORT = process.argv[2] === 'report';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  — ' + detail : ''));
}

const DT = 1 / 60;

// A dogfight game with the player flown by `brain(g, t)` → ctrl. Ends when someone dies or time runs out.
// Returns { winner: 'player'|'bandit'|'none', t, banditCrash, playerCrash, playerMissiles, hits }.
function fight(seed, skill, brain, maxT = 120) {
  const g = X.createGame(seed, 'dogfight');
  g.waveT = 0;
  g.wave = 0;
  X.gameUpdate(g, idle(), DT);    // spawn
  g.bandits[0] && Object.assign(g.bandits[0], { skill, hp: X.SKILLS[skill].hp, maxHp: X.SKILLS[skill].hp });
  const res = { winner: 'none', t: maxT, banditCrash: false, playerCrash: false, playerShot: false, kills: 0, maxDist: 0 };
  const b0 = g.bandits[0];
  for (let t = 0; t < maxT; t += DT) {
    if (b0) res.maxDist = Math.max(res.maxDist, X.vDist(b0.pos, g.plane.pos));
    X.gameUpdate(g, brain(g, t), DT);
    for (const e of g.events) {
      if (e.type === 'kill' && e.bandit) { res.winner = 'player'; res.t = t; res.banditCrash = e.how === 'crashed'; return res; }
      if (e.type === 'shot-down') { res.winner = 'bandit'; res.t = t; res.playerShot = true; return res; }
      if (e.type === 'crash') { res.winner = 'bandit'; res.t = t; res.playerCrash = true; return res; }
    }
  }
  return res;
}

function idle() {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0.6, gun: false, missile: false, assist: false };
}

// Stand-in players.
const straight = () => idle();

// The player flown by the AI pilot of a given skill. Fires missiles at its skill's pace (the real
// player's 1.2 s cooldown would make any stand-in unbeatable), guns when it has a solution.
function aiPlayer(skill, shoots = true) {
  let me = null, nextMissile = Math.random() * 2;
  return (g, t) => {
    if (!me || me.plane !== g.plane) {
      me = X.createBandit(-1, skill, g.plane.pos, g.plane.fwd, X.makeRng(77));
      me.plane = g.plane;
    }
    const foe = g.bandits.find(b => b.alive);
    const threats = g.missiles.filter(m => m.owner !== 'player' && m.target === g.player)
      .map(m => ({ ref: m, pos: m.pos, tti: X.missileTti(m, g.plane.pos, g.player.vel), dist: X.vDist(m.pos, g.plane.pos) }));
    me.pos = g.plane.pos;
    const w = X.pilotStep(me, foe ? { pos: foe.pos, vel: foe.vel, plane: foe.plane } : null, threats, DT);
    const shoot = shoots && g.lock.locked && t >= nextMissile;
    if (shoot) nextMissile = t + X.SKILLS[skill].missileCd;
    return { roll: w.roll, pitch: w.pitch, yaw: w.yaw, throttle: w.throttle, gun: shoots && w.fire, missile: shoot, assist: false };
  };
}

function matchup(skill, brain, n, label, maxT) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(fight(1000 + i * 7919, skill, brain, maxT));
  const wins = out.filter(r => r.winner === 'bandit').length;
  const losses = out.filter(r => r.winner === 'player').length;
  const crashes = out.filter(r => r.banditCrash).length;
  const pCrash = out.filter(r => r.playerCrash).length;
  const times = out.filter(r => r.winner !== 'none').map(r => r.t).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : Infinity;
  // life: mean time the bandit stays alive (a fight it doesn't lose counts as the full maxT).
  const life = out.reduce((a, q) => a + (q.winner === 'player' ? q.t : maxT), 0) / n;
  const r = { wins, losses, draws: n - wins - losses, crashes, pCrash, median, n, life, apart: out.filter(q => q.maxDist > 6000).length };
  if (REPORT) console.log('    ' + label.padEnd(30) + ' bandit wins ' + wins + '/' + n + ', loses ' + losses + ' (' + crashes + ' into the ground), draws ' + r.draws + ', player crashes ' + pCrash + ', median ' + median.toFixed(0) + ' s, bandit lives ' + life.toFixed(0) + ' s avg, drifted >6 km apart ' + r.apart);
  return r;
}

// Missile kinematics: a bandit missile from `aspect` ('tail' | 'side' | 'head') at 2 km; the player
// flies straight at full throttle, then pulls full once the missile is `breakAt` m away (0 = never).
function missileTrial(seed, aspect, breakAt) {
  const g = X.createGame(seed, 'dogfight');
  g.waveT = 999;
  const p = g.plane;
  p.speed = 200;
  const rng = X.makeRng(seed);
  const j = () => (rng() - 0.5) * 300;
  const off = aspect === 'side' ? X.v3(2000, j(), j()) : aspect === 'head' ? X.v3(j(), j(), -2000) : X.v3(j(), j(), 2000);
  g.missiles.push({ pos: X.vAdd(p.pos, off), dir: X.vNorm(X.vScale(off, -1)), speed: 240, target: g.player, age: 0, owner: 99, turn: X.CONFIG.ENEMY_MISSILE_TURN });
  for (let t = 0; t < 12; t += DT) {
    const m = g.missiles.find(q => q.owner === 99);
    const ctrl = idle();
    ctrl.throttle = 1;
    if (breakAt && m && X.vDist(m.pos, p.pos) < breakAt) ctrl.pitch = 1;
    X.gameUpdate(g, ctrl, DT);
    if (g.events.some(e => e.type === 'hurt')) return true;
    if (!g.missiles.some(q => q.owner === 99)) return false;
  }
  return false;
}

console.log('bandits vs a player flying straight');
{
  const r = { rookie: matchup('rookie', straight, 12, 'rookie vs straight', 90), ace: matchup('ace', straight, 12, 'ace vs straight', 90) };
  check('a rookie shoots down a straight-flying player most fights', r.rookie.wins >= 9, r.rookie.wins + '/12, median ' + r.rookie.median.toFixed(0) + ' s');
  check('an ace does it every time', r.ace.wins === 12, r.ace.wins + '/12, median ' + r.ace.median.toFixed(0) + ' s');
  check('…and faster than a rookie', r.ace.median < r.rookie.median, r.ace.median.toFixed(0) + ' vs ' + r.rookie.median.toFixed(0) + ' s');
  check('nobody flies into the ground doing it', r.rookie.crashes + r.ace.crashes === 0);
}

// The stand-in player keeps the real player's edge (100 HP vs a bandit's 8-16 hits, 0.6 s lock,
// better missiles): that's right for a human flying by hand, so "who wins" between AIs says little.
// Instead: how dangerous is a bandit to a player who only dodges, and how long does it last
// against one who shoots back.
console.log('bandits vs a player who dodges but never shoots');
{
  const N = 16, r = {};
  for (const sk of ['rookie', 'regular', 'ace']) r[sk] = matchup(sk, aiPlayer('regular', false), N, sk + ' vs dodging regular', 150);
  check('an ace shoots down a dodging player (100 HP, breaks + dodges) in half the fights', r.ace.wins >= N * 0.5, r.ace.wins + '/' + N + ', median ' + r.ace.median.toFixed(0) + ' s');
  check('skill matters: rookie < regular <= ace', r.rookie.wins < r.ace.wins && r.regular.wins <= r.ace.wins,
    r.rookie.wins + ' / ' + r.regular.wins + ' / ' + r.ace.wins);
  const crashes = r.rookie.crashes + r.regular.crashes + r.ace.crashes;
  check('bandits rarely fly into the ground in a real fight', crashes <= 2, crashes + ' of ' + 3 * N);
  const pc = r.rookie.pCrash + r.regular.pCrash + r.ace.pCrash;
  check('…and nor does the AI-flown player', pc <= 2, String(pc));
}

console.log('bandits vs a player who shoots back');
{
  const N = 16, life = {};
  for (const sk of ['rookie', 'regular', 'ace']) {
    const r = matchup(sk, aiPlayer('regular'), N, sk + ' vs shooting regular', 150);
    life[sk] = r.life;
    if (sk === 'rookie') check('a rookie goes down to a regular pilot nearly every time', r.losses >= N * 0.8, r.losses + '/' + N);
  }
  check('better bandits last longer', life.rookie < life.regular && life.regular < life.ace,
    life.rookie.toFixed(0) + ' / ' + life.regular.toFixed(0) + ' / ' + life.ace.toFixed(0) + ' s average');
}

console.log('missiles');
{
  const N = 20, [lo, hi] = X.CONFIG.BREAK_DIST;
  for (const aspect of ['tail', 'side', 'head']) {
    let straightHits = 0, inWindow = 0, late = 0;
    for (let i = 0; i < N; i++) {
      if (missileTrial(500 + i, aspect, 0)) straightHits++;
      for (const at of [lo + 30, (lo + hi) / 2, hi - 30]) if (missileTrial(500 + i, aspect, at)) inWindow++;
      if (missileTrial(500 + i, aspect, 450)) late++;
    }
    if (REPORT) console.log('    ' + aspect + ': straight ' + straightHits + '/' + N + ', break in window ' + inWindow + '/' + 3 * N + ', break at 450 m ' + late + '/' + N);
    if (aspect !== 'side') check(aspect + ': flying straight gets you hit', straightHits >= N * 0.9, straightHits + '/' + N);
    check(aspect + ': a full pull inside BREAK_DIST beats it', inWindow <= 3 * N * 0.1, inWindow + '/' + 3 * N + ' hit');
    check(aspect + ': …breaking too late does not', late >= N * 0.8, late + '/' + N + ' hit');
  }
}



console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

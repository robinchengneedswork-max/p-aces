// duel-server.js — the 1v1 LAN duel: a WebSocket relay plus the round referee. No npm: the
// WebSocket handshake and framing are done by hand (text frames only, which is all we send).
//
// Each laptop runs its own copy of Sky Ace on localhost (the camera needs a secure origin, and a
// LAN http:// address isn't one), and the game connects its WebSocket to the host laptop's server.
// Each laptop flies its own plane; the server only relays states, hits and missiles between the two
// and keeps score. Rounds: both calibrate (centre + range) → both ready → countdown → fight → one
// goes down (shot or crashed) → point to the other → next round, first to TARGET.
//
// Protocol (JSON):
//   client → server  hello {name} · ready · s {state…} · hit {dmg} · down · rematch
//   server → client  welcome {id, lan, port} · room {players, phase, round, target} · full
//                    calib {round} · go {round, spawns, countdown} · roundEnd {winner, how, scores}
//                    over {winner, scores} · s/hit relayed with {from}
//
// /escort is the bomber-escort room (createEscortRoom, below): any number of laptops, one flies the
// 109 (the role passes round each mission), the rest P-51 escorts, around a bomber formation that
// THIS server flies, gunners included, with the game's own src/ code loaded into a vm.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const dgram = require('dgram');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TARGET = 5;            // kills to win the match
const DUEL_SEP = 7000;       // metres apart at the start of a round, nose to nose
const ROUND_TIME = 180;     // s: then the round is a draw (src/config.js DUEL_ROUND_TIME)
const DUEL_ALT = 3000;       // metres above the ground at the start of a round

// ---- WebSocket, by hand ----------------------------------------------------------------------

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(text, opcode = 1) {
  const data = Buffer.from(text, 'utf8');
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, data]);
}

// Pull whole frames off the front of buf. Returns { frames: [{ opcode, text }], rest }.
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 127, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 128) !== 0;
    if (buf.length - p < (masked ? 4 : 0) + len) break;
    let payload;
    if (masked) {
      const mask = buf.subarray(p, p + 4);
      p += 4;
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3];
    } else payload = buf.subarray(p, p + len);
    frames.push({ opcode: b0 & 15, text: payload.toString('utf8'), raw: payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// Upgrade an http request to a socket-like { send(obj), close(), onmessage, onclose }.
function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = {
    open: true,
    send(obj) { if (conn.open) socket.write(frame(JSON.stringify(obj))); },
    close() { if (conn.open) { conn.open = false; try { socket.end(frame('', 8)); } catch (e) { /* gone */ } } },
    onmessage: null, onclose: null,
  };
  let buf = Buffer.alloc(0);
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    const { frames, rest } = parseFrames(buf);
    buf = Buffer.from(rest);
    for (const f of frames) {
      if (f.opcode === 1) { let m; try { m = JSON.parse(f.text); } catch (e) { continue; } if (conn.onmessage) conn.onmessage(m); }
      else if (f.opcode === 8) { conn.close(); socket.destroy(); }
      else if (f.opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, f.raw.length]), f.raw]));
    }
  });
  const gone = () => { if (!conn.dead) { conn.dead = true; conn.open = false; if (conn.onclose) conn.onclose(); } };
  socket.on('close', gone);
  socket.on('error', gone);
  return conn;
}

// ---- The duel room -------------------------------------------------------------------------

// opts.roundGap / opts.countdown / opts.roundTime (ms / s / s) are shortened by the tests; opts.rng
// for repeatable spawns. A round nobody has won after roundTime is a draw (no point): WW2 planes
// carry a few seconds of ammo each and can both run dry.
function createRoom(opts = {}) {
  const roundGap = opts.roundGap ?? 3000;
  const countdown = opts.countdown ?? 3;
  const roundTime = opts.roundTime ?? ROUND_TIME;
  const rng = opts.rng || Math.random;
  const room = { players: [], phase: 'lobby', round: 0, nextId: 1, timer: null, lan: opts.lan || [] };

  const view = () => ({ t: 'room', phase: room.phase, round: room.round, target: TARGET,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, ready: p.ready })) });
  const broadcast = m => room.players.forEach(p => p.conn.send(m));
  const scores = () => Object.fromEntries(room.players.map(p => [p.id, p.score]));
  const other = p => room.players.find(q => q !== p);
  const clear = () => { if (room.timer) { clearTimeout(room.timer); room.timer = null; } };

  function startCalib() {
    clear();
    room.round++;
    room.phase = 'calib';
    room.players.forEach(p => { p.ready = false; });
    broadcast({ t: 'calib', round: room.round });
    broadcast(view());
  }

  // Nose to nose DUEL_SEP apart, somewhere new each round so the ground changes.
  function startFight() {
    room.phase = 'fight';
    const cx = (rng() - 0.5) * 40000, cz = (rng() - 0.5) * 40000;
    const a = rng() * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
    const [p, q] = room.players;
    const spawns = {
      [p.id]: { x: cx + dx * DUEL_SEP / 2, z: cz + dz * DUEL_SEP / 2, hx: -dx, hz: -dz, alt: DUEL_ALT },
      [q.id]: { x: cx - dx * DUEL_SEP / 2, z: cz - dz * DUEL_SEP / 2, hx: dx, hz: dz, alt: DUEL_ALT },
    };
    room.fightStart = Date.now() + countdown * 1000;
    broadcast({ t: 'go', round: room.round, spawns, countdown });
    broadcast(view());
    room.timer = setTimeout(drawRound, (countdown + roundTime) * 1000);
  }

  function drawRound() {
    if (room.phase !== 'fight') return;
    room.phase = 'roundEnd';
    broadcast({ t: 'roundEnd', winner: null, loser: null, how: 'time', scores: scores() });
    broadcast(view());
    room.timer = setTimeout(startCalib, roundGap);
  }

  function endRound(loser, how) {
    if (room.phase !== 'fight') return;
    clear();
    const winner = other(loser);
    winner.score++;
    room.phase = 'roundEnd';
    broadcast({ t: 'roundEnd', winner: winner.id, loser: loser.id, how, scores: scores() });
    if (winner.score >= TARGET) {
      room.phase = 'over';
      broadcast({ t: 'over', winner: winner.id, scores: scores() });
      broadcast(view());
      return;
    }
    broadcast(view());
    room.timer = setTimeout(startCalib, roundGap);
  }

  function resetMatch() {
    room.round = 0;
    room.players.forEach(p => { p.score = 0; p.ready = false; });
  }

  room.join = conn => {
    if (room.players.length >= 2) { conn.send({ t: 'full' }); conn.close(); return null; }
    const p = { id: room.nextId++, name: 'Pilot', score: 0, ready: false, conn };
    room.players.push(p);
    conn.send({ t: 'welcome', id: p.id, lan: room.lan, target: TARGET });
    conn.onmessage = m => room.message(p, m);
    conn.onclose = () => room.leave(p);
    broadcast(view());
    return p;
  };

  room.message = (p, m) => {
    if (m.t === 'hello') {
      p.name = String(m.name || 'Pilot').slice(0, 16);
      if (room.players.length === 2 && room.phase === 'lobby') { resetMatch(); startCalib(); }
      else broadcast(view());
    } else if (m.t === 'ready' && room.phase === 'calib') {
      p.ready = true;
      broadcast(view());
      if (room.players.length === 2 && room.players.every(q => q.ready)) startFight();
    } else if ((m.t === 's' || m.t === 'hit') && other(p)) {
      other(p).conn.send({ ...m, from: p.id });
    } else if (m.t === 'down' && room.phase === 'fight' && Date.now() >= room.fightStart) {
      endRound(p, m.how === 'crash' ? 'crash' : 'shot');
    } else if (m.t === 'rematch' && room.phase === 'over' && room.players.length === 2) {
      resetMatch();
      startCalib();
    }
  };

  room.leave = p => {
    room.players = room.players.filter(q => q !== p);
    clear();
    room.phase = 'lobby';
    room.players.forEach(q => { q.ready = false; });
    broadcast(view());
  };

  return room;
}

// ---- The bomber-escort room -----------------------------------------------------------------
// Protocol, on top of the duel's:
//   client → server  bhit {id, part, dmg} (your rounds hit a bomber) · hit {to, dmg} · down
//   server → client  room {…, players: [{id, name, team, ready}]} · go {round, spawns: {id: {x, y, z,
//                    hx, hz, ty, team}}, countdown} · bombers {b: [[id, x,y,z, fx,fy,fz, ux,uy,uz,
//                    speed, hp, alive, burningBits, gunnerBits]], r: [[x,y,z, vx,vy,vz] gunner
//                    rounds], ev: [{type, pos, …}]} · mission {kills, need, lives, left, attacker}
//                    · over {winner: 'attacker' | 'escort', why}

// The game's pure code (config, math, planes, flight, AI, game rules), loaded once like the tests do.
let SIM = null;
function sim() {
  if (SIM) return SIM;
  const ctx = vm.createContext({ console, Math });
  const src = ['config.js', 'math.js', 'planes.js', 'flight.js', 'ai.js', 'game.js']
    .map(f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')).join('\n');
  vm.runInContext(src + '\n;this.__x = { CONFIG, createGame, spawnFormation, updateBombers, hitBomber, groundHeight, v3, vAdd, vScale, vNorm, vCross, vRotate };', ctx);
  return (SIM = ctx.__x);
}

const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;

// opts: countdown (s), roundGap (ms), missionTime (s), tickMs, rng — shortened by the tests.
function createEscortRoom(opts = {}) {
  const S = sim(), C = S.CONFIG;
  const countdown = opts.countdown ?? 3;
  const missionTime = opts.missionTime ?? C.ESCORT_TIME;
  const tickMs = opts.tickMs ?? Math.round(1000 / C.ESCORT_SEND_HZ);
  const rng = opts.rng || Math.random;
  const room = { players: [], phase: 'lobby', round: 0, nextId: 1, timer: null, tick: null, lan: opts.lan || [], g: null };

  const view = () => ({ t: 'room', mode: 'escort', phase: room.phase, round: room.round,
    players: room.players.map(p => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, score: 0 })) });
  const broadcast = m => room.players.forEach(p => p.conn.send(m));
  const others = p => room.players.filter(q => q !== p);
  const stop = () => {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    if (room.tick) { clearInterval(room.tick); room.tick = null; }
  };
  const attacker = () => room.players.find(p => p.team === 'attacker');

  function startCalib() {
    stop();
    room.round++;
    room.phase = 'calib';
    // The 109 passes round: mission 1 → first pilot, 2 → second, …
    const a = (room.round - 1) % room.players.length;
    room.players.forEach((p, i) => { p.ready = false; p.team = i === a ? 'attacker' : 'escort'; });
    broadcast({ t: 'calib', round: room.round });
    broadcast(view());
  }

  // Escort i: either side of the formation, a little behind (so it's ahead of you) and above. The
  // 109: 6 km out to one side, 2 km up.
  function escortSpawn(i) {
    const f = room.form, side = i % 2 ? 1 : -1, k = Math.floor(i / 2);
    const pos = S.vAdd(f.center, S.vAdd(S.vScale(f.right, side * (350 + 220 * k)), S.vAdd(S.vScale(f.heading, -450), S.v3(0, 150, 0))));
    return { x: pos.x, y: pos.y, z: pos.z, hx: f.heading.x, hz: f.heading.z, ty: 'p51', team: 'escort' };
  }
  function attackerSpawn() {
    const f = room.form;
    const dir = S.vRotate(f.heading, S.v3(0, 1, 0), (40 + rng() * 100) * Math.PI / 180 * (rng() < 0.5 ? 1 : -1));
    const pos = S.vAdd(f.center, S.vAdd(S.vScale(dir, 6000), S.v3(0, 2000, 0)));
    return { x: pos.x, y: pos.y, z: pos.z, hx: -dir.x, hz: -dir.z, ty: 'bf109', team: 'attacker' };
  }

  function startMission() {
    room.phase = 'fight';
    const g = room.g = S.createGame(Math.floor(rng() * 1e9), 'escort');
    g.bombers = [];
    const cx = (rng() - 0.5) * 40000, cz = (rng() - 0.5) * 40000, a = rng() * Math.PI * 2;
    const heading = S.v3(Math.sin(a), 0, Math.cos(a));
    const center = S.v3(cx, S.groundHeight(cx, cz) + C.ESCORT_ALT, cz);
    room.form = { center, heading, right: S.vNorm(S.vCross(heading, S.v3(0, 1, 0))) };
    S.spawnFormation(g, center, heading);
    room.target = { pos: center, vel: S.v3(0, 0, 0), alive: false };   // the 109, from its snapshots
    g.gunTargets = [room.target];
    room.kills = 0;
    room.lives = C.ESCORT_LIVES;
    room.endsAt = Date.now() + (countdown + missionTime) * 1000;
    const spawns = {};
    let e = 0;
    for (const p of room.players) spawns[p.id] = p.team === 'attacker' ? attackerSpawn() : escortSpawn(e++);
    room.fightStart = Date.now() + countdown * 1000;
    broadcast(view());
    broadcast({ t: 'go', round: room.round, spawns, countdown });
    broadcast(bombersMsg([], []));
    broadcast(missionMsg());
    let last = Date.now(), lastMission = 0;
    room.tick = setInterval(() => {
      const now = Date.now(), dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      if (now < room.fightStart) return;
      S.updateBombers(g, dt);   // (events from bhit messages since the last tick are still in g.events)
      tickOut(g);
      if (now - lastMission > 1000) { lastMission = now; broadcast(missionMsg()); }
      if (room.phase === 'fight' && now >= room.endsAt) end('escort', 'time');
    }, tickMs);
  }

  // Send this tick's bombers, the rounds their gunners fired and what happened; count kills.
  function tickOut(g) {
    const rounds = g.bullets.map(b => [r1(b.pos.x), r1(b.pos.y), r1(b.pos.z), r1(b.vel.x), r1(b.vel.y), r1(b.vel.z)]);
    g.bullets = [];
    const ev = [];
    for (const e of g.events) {
      if (!['kill', 'engine-fire', 'gunner-down', 'bomber-crash'].includes(e.type)) continue;
      ev.push({ ...e, pos: { x: r1(e.pos.x), y: r1(e.pos.y), z: r1(e.pos.z) } });
      if (e.type === 'kill') room.kills++;
    }
    g.events.length = 0;
    broadcast(bombersMsg(rounds, ev));
    if (ev.some(e => e.type === 'kill')) broadcast(missionMsg());
    if (room.phase === 'fight' && room.kills >= C.ESCORT_KILLS) end('attacker', 'bombers');
  }

  function bombersMsg(r, ev) {
    const b = room.g.bombers.map(x => {
      const P = x.plane;
      return [x.id, r1(P.pos.x), r1(P.pos.y), r1(P.pos.z), r3(P.fwd.x), r3(P.fwd.y), r3(P.fwd.z), r3(P.up.x), r3(P.up.y), r3(P.up.z),
        r1(P.speed), r1(Math.max(0, x.hp)), x.alive ? 1 : 0,
        x.burning.reduce((m, on, i) => m | (on ? 1 << i : 0), 0), x.gunners.reduce((m, gu, i) => m | (gu.hp > 0 ? 1 << i : 0), 0)];
    });
    return { t: 'bombers', b, r, ev };
  }
  function missionMsg() {
    const a = attacker();
    return { t: 'mission', kills: room.kills, need: C.ESCORT_KILLS, lives: room.lives, livesMax: C.ESCORT_LIVES,
      left: Math.max(0, Math.round((room.endsAt - Math.max(Date.now(), room.fightStart || 0)) / 1000)), attacker: a ? a.id : null };
  }

  function end(winner, why) {
    if (room.phase !== 'fight') return;
    room.phase = 'over';
    stop();
    broadcast(missionMsg());
    broadcast({ t: 'over', winner, why });
    broadcast(view());
  }

  room.join = conn => {
    if (room.players.length >= 8) { conn.send({ t: 'full' }); conn.close(); return null; }
    const p = { id: room.nextId++, name: 'Pilot', team: 'escort', ready: false, conn };
    room.players.push(p);
    conn.send({ t: 'welcome', id: p.id, lan: room.lan, mode: 'escort' });
    conn.onmessage = m => room.message(p, m);
    conn.onclose = () => room.leave(p);
    broadcast(view());
    return p;
  };

  room.message = (p, m) => {
    if (m.t === 'hello') {
      p.name = String(m.name || 'Pilot').slice(0, 16);
      if (room.phase === 'lobby' && room.players.length >= 2) startCalib();
      else if (room.phase === 'fight') {
        // Late arrival: straight in as an escort beside the formation.
        p.team = 'escort';
        p.conn.send({ t: 'go', round: room.round, spawns: { [p.id]: escortSpawn(room.players.length) }, countdown: 0 });
        p.conn.send(bombersMsg([], []));
        p.conn.send(missionMsg());
        broadcast(view());
      } else broadcast(view());
    } else if (m.t === 'ready' && room.phase === 'calib') {
      p.ready = true;
      broadcast(view());
      if (room.players.length >= 2 && room.players.every(q => q.ready)) startMission();
    } else if (m.t === 's') {
      if (p.team === 'attacker' && room.target && Array.isArray(m.p) && Array.isArray(m.f)) {
        room.target.pos = S.v3(m.p[0], m.p[1], m.p[2]);
        room.target.vel = S.vScale(S.v3(m.f[0], m.f[1], m.f[2]), Number(m.v) || 0);
        room.target.alive = !m.dead && room.phase === 'fight';
      }
      others(p).forEach(q => q.conn.send({ ...m, from: p.id }));
    } else if (m.t === 'hit') {
      const q = room.players.find(x => x.id === m.to);
      if (q && q !== p) q.conn.send({ t: 'hit', dmg: m.dmg, from: p.id });
    } else if (m.t === 'bhit' && room.phase === 'fight') {
      const b = room.g.bombers.find(x => x.id === m.id && x.alive);
      const part = C.BOMBER_PARTS[m.part];
      if (b && part) S.hitBomber(room.g, b, Math.min(10, Math.max(0, Number(m.dmg) || 0)), part, b.pos, 'gun');
    } else if (m.t === 'down' && room.phase === 'fight' && Date.now() >= room.fightStart) {
      if (p.team === 'attacker') {
        room.lives--;
        broadcast(missionMsg());
        if (room.lives <= 0) end('escort', 'shot');
      }
    } else if (m.t === 'rematch' && room.phase === 'over' && room.players.length >= 2) startCalib();
  };

  room.leave = p => {
    const wasAttacker = p.team === 'attacker';
    room.players = room.players.filter(q => q !== p);
    if (room.players.length < 2) {
      stop();
      room.phase = 'lobby';
      room.players.forEach(q => { q.ready = false; });
    } else if (room.phase === 'fight' && wasAttacker) end('escort', 'left');
    else if (room.phase === 'calib' && room.players.every(q => q.ready)) startMission();
    broadcast(view());
  };

  return room;
}

// ---- Which address to tell the other laptop (ported from Endor) -----------------------------
// Windows often lists the Mobile Hotspot adapter (192.168.137.1) first, which nobody on the house
// Wi-Fi can reach; the routed adapter (the one the OS would use to go outside) wins.
const VIRTUAL = /vethernet|vmware|virtualbox|hyper-v|docker|loopback|bluetooth|zerotier|tailscale|wsl|tap-|npcap/i;

function lanAddresses(interfaces, routed) {
  const out = [];
  for (const [name, ifaces] of Object.entries(interfaces || {})) {
    for (const i of ifaces || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
      const a = i.address;
      if (a.startsWith('169.254.')) continue;
      let score = /^(10\.|192\.168\.)/.test(a) ? 50 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 45 : 10;
      if (a.startsWith('192.168.137.')) score = 30;
      if (VIRTUAL.test(name)) score -= 30;
      if (a === routed) score += 100;
      out.push({ address: a, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).map(x => x.address);
}

function routedAddress() {
  return new Promise(resolve => {
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = v => { if (done) return; done = true; try { sock.close(); } catch (e) { /* closed */ } resolve(v); };
    sock.on('error', () => finish(null));
    try { sock.connect(53, '8.8.8.8', () => { try { finish(sock.address().address); } catch (e) { finish(null); } }); } catch (e) { finish(null); }
    setTimeout(() => finish(null), 800);
  });
}

// Hook a duel room onto an http server's upgrade requests at /duel, and an escort room at /escort.
// opts.escort: options for the escort room.
function attachDuel(server, opts = {}) {
  const room = createRoom(opts);
  const escort = createEscortRoom(opts.escort || { lan: opts.lan });
  room.escort = escort;
  routedAddress().then(r => { if (!opts.lan) room.lan = escort.lan = lanAddresses(os.networkInterfaces(), r); });
  server.on('upgrade', (req, socket) => {
    const to = req.url.startsWith('/duel') ? room : req.url.startsWith('/escort') ? escort : null;
    if (!to) { socket.destroy(); return; }
    const conn = upgrade(req, socket);
    if (conn) to.join(conn);
  });
  return room;
}

module.exports = { attachDuel, createRoom, createEscortRoom, lanAddresses, parseFrames, frame, acceptKey, TARGET, DUEL_SEP, DUEL_ALT, ROUND_TIME };

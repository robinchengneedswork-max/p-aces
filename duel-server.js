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

const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TARGET = 5;            // kills to win the match
const DUEL_SEP = 7000;       // metres apart at the start of a round, nose to nose
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

// opts.roundGap / opts.countdown (ms / s) are shortened by the tests; opts.rng for repeatable spawns.
function createRoom(opts = {}) {
  const roundGap = opts.roundGap ?? 3000;
  const countdown = opts.countdown ?? 3;
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
  }

  function endRound(loser, how) {
    if (room.phase !== 'fight') return;
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

// Hook a duel room onto an http server's upgrade requests at /duel.
function attachDuel(server, opts = {}) {
  const room = createRoom(opts);
  routedAddress().then(r => { if (!opts.lan) room.lan = lanAddresses(os.networkInterfaces(), r); });
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/duel')) { socket.destroy(); return; }
    const conn = upgrade(req, socket);
    if (conn) room.join(conn);
  });
  return room;
}

module.exports = { attachDuel, createRoom, lanAddresses, parseFrames, frame, acceptKey, TARGET, DUEL_SEP, DUEL_ALT };

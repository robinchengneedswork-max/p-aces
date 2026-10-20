// duel.js — the LAN duel server end to end: a real http server with the hand-written WebSocket
// relay, and real WebSocket clients (Node's built-in one) playing a whole match.
// Run: node test/duel.js

const http = require('http');
const { attachDuel, parseFrames, frame, acceptKey, TARGET, DUEL_SEP } = require('../duel-server');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  — ' + detail : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// A client that records everything it's sent and can wait for a message type.
function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/duel');
  const c = { ws, got: [], closed: false };
  ws.addEventListener('message', ev => c.got.push(JSON.parse(ev.data)));
  ws.addEventListener('close', () => { c.closed = true; });
  c.send = m => ws.send(JSON.stringify(m));
  c.open = new Promise(r => ws.addEventListener('open', r));
  c.next = async (t, pred = () => true, ms = 2000) => {
    const start = c.got.length ? 0 : 0;
    for (let waited = 0; waited < ms; waited += 10) {
      const i = c.got.findIndex((m, k) => k >= start && m.t === t && pred(m));
      if (i >= 0) return c.got.splice(i, 1)[0];
      await wait(10);
    }
    return null;
  };
  return c;
}

(async () => {
  console.log('websocket framing');
  {
    check('handshake accept key (RFC 6455 example)', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const text = JSON.stringify({ t: 's', pad: 'x'.repeat(300) });
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from(text);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    const f = Buffer.concat([Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]), mask, masked]);
    const { frames, rest } = parseFrames(Buffer.concat([f, f.subarray(0, 5)]));
    check('a masked 300-byte frame unmasks, a partial one waits', frames.length === 1 && frames[0].text === text && rest.length === 5);
    const back = parseFrames(frame('hello'));
    check('server frames read back', back.frames[0].text === 'hello');
  }

  const server = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  const room = attachDuel(server, { roundGap: 60, countdown: 0.05, lan: ['10.0.0.5'] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  console.log('lobby');
  const A = client(port);
  await A.open;
  A.send({ t: 'hello', name: 'Ann' });
  const wA = await A.next('welcome');
  check('the host is welcomed with the address to give the other laptop', wA && wA.id === 1 && wA.lan[0] === '10.0.0.5');
  const B = client(port);
  await B.open;
  B.send({ t: 'hello', name: 'Bob' });
  const wB = await B.next('welcome');
  check('the second laptop joins', wB && wB.id === 2);
  const c1 = await A.next('calib'), c1b = await B.next('calib');
  check('two pilots → round 1 opens with calibration for both', c1 && c1b && c1.round === 1);
  const C = client(port);
  await C.open;
  check('a third laptop is turned away (it is a duel)', !!(await C.next('full')));

  console.log('a round');
  A.send({ t: 'ready' });
  await wait(50);
  check('one ready pilot is not enough', !A.got.some(m => m.t === 'go'));
  B.send({ t: 'ready' });
  const go = await A.next('go');
  await B.next('go');
  const s1 = go && go.spawns[1], s2 = go && go.spawns[2];
  const sep = go ? Math.hypot(s1.x - s2.x, s1.z - s2.z) : 0;
  check('both ready → go: spawns 7 km apart, nose to nose', go && Math.abs(sep - DUEL_SEP) < 1 && Math.abs(s1.hx + s2.hx) < 1e-9 && Math.abs(s1.hz + s2.hz) < 1e-9, sep.toFixed(0) + ' m');
  B.send({ t: 'down', how: 'shot' });
  await wait(20);
  check('going down during the countdown does not count', !A.got.some(m => m.t === 'roundEnd'));
  await wait(60);
  A.send({ t: 's', p: [1, 2, 3], f: [0, 0, -1], u: [0, 1, 0], v: 175 });
  const rel = await B.next('s');
  check("states are relayed to the other laptop, tagged with who sent them", rel && rel.from === 1 && rel.p[2] === 3);
  A.send({ t: 'hit', dmg: 5 });
  const hit = await B.next('hit');
  check('hits are relayed to the one who was hit', hit && hit.dmg === 5);
  check('…and not echoed back to the shooter', !A.got.some(m => m.t === 'hit' || m.t === 's'));
  B.send({ t: 'down', how: 'shot' });
  const end = await A.next('roundEnd');
  check('Bob goes down → round to Ann', end && end.winner === 1 && end.scores[1] === 1 && end.scores[2] === 0);
  const c2 = await A.next('calib');
  check('…then round 2 opens with calibration again', c2 && c2.round === 2);
  await B.next('calib');

  console.log('a match');
  // Ann wins rounds 2-4, Bob crashes in round 5 → Ann reaches 5.
  for (let r = 2; r <= TARGET; r++) {
    A.send({ t: 'ready' });
    B.send({ t: 'ready' });
    await A.next('go');
    await wait(70);
    B.send({ t: 'down', how: r === TARGET ? 'crash' : 'shot' });
    await A.next('roundEnd');
    if (r < TARGET) { await A.next('calib'); await B.next('calib'); }
  }
  const over = await A.next('over');
  check('first to ' + TARGET + ' wins the match', over && over.winner === 1 && over.scores[1] === TARGET);
  await wait(100);
  check('no further round after the match', !A.got.some(m => m.t === 'calib'));
  B.send({ t: 'rematch' });
  const re = await A.next('calib');
  const room1 = A.got.filter(m => m.t === 'room').pop();
  check('rematch → round 1 again, scores reset', re && re.round === 1 && room1 && room1.players.every(p => p.score === 0));

  console.log('leaving');
  B.ws.close();
  const lobby = await A.next('room', m => m.phase === 'lobby' && m.players.length === 1);
  check('the other laptop leaving drops the room back to the lobby', !!lobby);
  const D = client(port);
  await D.open;
  D.send({ t: 'hello', name: 'Dee' });
  const c3 = await A.next('calib');
  check('a new opponent can join and the match starts over', c3 && c3.round === 1);

  console.log('time limit');
  {
    const srv2 = http.createServer((q, r) => { r.writeHead(404); r.end(); });
    attachDuel(srv2, { roundGap: 60, countdown: 0.05, roundTime: 0.3 });
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const port2 = srv2.address().port;
    const E = client(port2), F = client(port2);
    await E.open; await F.open;
    E.send({ t: 'hello', name: 'Eve' }); F.send({ t: 'hello', name: 'Fay' });
    await E.next('calib');
    E.send({ t: 'ready' }); F.send({ t: 'ready' });
    await E.next('go');
    const end2 = await E.next('roundEnd', () => true, 2000);
    check('nobody down by the time limit → a draw, no point to anyone', end2 && end2.winner === null && end2.how === 'time' && Object.values(end2.scores).every(v => v === 0));
    const c4 = await E.next('calib');
    check('…and the next round starts', c4 && c4.round === 2);
    E.ws.close(); F.ws.close();
    await wait(200);
    srv2.closeAllConnections();
    srv2.close();
  }

  // Let the sockets close on their own: process.exit() with WebSockets still closing trips a libuv
  // assertion on Windows (exit code 127 after every check passed).
  A.ws.close(); C.ws.close(); D.ws.close();
  await wait(300);
  server.closeAllConnections();
  server.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

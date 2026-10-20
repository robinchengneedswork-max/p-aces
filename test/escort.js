// escort.js — the bomber-escort room end to end: a real http server, real WebSocket clients, and
// the server flying the formation with the game's own code. Run: node test/escort.js

const http = require('http');
const { attachDuel } = require('../duel-server');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  — ' + detail : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/escort');
  const c = { ws, got: [], closed: false };
  ws.addEventListener('message', ev => c.got.push(JSON.parse(ev.data)));
  ws.addEventListener('close', () => { c.closed = true; });
  c.send = m => ws.send(JSON.stringify(m));
  c.open = new Promise(r => ws.addEventListener('open', r));
  c.next = async (t, pred = () => true, ms = 3000) => {
    for (let waited = 0; waited < ms; waited += 10) {
      const i = c.got.findIndex(m => m.t === t && pred(m));
      if (i >= 0) return c.got.splice(i, 1)[0];
      await wait(10);
    }
    return null;
  };
  c.latest = t => { const all = c.got.filter(m => m.t === t); return all[all.length - 1] || null; };
  return c;
}

(async () => {
  const server = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  const opts = { countdown: 0.05, missionTime: 600, tickMs: 20, lan: ['10.0.0.5'] };
  const duel = attachDuel(server, { roundGap: 60, countdown: 0.05, lan: ['10.0.0.5'], escort: opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  console.log('lobby and roles');
  const [A, B, Cc] = [client(port), client(port), client(port)];
  await Promise.all([A.open, B.open, Cc.open]);
  A.send({ t: 'hello', name: 'Ann' });
  B.send({ t: 'hello', name: 'Bob' });
  const cal = await A.next('calib');
  Cc.send({ t: 'hello', name: 'Cat' });
  await wait(100);
  const room = A.latest('room');
  check('two pilots open mission 1 with calibration; a third joins the lobby', cal && cal.round === 1 && room.players.length === 3);
  const teams = room.players.map(p => p.team);
  check('exactly one 109 (the first pilot), the rest escorts', teams.filter(t => t === 'attacker').length === 1 && room.players[0].team === 'attacker', teams.join());

  console.log('the mission');
  for (const c of [A, B, Cc]) c.send({ t: 'ready' });
  const go = await A.next('go');
  const sp = go && go.spawns;
  check('go: a spawn for everyone, 109 for Ann, P-51s for the others', sp && sp[1].ty === 'bf109' && sp[2].ty === 'p51' && sp[3].ty === 'p51');
  const first = await B.next('bombers', m => m.b.length > 0);
  const lead = first && first.b[0];
  check('the server flies a six-bomber formation', first && first.b.length === 6);
  check('the 109 starts well above the formation and ~6 km off; escorts beside it', sp[1].y - lead[2] > 1500 && Math.hypot(sp[1].x - lead[1], sp[1].z - lead[3]) > 5000
    && Math.hypot(sp[2].x - lead[1], sp[2].z - lead[3]) < 1000);
  await wait(300);
  const later = B.latest('bombers');
  const moved = later && Math.hypot(later.b[0][1] - lead[1], later.b[0][3] - lead[3]);
  check('…and it flies on (straight, ~130 m/s)', moved > 15 && moved < 80, moved && moved.toFixed(1) + ' m in ~0.3 s');

  // Gunners shoot at the 109 when it sits on a bomber's tail, never at the escorts.
  const tail = later.b[3];
  const f = [tail[4], tail[5], tail[6]];
  const behind = [tail[1] - f[0] * 350, tail[2] - f[1] * 350 + 20, tail[3] - f[2] * 350];
  const escortBehind = [tail[1] - f[0] * 300, tail[2] - f[1] * 300 - 20, tail[3] - f[2] * 300];
  for (let i = 0; i < 15; i++) {
    B.send({ t: 's', p: escortBehind, f, u: [0, 1, 0], v: 130, dead: false });
    await wait(20);
  }
  const quiet = B.got.filter(m => m.t === 'bombers').reduce((n, m) => n + m.r.length, 0);
  for (let i = 0; i < 25; i++) {
    A.send({ t: 's', p: behind, f, u: [0, 1, 0], v: 130, dead: false });
    await wait(20);
  }
  const rounds = B.got.filter(m => m.t === 'bombers').reduce((n, m) => n + m.r.length, 0) - quiet;
  check("an escort on a bomber's tail draws no fire; the 109 does", quiet === 0 && rounds > 3, quiet + ' vs ' + rounds + ' rounds');
  check("the 109's states reach every other laptop, tagged", !!(await Cc.next('s', m => m.from === 1)));

  // Hits: shooter-decided, judged by the server against its bombers.
  const id = later.b[0][0];
  for (let i = 0; i < 70; i++) A.send({ t: 'bhit', id, part: 0, dmg: 1 });
  const kill = await B.next('bombers', m => m.ev.some(e => e.type === 'kill' && e.bomber));
  const mis = await B.next('mission', m => m.kills === 1);
  check('rounds into a bomber: the server brings it down and tells everyone', !!kill && !!mis);
  const fall = kill && kill.b.find(x => x[0] === id);
  check('…it is still there, falling (not a target)', fall && fall[12] === 0);

  // Friendly fire: hits go to whoever was hit.
  B.send({ t: 'hit', to: 3, dmg: 5 });
  const ff = await Cc.next('hit');
  check('friendly fire: an escort hitting another escort reaches that laptop only', ff && ff.from === 2 && !A.got.some(m => m.t === 'hit'));

  // Two more kills → the 109 wins.
  for (const b of later.b.slice(1, 3)) for (let i = 0; i < 70; i++) A.send({ t: 'bhit', id: b[0], part: 1, dmg: 1 });
  const over = await A.next('over');
  check('three bombers down → the 109 wins', over && over.winner === 'attacker' && over.why === 'bombers');

  console.log('next mission');
  B.send({ t: 'rematch' });
  await A.next('calib', m => m.round === 2);
  await wait(50);
  const room2 = A.latest('room');
  check('rematch: the 109 passes to the next pilot', room2.players.find(p => p.id === 2).team === 'attacker' && room2.players.find(p => p.id === 1).team === 'escort');
  for (const c of [A, B, Cc]) c.send({ t: 'ready' });
  await A.next('go', m => m.round === 2);
  await wait(100);
  for (let i = 0; i < 3; i++) { B.send({ t: 'down', how: 'shot' }); await wait(20); }
  const over2 = await A.next('over');
  check('the 109 shot down three times → the escorts win', over2 && over2.winner === 'escort' && over2.why === 'shot');

  console.log('time and leaving');
  {
    const srv2 = http.createServer((q, r) => { r.writeHead(404); r.end(); });
    attachDuel(srv2, { escort: { countdown: 0.05, missionTime: 0.3, tickMs: 20, lan: [] } });
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const p2 = srv2.address().port;
    const E = client(p2), F = client(p2);
    await E.open; await F.open;
    E.send({ t: 'hello', name: 'Eve' }); F.send({ t: 'hello', name: 'Fay' });
    await E.next('calib');
    E.send({ t: 'ready' }); F.send({ t: 'ready' });
    await E.next('go');
    const o = await E.next('over', () => true, 3000);
    check('the bombers reach the target in time → the escorts win', o && o.winner === 'escort' && o.why === 'time');
    E.send({ t: 'rematch' });
    await F.next('go', () => true, 100);
    await E.next('calib');
    E.send({ t: 'ready' }); F.send({ t: 'ready' });
    await E.next('go');
    // Fay is now the 109; she leaves mid-mission.
    F.ws.close();
    const lobby = await E.next('room', m => m.phase === 'lobby');
    check('down to one pilot → back to the lobby', !!lobby);
    E.ws.close();
    await wait(200);
    srv2.closeAllConnections();
    srv2.close();
  }

  for (const c of [A, B, Cc]) c.ws.close();
  await wait(300);
  server.closeAllConnections();
  server.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

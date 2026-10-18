// analyze-recording.js — reads a gesture recording (G in the game) and reports, for each asked-for
// motion, which hand measurements actually moved, in units of the player's own resting noise.
// Run: node tools/analyze-recording.js [file | latest]     (default: latest in recordings/)
//
// Features (flying hand, relative to the 'neutral' step):
//   knuckles  knuckle-line angle on screen, deg (+ = clockwise)      — stick roll (tilt) today
//   tilt      wrist→middle-knuckle elevation out of the screen, deg (3D, + = knuckles away from
//             camera). Unaffected by roll, unlike the game's flat-hand pitch reading, which flips
//             when an upright stick grip rolls past vertical.
//   dx, dy    palm centre slide, palm lengths (+ = right / down)      — stick roll / pitch today
//   depth     log fist size, (+ = bigger = nearer the camera)         — stick pitch today
//   aim       wrist→middle-knuckle direction on screen, deg            — not used yet
//   zk        knuckles' depth vs wrist, palm lengths (+ = knuckles further from camera) — not used yet
//   open      finger extension (fist ~1, open hand ~2)

const fs = require('fs');
const path = require('path');

const SETTLE = 0.5;   // seconds at the start of each hold that are ignored (still moving)
const DEGS = 180 / Math.PI;

function foldHalf(a) {
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}
function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

// Per-frame raw features that need no reference.
function rawFeatures(f) {
  const m = f.fly.m, L = f.fly.lm;
  const W = L[0], K = L[9];
  const w0 = f.fly.w[0], w9 = f.fly.w[9];
  const fx = w9[0] - w0[0], fy = w9[1] - w0[1], fz = w9[2] - w0[2];
  return {
    roll: m.roll, pitch: Math.atan2(fz, Math.hypot(fx, fy)), cx: m.cx, cy: m.cy, scale: m.scale, open: m.open,
    aim: Math.atan2(K[1] - W[1], K[0] - W[0]),
    zk: (K[2] - W[2]) / (m.scale || 1),
  };
}

function analyze(rec) {
  const frames = rec.frames;
  const neutralFrames = frames.filter(f => f.step === 'neutral' && f.phase === 'hold' && f.fly);
  if (!neutralFrames.length) throw new Error('no tracked frames in the neutral step');
  const settled = fs => {
    const t0 = fs.length ? fs[0].t : 0;
    return fs.filter(f => f.t - t0 >= SETTLE);
  };
  const nRaw = settled(neutralFrames).map(rawFeatures);
  // Angles averaged by their offset from the first sample, so averaging never straddles a wrap.
  const r0 = nRaw[0];
  const N = {
    roll: r0.roll + mean(nRaw.map(r => foldHalf(r.roll - r0.roll))),
    pitch: r0.pitch + mean(nRaw.map(r => wrap(r.pitch - r0.pitch))),
    aim: r0.aim + mean(nRaw.map(r => wrap(r.aim - r0.aim))),
    cx: mean(nRaw.map(r => r.cx)), cy: mean(nRaw.map(r => r.cy)),
    scale: mean(nRaw.map(r => r.scale)), zk: mean(nRaw.map(r => r.zk)), open: mean(nRaw.map(r => r.open)),
  };
  const rel = r => ({
    knuckles: foldHalf(r.roll - N.roll) * DEGS,
    tilt: wrap(r.pitch - N.pitch) * DEGS,
    dx: (r.cx - N.cx) / N.scale,
    dy: (r.cy - N.cy) / N.scale,
    depth: Math.log(r.scale / N.scale),
    aim: wrap(r.aim - N.aim) * DEGS,
    zk: r.zk - N.zk,
    open: r.open,
  });
  const FEATS = ['knuckles', 'tilt', 'dx', 'dy', 'depth', 'aim', 'zk', 'open'];
  const noise = {};
  const nRel = nRaw.map(rel);
  for (const k of FEATS) noise[k] = Math.max(sd(nRel.map(r => r[k])), k === 'knuckles' || k === 'tilt' || k === 'aim' ? 0.5 : 0.005);

  const steps = rec.meta.steps.map(s => s.id);
  const rows = [];
  for (const id of steps) {
    const hold = frames.filter(f => f.step === id && f.phase === 'hold');
    const ready = frames.filter(f => f.step === id && f.phase === 'ready');
    const s = settled(hold);
    const tracked = s.filter(f => f.fly);
    const rels = tracked.map(f => rel(rawFeatures(f)));
    const row = { id, frames: s.length, tracked: s.length ? tracked.length / s.length : 0, mean: {}, sd: {}, z: {}, range: {} };
    for (const k of FEATS) {
      const xs = rels.map(r => r[k]);
      row.mean[k] = mean(xs);
      row.sd[k] = sd(xs);
      row.z[k] = row.mean[k] / noise[k];
      row.range[k] = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    }
    row.game = { roll: mean(tracked.map(f => f.raw.roll)), pitch: mean(tracked.map(f => f.raw.pitch)) };
    // Longest run of frames with no flying hand, in this step's hold and in the move into it.
    const gap = fs => { let run = 0, best = 0; for (const f of fs) { run = f.fly ? 0 : run + 1; best = Math.max(best, run); } return best; };
    row.lostHold = gap(hold);
    row.lostReady = gap(ready);
    rows.push(row);
  }
  return { N, noise, rows, FEATS };
}

function fmt(x, d = 2) {
  const s = x.toFixed(d);
  return (x >= 0 ? ' ' : '') + s;
}

function report(rec, a) {
  const out = [];
  const M = rec.meta;
  out.push('Recording ' + (M.date || '') + ' · scheme ' + M.scheme + ' · flying hand ' + M.hand
    + ' · camera ' + (M.video || '?') + ' @ ' + (M.trackerFps ? M.trackerFps.toFixed(0) : '?') + ' Hz');
  out.push('Neutral: knuckles ' + (a.N.roll * DEGS).toFixed(1) + '°, tilt ' + (a.N.pitch * DEGS).toFixed(1) + '°, centre ('
    + a.N.cx.toFixed(3) + ', ' + a.N.cy.toFixed(3) + '), palm ' + a.N.scale.toFixed(3) + ', open ' + a.N.open.toFixed(2));
  out.push('Resting noise (1 sd): ' + a.FEATS.filter(k => k !== 'open').map(k => k + ' ' + a.noise[k].toFixed(3)).join(', '));
  out.push('');
  out.push('Mean change from neutral during each hold (and in noise units, z):');
  const head = 'step         track  ' + a.FEATS.filter(k => k !== 'open').map(k => k.padStart(13)).join('') + '   open   game roll/pitch  lost(hold/move)';
  out.push(head);
  for (const r of a.rows) {
    const cells = a.FEATS.filter(k => k !== 'open').map(k => {
      const d = k === 'knuckles' || k === 'tilt' || k === 'aim' ? 1 : 3;
      return (fmt(r.mean[k], d) + '(' + Math.round(r.z[k]) + ')').padStart(13);
    }).join('');
    out.push(r.id.padEnd(12) + (Math.round(r.tracked * 100) + '%').padStart(6) + ' ' + cells
      + '  ' + r.mean.open.toFixed(2) + '   ' + fmt(r.game.roll) + ' / ' + fmt(r.game.pitch)
      + '     ' + r.lostHold + ' / ' + r.lostReady + ' frames');
  }
  out.push('');
  // Which measurement best separates each pair of opposite motions?
  const by = id => a.rows.find(r => r.id === id);
  const pairs = [['pitch', 'pull', 'push'], ['roll', 'roll-right', 'roll-left']];
  for (const [axis, plus, minus] of pairs) {
    const p = by(plus), m = by(minus);
    if (!p || !m) continue;
    const ranked = a.FEATS.filter(k => k !== 'open').map(k => ({ k, sep: (p.mean[k] - m.mean[k]) / a.noise[k] }))
      .sort((x, y) => Math.abs(y.sep) - Math.abs(x.sep));
    out.push(axis.toUpperCase() + ' — best signals separating ' + plus + ' from ' + minus + ' (noise units, sign = direction for ' + plus + '):');
    out.push('  ' + ranked.slice(0, 4).map(r => r.k + ' ' + fmt(r.sep, 0)).join(',  '));
  }
  const half = by('half-pull'), full = by('pull');
  if (half && full) {
    out.push('HALF vs FULL pull, depth ' + half.mean.depth.toFixed(3) + ' vs ' + full.mean.depth.toFixed(3)
      + ', dy ' + half.mean.dy.toFixed(3) + ' vs ' + full.mean.dy.toFixed(3) + ' (proportional = good for analog control)');
  }
  const circle = by('circle');
  if (circle) out.push('CIRCLE ranges: ' + a.FEATS.filter(k => k !== 'open').map(k => k + ' ' + circle.range[k].toFixed(k === 'knuckles' || k === 'tilt' || k === 'aim' ? 1 : 3)).join(', '));
  return out.join('\n');
}

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'recordings');
  let file = process.argv[2];
  if (!file || file === 'latest') {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
    if (!files.length) { console.error('No recordings in ' + dir + ' — press G in the game first.'); process.exit(1); }
    file = path.join(dir, files[files.length - 1]);
  }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(path.basename(file));
  console.log(report(rec, analyze(rec)));
}

module.exports = { analyze, report };

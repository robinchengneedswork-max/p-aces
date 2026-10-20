// hud.js — 2D overlay: Ace Combat-ish HUD, input widget, camera debug view. Reads state only.

const HUD = {
  green: '#8dffb0',
  dim: 'rgba(141,255,176,0.45)',
  red: '#ff5a4f',
  amber: '#ffd34a',
  cyan: '#4fd8ff',
  orange: '#ffa040',
  ink: '#e8ecf3',
  font: '"Consolas", "Menlo", monospace',
};

const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function drawHud(ctx, W, H, st) {
  ctx.clearRect(0, 0, W, H);
  if (st.settings.anime && !st.game.plane.crashed) drawSpeedLines(ctx, W, H, st);
  const g = st.game, p = g.plane, w = st.world;
  ctx.lineWidth = 1.5;
  ctx.font = '14px ' + HUD.font;
  ctx.textBaseline = 'middle';

  if (!p.crashed) {
    drawLadder(ctx, W, H, st);
    // Gun pipper: where rounds will be in ~0.7 s.
    const pip = projectToScreen(w, vAdd(p.pos, vScale(p.fwd, 700)), W, H);
    if (pip.on) {
      ctx.strokeStyle = HUD.green;
      ctx.beginPath();
      ctx.arc(pip.x, pip.y, 14, 0, Math.PI * 2);
      ctx.moveTo(pip.x - 24, pip.y); ctx.lineTo(pip.x - 14, pip.y);
      ctx.moveTo(pip.x + 14, pip.y); ctx.lineTo(pip.x + 24, pip.y);
      ctx.moveTo(pip.x, pip.y - 24); ctx.lineTo(pip.x, pip.y - 14);
      ctx.stroke();
    }
    drawFlightPath(ctx, W, H, st);
    drawLead(ctx, W, H, st);
    drawTargets(ctx, W, H, st);
    drawBandits(ctx, W, H, st);
    drawRingMarker(ctx, W, H, st);
    drawGauges(ctx, W, H, st);
  }
  drawTunnel(ctx, W, H, st);
  if (!p.crashed) drawThreats(ctx, W, H, st);

  drawInputs(ctx, W, H, st);
  if (st.camera && st.head) drawLook(ctx, W, H, st.head.look);

  ctx.textAlign = 'left';
  ctx.fillStyle = HUD.green;
  ctx.font = '16px ' + HUD.font;
  ctx.fillText('SCORE ' + String(g.score).padStart(6, '0'), 20, 24);
  ctx.font = '13px ' + HUD.font;
  if (g.mode === 'duel' || g.mode === 'dogfight') {
    if (g.mode === 'duel') ctx.fillText('DUEL · ROUND ' + (st.duel ? st.duel.round : 0) + '   first to ' + (st.duel ? st.duel.target : 5), 20, 46);
    else ctx.fillText('DOGFIGHT · WAVE ' + g.wave + '   KILLS ' + g.kills + '   SHOT DOWN ' + g.deaths + '   CRASHES ' + g.crashes, 20, 46);
    // Your HP.
    const k = g.hp / CONFIG.PLAYER_HP;
    ctx.strokeStyle = HUD.green;
    ctx.strokeRect(20, 56, 160, 8);
    ctx.fillStyle = k > 0.5 ? HUD.green : k > 0.25 ? HUD.amber : HUD.red;
    ctx.fillRect(21, 57, 158 * k, 6);
    ctx.fillStyle = HUD.dim;
    ctx.fillText(st.perf, 20, 80);
  } else {
    ctx.fillText('KILLS ' + g.kills + '   RINGS ' + g.rings + '   CRASHES ' + g.crashes, 20, 46);
    ctx.fillStyle = HUD.dim;
    ctx.fillText(st.perf, 20, 66);
  }

  // Flashes ("SPLASH ONE", "RING", …)
  ctx.textAlign = 'center';
  st.flashes.forEach((f, i) => {
    ctx.globalAlpha = Math.max(0, 1 - f.age / 1.4);
    ctx.fillStyle = f.color;
    ctx.font = 'bold 26px ' + HUD.font;
    ctx.fillText(f.text, W / 2, H * 0.24 + i * 32);
  });
  ctx.globalAlpha = 1;
  if (st.duel) drawDuelScore(ctx, W, H, st);

  if (st.recorder) drawRecorder(ctx, W, H, st);
  // Calibration first: in a duel the loser's plane is still down when the next round's calibration
  // starts, and SHOT DOWN used to draw over it.
  else if (st.calib && st.calib.phase === 'range') drawRangeSweep(ctx, W, H, st);
  else if (st.calib) bigText(ctx, W, H, String(Math.ceil(st.calib.left)), HUD.amber,
    (st.settings.scheme === 'stick' ? 'Hold the stick centred, left hand at rest, and look at the screen' : 'Hold your flying hand level and look at the screen — this is "straight ahead"') + '   (paused)');
  else if (st.duel && duelOverlay(ctx, W, H, st)) { /* duel screen drawn */ }
  else if (p.crashed) bigText(ctx, W, H, p.shotDown ? 'SHOT DOWN' : 'CRASHED', HUD.red, g.mode === 'duel' ? '' : 'respawning…');
  else if (st.warn) {
    ctx.fillStyle = HUD.amber;
    ctx.font = 'bold 18px ' + HUD.font;
    ctx.fillText(st.warn, W / 2, H * 0.72);
  }

  if (st.debug && st.camera) drawCamView(ctx, W, H, st);
  else {
    ctx.textAlign = 'left';
    ctx.font = '12px ' + HUD.font;
    ctx.fillStyle = HUD.dim;
    ctx.fillText('B ' + (g.mode === 'range' ? 'dogfight' : 'range') + ' · V ' + (st.world.view === 'chase' ? 'cockpit' : 'chase') + ' view · D tuning · C or clap twice to calibrate' + (st.camera ? ' · G record gestures' : ''), 20, H - 20);
  }
}

// A little arc at the top: where the view is pointing relative to the nose.
function drawLook(ctx, W, H, look) {
  if (Math.abs(look.yaw) < 3 * DEG && Math.abs(look.pitch) < 3 * DEG) return;
  const cx = W / 2, cy = 96, R = 34;
  ctx.strokeStyle = HUD.dim;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  const a = look.yaw - Math.PI / 2;
  ctx.fillStyle = HUD.amber;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(a) * R * 0.85, cy + Math.sin(a) * R * 0.85 - look.pitch / CONFIG.LOOK_MAX_PITCH * R * 0.5, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '11px ' + HUD.font;
  ctx.textAlign = 'center';
  ctx.fillText('LOOK ' + Math.round(look.yaw / DEG) + '°', cx, cy + R + 12);
}

// Gesture recording overlay: which motion, how long left, and whether the hand is seen.
function drawRecorder(ctx, W, H, st) {
  const rec = st.recorder, step = RECORD_STEPS[rec.i];
  ctx.fillStyle = 'rgba(8,12,18,0.6)';
  ctx.fillRect(0, H * 0.28, W, 210);
  ctx.textAlign = 'center';
  ctx.fillStyle = HUD.dim;
  ctx.font = '14px ' + HUD.font;
  ctx.fillText('RECORDING ' + (rec.i + 1) + ' / ' + RECORD_STEPS.length + '  ·  Esc cancels  ·  game paused', W / 2, H * 0.28 + 24);
  const holding = rec.phase === 'hold';
  ctx.fillStyle = holding ? HUD.red : HUD.amber;
  ctx.font = 'bold 30px ' + HUD.font;
  ctx.fillText(holding ? step.say : 'Back to centre…', W / 2, H * 0.28 + 72);
  ctx.font = '16px ' + HUD.font;
  ctx.fillStyle = HUD.ink;
  ctx.fillText(holding ? '● recording — keep holding' : 'next: ' + step.say, W / 2, H * 0.28 + 108);
  const bw = Math.min(520, W - 80), bx = (W - bw) / 2, by = H * 0.28 + 132;
  ctx.strokeStyle = HUD.dim;
  ctx.strokeRect(bx, by, bw, 10);
  ctx.fillStyle = holding ? HUD.red : HUD.amber;
  ctx.fillRect(bx, by, bw * recorderProgress(rec, st.now), 10);
  ctx.fillStyle = st.assigned.fly ? HUD.green : HUD.red;
  ctx.font = 'bold 14px ' + HUD.font;
  ctx.fillText(st.assigned.fly ? 'hand tracked' : 'HAND NOT SEEN', W / 2, by + 40);
}

// Anime speed lines: streaks from the screen edge toward the middle, more and brighter with speed
// and hard pulls. Redrawn at random every picture, so they shimmer like hand-drawn ones.
function drawSpeedLines(ctx, W, H, st) {
  const p = st.game.plane;
  const fast = clamp((p.speed - CONFIG.SPEED_MAX * 0.7) / (CONFIG.SPEED_MAX * 0.55), 0, 1);
  const k = Math.max(fast, (st.world.vapor || 0) * 0.8);
  if (k <= 0.02) return;
  const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  const n = Math.round(14 + 46 * k);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r0 = R * (0.62 - 0.22 * k + Math.random() * 0.12), r1 = R * (1.0 + Math.random() * 0.1);
    ctx.globalAlpha = (0.12 + 0.35 * k) * (0.4 + Math.random() * 0.6);
    ctx.lineWidth = 1 + Math.random() * 2.5 * k;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.restore();
}

// Range sweep: instructions plus how far each direction has reached so far (1 = the slider's scale).
function drawRangeSweep(ctx, W, H, st) {
  const sw = st.calib.sweep;
  bigText(ctx, W, H, String(Math.ceil(st.calib.left)), HUD.amber,
    'Move to your COMFORTABLE limits: full pull, full push, roll left + right · left hand: all the way up and down   (Esc skips)');
  const reach = (xs, sign) => xs.reduce((m, v) => Math.max(m, v * sign), 0);
  const rows = [
    ['ROLL L', reach(sw.roll, -1)], ['ROLL R', reach(sw.roll, 1)],
    ['PUSH', reach(sw.pitch, st.settings.invertPitch ? 1 : -1)], ['PULL', reach(sw.pitch, st.settings.invertPitch ? -1 : 1)],
  ];
  const x0 = W / 2 - 150, y0 = H * 0.62;
  ctx.font = '12px ' + HUD.font;
  ctx.textAlign = 'right';
  rows.forEach(([label, v], i) => {
    const y = y0 + i * 18;
    ctx.fillStyle = HUD.ink;
    ctx.fillText(label, x0 - 8, y);
    ctx.strokeStyle = HUD.dim;
    ctx.strokeRect(x0, y - 6, 300, 12);
    ctx.fillStyle = v >= CONFIG.RANGE_MIN / CONFIG.RANGE_USE ? HUD.green : HUD.amber;
    ctx.fillRect(x0, y - 6, 300 * Math.min(1, v / 1.5), 12);
  });
  if (sw.cy.length) {
    const travel = Math.max(...sw.cy) - Math.min(...sw.cy);
    ctx.fillStyle = HUD.ink;
    ctx.fillText('THROTTLE', x0 - 8, y0 + rows.length * 18);
    ctx.fillStyle = travel > CONFIG.THROTTLE_MIN_TRAVEL ? HUD.green : HUD.amber;
    ctx.fillRect(x0, y0 + rows.length * 18 - 6, 300 * Math.min(1, travel / 0.5), 12);
  }
}

function bigText(ctx, W, H, text, color, sub) {
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = 'bold 64px ' + HUD.font;
  ctx.fillText(text, W / 2, H * 0.42);
  ctx.font = '18px ' + HUD.font;
  ctx.fillStyle = HUD.ink;
  if (sub) ctx.fillText(sub, W / 2, H * 0.42 + 52);
}

// Horizon and pitch ladder, drawn by projecting real directions so they're always right.
function drawLadder(ctx, W, H, st) {
  const w = st.world, p = st.game.plane;
  const cam = w.camera.position;
  const base = v3(cam.x, cam.y, cam.z);
  const h = vNorm(v3(p.fwd.x, 0, p.fwd.z));
  if (!isFinite(h.x)) return;
  const side = vNorm(vCross(h, WORLD_UP));
  ctx.strokeStyle = HUD.dim;
  ctx.fillStyle = HUD.dim;
  ctx.font = '11px ' + HUD.font;
  ctx.textAlign = 'left';
  for (let e = -60; e <= 60; e += 10) {
    const r = e * DEG;
    const dir = vAdd(vScale(h, Math.cos(r)), vScale(WORLD_UP, Math.sin(r)));
    const c = vAdd(base, vScale(dir, 4000));
    const half = e === 0 ? 900 : 260;
    const a = projectToScreen(w, vAdd(c, vScale(side, -half)), W, H);
    const b = projectToScreen(w, vAdd(c, vScale(side, half)), W, H);
    if (a.behind || b.behind) continue;
    ctx.setLineDash(e < 0 ? [8, 6] : []);
    ctx.beginPath();
    if (e === 0) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    else {
      const gap = 0.3;
      ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * gap, a.y + (b.y - a.y) * gap);
      ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - (b.x - a.x) * gap, b.y - (b.y - a.y) * gap);
      ctx.fillText(String(e), b.x + 6, b.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawTargets(ctx, W, H, st) {
  const g = st.game, w = st.world;
  for (const d of g.drones) {
    const s = projectToScreen(w, d.pos, W, H);
    if (!s.on) continue;
    const dist = vDist(d.pos, g.plane.pos);
    const isTarget = g.lock.target === d;
    const locked = isTarget && g.lock.locked;
    const r = 14;
    ctx.strokeStyle = locked ? HUD.red : HUD.green;
    ctx.lineWidth = locked ? 2.5 : 1.5;
    ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
    if (isTarget && !locked) {
      // Seeker diamond closing in while the lock builds.
      const k = 1 - g.lock.time / CONFIG.LOCK_TIME;
      const R = r + 8 + k * 50;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - R); ctx.lineTo(s.x + R, s.y); ctx.lineTo(s.x, s.y + R); ctx.lineTo(s.x - R, s.y); ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = locked ? HUD.red : HUD.green;
    ctx.font = '11px ' + HUD.font;
    ctx.textAlign = 'left';
    ctx.fillText((locked ? 'LOCK ' : '') + (dist / 1000).toFixed(1) + 'km', s.x + r + 4, s.y - r + 4);
  }
  ctx.lineWidth = 1.5;
}

// Flight-path marker: where the plane is actually going. In a hard pull it sits outside the nose
// (the gun pipper): that gap is the slip.
function drawFlightPath(ctx, W, H, st) {
  const p = st.game.plane;
  const s = projectToScreen(st.world, vAdd(p.pos, vScale(p.path, 700)), W, H);
  if (!s.on) return;
  ctx.strokeStyle = HUD.cyan;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
  ctx.moveTo(s.x - 19, s.y); ctx.lineTo(s.x - 7, s.y);
  ctx.moveTo(s.x + 7, s.y); ctx.lineTo(s.x + 19, s.y);
  ctx.moveTo(s.x, s.y - 7); ctx.lineTo(s.x, s.y - 14);
  ctx.stroke();
}

// Gun lead marker: where to put the gun sight so the rounds meet the target. Drawn at the sight's
// own distance (so lining them up on screen is exact), with a thin line back to the target.
// Dim = out of gun range, green = in range, filled = close enough that the gun assist takes over.
function drawLead(ctx, W, H, st) {
  const g = st.game, p = g.plane, sol = g.gunSol;
  if (!sol) return;
  const s = projectToScreen(st.world, vAdd(p.pos, vScale(sol.dir, 700)), W, H);
  const t = projectToScreen(st.world, sol.target.pos, W, H);
  if (!s.on) return;
  const col = sol.inRange ? HUD.green : HUD.dim;
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = sol.inRange ? 2 : 1.5;
  if (t.on) {
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
  ctx.stroke();
  if (g.gunAssisted && sol.inRange) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 1.5;
}

// Bandits: a red diamond, name + health, and an edge arrow when off screen.
function drawBandits(ctx, W, H, st) {
  const g = st.game, w = st.world;
  for (const b of g.bandits.concat(g.remote && g.remote.alive ? [g.remote] : [])) {
    const s = projectToScreen(w, b.pos, W, H);
    const dist = vDist(b.pos, g.plane.pos);
    if (!s.on) { edgeArrow(ctx, W, H, s, HUD.red); continue; }
    const isTarget = g.lock.target === b, locked = isTarget && g.lock.locked;
    const r = 16;
    ctx.strokeStyle = HUD.red;
    ctx.lineWidth = locked ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath();
    ctx.stroke();
    if (isTarget && !locked) {
      const R = r + 8 + (1 - g.lock.time / CONFIG.LOCK_TIME) * 50;
      ctx.strokeRect(s.x - R, s.y - R, R * 2, R * 2);
    } else if (locked) ctx.strokeRect(s.x - r - 6, s.y - r - 6, (r + 6) * 2, (r + 6) * 2);
    ctx.fillStyle = HUD.red;
    ctx.font = '11px ' + HUD.font;
    ctx.textAlign = 'left';
    const label = b.kind === 'remote' ? b.name.toUpperCase() : SKILLS[b.skill].name;
    ctx.fillText((locked ? 'LOCK ' : '') + label + ' ' + (dist / 1000).toFixed(1) + 'km', s.x + r + 6, s.y - 6);
    ctx.fillRect(s.x + r + 6, s.y + 4, 40 * Math.max(0, b.hp / (b.maxHp || CONFIG.PLAYER_HP)), 3);
  }
  ctx.lineWidth = 1.5;
}

// Duel: the score along the top, you first.
function drawDuelScore(ctx, W, H, st) {
  const d = st.duel, me = duelMe(d), op = duelOpponent(d);
  if (!me) return;
  ctx.textAlign = 'center';
  ctx.font = 'bold 20px ' + HUD.font;
  ctx.fillStyle = HUD.green;
  ctx.fillText(me.name.toUpperCase() + '  ' + me.score + ' — ' + (op ? op.score : 0) + '  ' + (op ? op.name.toUpperCase() : '…'), W / 2, 70);
}

// Duel screens between the fighting: connecting, waiting, ready, countdown, round/match result.
// Returns true when it drew something (so the crash text doesn't draw on top).
function duelOverlay(ctx, W, H, st) {
  const d = st.duel, op = duelOpponent(d), them = op ? op.name : 'your opponent';
  if (d.phase === 'connecting') bigText(ctx, W, H, 'CONNECTING', HUD.amber, 'to ' + d.host);
  else if (d.phase === 'failed') bigText(ctx, W, H, "COULDN'T CONNECT", HUD.red, 'Is Sky Ace running on ' + d.host + ' and on the same Wi-Fi? (Windows may ask to let Node through its firewall.)');
  else if (d.phase === 'disconnected') bigText(ctx, W, H, 'DISCONNECTED', HUD.red, 'The host stopped. Reload to start again.');
  else if (d.phase === 'lobby') bigText(ctx, W, H, 'WAITING FOR AN OPPONENT', HUD.amber,
    d.host.startsWith('localhost') ? 'On the other laptop: Duel → host address  ' + (d.lan[0] || '(this laptop\'s IP)') : 'Connected to ' + d.host);
  else if (d.phase === 'calib') bigText(ctx, W, H, d.ready ? 'READY' : 'CALIBRATE', HUD.amber,
    d.ready ? 'Waiting for ' + them + ' to finish calibrating' : 'Press C (or clap twice) to calibrate, Enter if you\'re set');
  else if (d.phase === 'fight' && d.countdown > 0) bigText(ctx, W, H, String(Math.ceil(d.countdown)), HUD.amber, 'ROUND ' + d.round + ' — ' + them + ' is 7 km ahead, nose to nose');
  else if ((d.phase === 'roundEnd' || d.phase === 'over') && d.result) bigText(ctx, W, H, d.result.text, d.result.color, d.result.sub);
  else return false;
  return true;
}

// Off-screen marker: an arrow on a circle round the middle, pointing toward it.
function edgeArrow(ctx, W, H, s, color) {
  let dx = s.x - W / 2, dy = s.y - H / 2;
  if (s.behind) { dx = -dx; dy = -dy; }
  const a = Math.atan2(dy, dx);
  const R = Math.min(W, H) * 0.38;
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(W / 2 + Math.cos(a) * R, H / 2 + Math.sin(a) * R);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// LOCK WARNING while a bandit holds you in its seeker; MISSILE + distance once one is coming, and
// BREAK once a full pull now will beat it (CONFIG.BREAK_DIST).
function drawThreats(ctx, W, H, st) {
  const g = st.game, m = g.warn.missile;
  const blink = Math.floor(st.now * 6) % 2 === 0;
  ctx.textAlign = 'center';
  if (g.hp > 0 && g.hp <= CONFIG.CRITICAL_HP && blink) {
    ctx.fillStyle = HUD.red;
    ctx.font = 'bold 20px ' + HUD.font;
    ctx.fillText('DAMAGE CRITICAL', W / 2, H * 0.7);
  }
  if (m) {
    const [lo, hi] = CONFIG.BREAK_DIST;
    const brk = m.dist <= hi && m.dist >= lo * 0.6;
    ctx.fillStyle = HUD.red;
    ctx.font = 'bold 22px ' + HUD.font;
    if (blink || brk) ctx.fillText('MISSILE ' + Math.round(m.dist) + 'm', W / 2, H * 0.16);
    if (brk) {
      ctx.font = 'bold 34px ' + HUD.font;
      ctx.fillText('BREAK!  PULL HARD', W / 2, H * 0.22);
    }
    const s = projectToScreen(st.world, m.pos, W, H);
    if (s.on) {
      ctx.strokeStyle = HUD.red;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    } else edgeArrow(ctx, W, H, s, HUD.red);
  } else if (g.warn.lock && blink) {
    ctx.fillStyle = HUD.amber;
    ctx.font = 'bold 20px ' + HUD.font;
    ctx.fillText('LOCK WARNING', W / 2, H * 0.16);
  }
}

// Sustained high G: the edges of the view grey out and close in (tunnel vision); hard negative G
// tints it red; taking hits flashes red. Looks only: it never touches the controls.
function drawTunnel(ctx, W, H, st) {
  const p = st.game.plane;
  const k = clamp((p.strain - 0.15) / 0.85, 0, 1);
  const diag = Math.hypot(W, H) / 2;
  if (k > 0) {
    const inner = diag * (0.95 - 0.7 * k);
    const grad = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, diag);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(Math.min(1, 0.35 + 0.3 * k), 'rgba(0,0,0,' + (0.5 + 0.35 * k).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,' + (0.7 + 0.25 * k).toFixed(3) + ')');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Greying out: the picture loses colour as it closes in.
    if (k > 0.6) { ctx.fillStyle = 'rgba(40,40,40,' + ((k - 0.6) * 0.5).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }
  }
  // Nearly dead: a red border that pulses, stronger the lower you are.
  const g = st.game, crit = !p.crashed && g.hp > 0 && g.hp <= CONFIG.CRITICAL_HP;
  const pulse = crit ? (0.25 + 0.25 * (1 - g.hp / CONFIG.CRITICAL_HP)) * (0.6 + 0.4 * Math.sin(st.now * 7)) : 0;
  const red = Math.max(p.red * 0.45, st.hurt || 0, pulse);
  if (red > 0) {
    const grad = ctx.createRadialGradient(W / 2, H / 2, diag * 0.4, W / 2, H / 2, diag);
    grad.addColorStop(0, 'rgba(160,0,0,0)');
    grad.addColorStop(1, 'rgba(160,0,0,' + red.toFixed(3) + ')');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawRingMarker(ctx, W, H, st) {
  const g = st.game;
  if (!g.ring) return;
  const s = projectToScreen(st.world, g.ring.pos, W, H);
  const dist = vDist(g.ring.pos, g.plane.pos);
  ctx.strokeStyle = HUD.amber;
  ctx.fillStyle = HUD.amber;
  if (s.on) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '11px ' + HUD.font;
    ctx.textAlign = 'center';
    ctx.fillText('RING ' + Math.round(dist) + 'm', s.x, s.y + 16);
    return;
  }
  edgeArrow(ctx, W, H, s, HUD.amber);
}

function drawGauges(ctx, W, H, st) {
  const p = st.game.plane;
  const cy = H / 2;
  ctx.strokeStyle = HUD.green;
  ctx.fillStyle = HUD.green;
  ctx.font = 'bold 18px ' + HUD.font;
  ctx.textAlign = 'center';
  const box = (x, label, val) => {
    ctx.strokeRect(x - 48, cy - 16, 96, 32);
    ctx.fillText(val, x, cy);
    ctx.font = '11px ' + HUD.font;
    ctx.fillText(label, x, cy - 28);
    ctx.font = 'bold 18px ' + HUD.font;
  };
  box(W * 0.2, 'SPEED', String(Math.round(p.speed * 3.6)));
  box(W * 0.8, 'ALT', String(Math.round(p.pos.y)));
  // G meter under the speed box: amber past the onset of tunnel vision.
  ctx.font = 'bold 15px ' + HUD.font;
  ctx.fillStyle = p.g > CONFIG.G_ONSET || p.g < CONFIG.REDOUT_G ? HUD.amber : HUD.green;
  ctx.fillText(p.g.toFixed(1) + ' G', W * 0.2, cy + 32);
  // Energy hint: at best turning speed you out-turn anyone; slow, you can't.
  const dv = p.speed - CONFIG.CORNER_SPEED;
  ctx.font = '11px ' + HUD.font;
  ctx.fillStyle = Math.abs(dv) < 25 ? HUD.cyan : dv < -50 ? HUD.amber : HUD.dim;
  ctx.fillText(Math.abs(dv) < 25 ? 'BEST TURN' : dv < 0 ? 'SLOW — unload / dive' : 'FAST — pull to bleed', W * 0.2, cy + 50);
  if (p.stall > 0) {
    ctx.fillStyle = HUD.red;
    ctx.font = 'bold 18px ' + HUD.font;
    ctx.fillText('STALL — PUSH + THROTTLE', W / 2, H * 0.62);
  }
  ctx.font = 'bold 18px ' + HUD.font;
  ctx.fillStyle = HUD.green;
  const agl = p.pos.y - groundHeight(p.pos.x, p.pos.z);
  if (agl < 150) {
    ctx.fillStyle = HUD.red;
    ctx.fillText('PULL UP', W / 2, H * 0.66);
  }
  ctx.font = '12px ' + HUD.font;
  ctx.fillStyle = HUD.green;
  ctx.fillText('MSL ' + (st.game.missileCd > 0 ? 'RELOAD' : 'READY'), W * 0.8, cy + 32);
}

// Bottom-right: what the hands are telling the plane.
function drawInputs(ctx, W, H, st) {
  const c = st.ctrl, s = st.settings;
  const size = 110, x0 = W - size - 70, y0 = H - size - 54;
  ctx.fillStyle = 'rgba(8,12,18,0.55)';
  ctx.fillRect(x0 - 12, y0 - 30, size + 80, size + 74);
  ctx.strokeStyle = HUD.dim;
  ctx.strokeRect(x0, y0, size, size);
  ctx.beginPath();
  ctx.moveTo(x0 + size / 2, y0); ctx.lineTo(x0 + size / 2, y0 + size);
  ctx.moveTo(x0, y0 + size / 2); ctx.lineTo(x0 + size, y0 + size / 2);
  ctx.stroke();
  const dz = s.deadzone * size / 2;
  ctx.strokeRect(x0 + size / 2 - dz, y0 + size / 2 - dz, dz * 2, dz * 2);
  // Raw (hollow) vs shaped (filled) — shows the deadzone and expo at work.
  const rx = x0 + size / 2 + clamp(c.raw.roll, -1, 1) * size / 2, ry = y0 + size / 2 - clamp(c.raw.pitch, -1, 1) * size / 2;
  const ox = x0 + size / 2 + c.out.roll * size / 2, oy = y0 + size / 2 - c.out.pitch * size / 2;
  ctx.strokeStyle = HUD.ink;
  ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = HUD.green;
  ctx.beginPath(); ctx.arc(ox, oy, 5, 0, Math.PI * 2); ctx.fill();
  // Yaw bar
  ctx.strokeStyle = HUD.dim;
  ctx.strokeRect(x0, y0 + size + 8, size, 8);
  ctx.fillStyle = HUD.green;
  ctx.fillRect(x0 + size / 2, y0 + size + 8, c.out.yaw * size / 2, 8);
  // Throttle bar
  const tx = x0 + size + 16;
  ctx.strokeRect(tx, y0, 14, size);
  ctx.fillStyle = HUD.amber;
  ctx.fillRect(tx, y0 + size * (1 - st.throttle), 14, size * st.throttle);
  // Weapons lights
  ctx.font = 'bold 11px ' + HUD.font;
  ctx.textAlign = 'left';
  ctx.fillStyle = st.gun ? HUD.amber : HUD.dim;
  ctx.fillText('GUN', tx + 22, y0 + 10);
  ctx.fillStyle = st.missileFlash > 0 ? HUD.red : HUD.dim;
  ctx.fillText('MSL', tx + 22, y0 + 28);
  ctx.fillStyle = HUD.dim;
  ctx.fillText('THR', tx - 2, y0 + size + 12);
  ctx.textAlign = 'center';
  ctx.fillStyle = HUD.green;
  const label = (st.camera ? (s.scheme === 'stick' ? 'STICK' : 'FLAT HAND' + (s.pitchSrc === 'height' ? ' (height)' : '')) : 'KEYBOARD')
    + ' · ' + (assistOn(s) ? 'ASSIST' : 'RATE');
  ctx.fillText(label, x0 + size / 2 + 20, y0 - 16);
}

function drawCamView(ctx, W, H, st) {
  const v = st.video;
  if (v.readyState < 2) return;
  const vw = 320, vh = vw * (v.videoHeight / v.videoWidth || 0.5625);
  const x0 = 16, y0 = H - vh - 16;
  ctx.save();
  ctx.translate(x0 + vw, y0);
  ctx.scale(-1, 1);
  ctx.drawImage(v, 0, 0, vw, vh);
  ctx.restore();
  ctx.strokeStyle = HUD.dim;
  ctx.strokeRect(x0, y0, vw, vh);

  // Throttle zone guide on the throttle side.
  const thrLeft = st.settings.hand === 'right';
  ctx.fillStyle = 'rgba(255,211,74,0.12)';
  const zx = thrLeft ? x0 : x0 + vw / 2;
  ctx.fillRect(zx, y0 + vh * CONFIG.THROTTLE_HIGH, vw / 2, vh * (CONFIG.THROTTLE_LOW - CONFIG.THROTTLE_HIGH));

  const drawHand = (h, color, label) => {
    if (!h) return;
    const pt = i => [x0 + h.lm[i].x * vw, y0 + h.lm[i].y * vh];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) { const A = pt(a), B = pt(b); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); }
    ctx.stroke();
    // Knuckle line (what roll reads) drawn thick.
    const A = pt(HL.INDEX_MCP), B = pt(HL.PINKY_MCP);
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.fillStyle = color;
    ctx.font = 'bold 11px ' + HUD.font;
    ctx.textAlign = 'center';
    const w0 = pt(0);
    ctx.fillText(label, w0[0], w0[1] + 14);
  };
  drawHand(st.assigned.fly, HUD.cyan, 'FLY');
  drawHand(st.assigned.thr, HUD.orange, 'THR');

  // Face: eyes, nose, mouth, ears. The nose-to-ear-midpoint line is what head look reads.
  if (st.face) {
    const fp = k => [x0 + k.x * vw, y0 + k.y * vh];
    ctx.fillStyle = HUD.amber;
    for (const k of st.face) { const [x, y] = fp(k); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    const ears = [(st.face[4].x + st.face[5].x) / 2, (st.face[4].y + st.face[5].y) / 2];
    const [ex, ey] = fp({ x: ears[0], y: ears[1] }), [nx, ny] = fp(st.face[2]);
    ctx.strokeStyle = HUD.amber;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.lineWidth = 1.5;
  }

  ctx.textAlign = 'left';
  ctx.font = '11px ' + HUD.font;
  ctx.fillStyle = HUD.ink;
  const lines = [st.status];
  const f = st.ctrl.flyM, t = st.ctrl.thrM;
  if (f && st.settings.scheme === 'stick') {
    const n = neutralFor(st.settings), li = stickLean(f.axI, n.axI), lw = stickLean(f.axW, n.axW);
    lines.push('stick: slide ' + ((f.cx - n.cx) / (n.scale || f.scale)).toFixed(2) + ' palms · axis lean side ' + (li.side / DEG).toFixed(0) + '°  fwd ' + (lw.fwd / DEG).toFixed(0) + '° (3D) / ' + (li.fwd / DEG).toFixed(0) + '° (image)');
  }
  if (f) lines.push('fly: knuckles ' + (f.roll / DEG).toFixed(0) + '° palm tilt ' + (f.pitch / DEG).toFixed(0) + '° size x' + (f.scale / (neutralFor(st.settings).scale || f.scale)).toFixed(2) + ' open ' + f.open.toFixed(2));
  if (st.head.m) lines.push('head: yaw ' + st.head.m.yaw.toFixed(3) + ' pitch ' + st.head.m.pitch.toFixed(3)
    + (st.settings.headNeutral ? '' : st.head.auto && st.head.auto.n >= CONFIG.HEAD_AUTO_FRAMES ? ' (auto-centred)' : ' (centring…)'));
  if (t) lines.push('rudder hand angle ' + ((t.roll - ((st.settings.neutral && st.settings.neutral.thr) ? st.settings.neutral.thr.roll : 0)) / DEG).toFixed(0) + '°');
  if (t) lines.push('thr: y ' + t.cy.toFixed(2) + ' pinch ' + t.pinch.toFixed(2) + ' open ' + t.open.toFixed(2));
  lines.forEach((l, i) => ctx.fillText(l, x0, y0 - 12 - (lines.length - 1 - i) * 14));
}

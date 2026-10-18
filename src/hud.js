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
    drawTargets(ctx, W, H, st);
    drawRingMarker(ctx, W, H, st);
    drawGauges(ctx, W, H, st);
  }

  drawInputs(ctx, W, H, st);
  if (st.camera && st.head) drawLook(ctx, W, H, st.head.look);

  ctx.textAlign = 'left';
  ctx.fillStyle = HUD.green;
  ctx.font = '16px ' + HUD.font;
  ctx.fillText('SCORE ' + String(g.score).padStart(6, '0'), 20, 24);
  ctx.font = '13px ' + HUD.font;
  ctx.fillText('KILLS ' + g.kills + '   RINGS ' + g.rings + '   CRASHES ' + g.crashes, 20, 46);
  ctx.fillStyle = HUD.dim;
  ctx.fillText(st.perf, 20, 66);

  // Flashes ("SPLASH ONE", "RING", …)
  ctx.textAlign = 'center';
  st.flashes.forEach((f, i) => {
    ctx.globalAlpha = Math.max(0, 1 - f.age / 1.4);
    ctx.fillStyle = f.color;
    ctx.font = 'bold 26px ' + HUD.font;
    ctx.fillText(f.text, W / 2, H * 0.24 + i * 32);
  });
  ctx.globalAlpha = 1;

  if (st.recorder) drawRecorder(ctx, W, H, st);
  else if (p.crashed) bigText(ctx, W, H, 'CRASHED', HUD.red, 'respawning…');
  else if (st.calib) bigText(ctx, W, H, String(Math.ceil(st.calib.left)), HUD.amber,
    st.settings.scheme === 'stick' ? 'Hold your fist where the stick is centred, and look at the screen' : 'Hold your flying hand level and look at the screen — this is "straight ahead"');
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
    ctx.fillText('V ' + (st.world.view === 'chase' ? 'cockpit' : 'chase') + ' view · D tuning · C calibrate' + (st.camera ? ' · G record gestures' : ''), 20, H - 20);
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
  // Off-screen: an arrow on the edge pointing toward it.
  let dx = s.x - W / 2, dy = s.y - H / 2;
  if (s.behind) { dx = -dx; dy = -dy; }
  const a = Math.atan2(dy, dx);
  const R = Math.min(W, H) * 0.38;
  const x = W / 2 + Math.cos(a) * R, y = H / 2 + Math.sin(a) * R;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath();
  ctx.fill();
  ctx.restore();
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
    + ' · ' + (assistOn(s) ? 'ASSIST' : 'EXPERT');
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
  if (f) lines.push('fly: knuckles ' + (f.roll / DEG).toFixed(0) + '° palm tilt ' + (f.pitch / DEG).toFixed(0) + '° size x' + (f.scale / (neutralFor(st.settings).scale || f.scale)).toFixed(2) + ' open ' + f.open.toFixed(2));
  if (st.head.m) lines.push('head: yaw ' + st.head.m.yaw.toFixed(3) + ' pitch ' + st.head.m.pitch.toFixed(3)
    + (st.settings.headNeutral ? '' : st.head.auto && st.head.auto.n >= CONFIG.HEAD_AUTO_FRAMES ? ' (auto-centred)' : ' (centring…)'));
  if (t) lines.push('thr: y ' + t.cy.toFixed(2) + ' pinch ' + t.pinch.toFixed(2) + ' open ' + t.open.toFixed(2));
  lines.forEach((l, i) => ctx.fillText(l, x0, y0 - 12 - (lines.length - 1 - i) * 14));
}

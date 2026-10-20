// hangar.js — the hangar: the screen you wait on. A duel or escort lobby, calibrating, waiting for a
// rematch, the hand model loading, and solo flying before take-off (Enter) or paused (Esc). Your
// plane sits on a test stand and moves with whatever you're doing with your hands or keys, a
// checklist ticks off each control as you try it, and the Keys & settings menu stays open so you can
// tune while you watch. A turret crew gets the bomber and its top guns instead. Pure: no DOM.

// Duel phases that are waiting rather than flying.
const HANGAR_PHASES = ['connecting', 'failed', 'disconnected', 'lobby', 'calib', 'over'];

function createHangar() {
  return { rig: { roll: 0, pitch: 0, yaw: 0 }, gun: { az: 0, el: 20 * DEG }, prop: 0, throttle: 0, firing: false, shotAcc: 0, tried: {}, events: [] };
}

// One frame on the stand. ctrl = the same controls the game would get; o = what's seen:
// { camera, crew, fly, thr (hands assigned), face, look, grip, shake }.
function hangarStep(h, ctrl, dt, o) {
  h.events = [];
  const k = 1 - Math.exp(-dt / CONFIG.HANGAR_EASE);
  const r = h.rig;
  r.roll += (clamp(ctrl.roll || 0, -1, 1) * CONFIG.HANGAR_ROLL - r.roll) * k;
  r.pitch += (clamp(ctrl.pitch || 0, -1, 1) * CONFIG.HANGAR_PITCH - r.pitch) * k;
  r.yaw += (clamp(ctrl.yaw || 0, -1, 1) * CONFIG.HANGAR_YAW - r.yaw) * k;
  h.throttle = ctrl.throttle || 0;
  h.prop += dt * (10 + h.throttle * 50);
  if (o.crew) {
    // The top turret swings the way the real one would (same drive speed and limits).
    const step = CONFIG.CREW_SLEW * dt;
    const dAz = Math.atan2(Math.sin((ctrl.gunAz || 0) - h.gun.az), Math.cos((ctrl.gunAz || 0) - h.gun.az));
    h.gun.az = Math.atan2(Math.sin(h.gun.az + clamp(dAz, -step, step)), Math.cos(h.gun.az + clamp(dAz, -step, step)));
    h.gun.el += clamp(clamp(ctrl.gunEl ?? h.gun.el, CONFIG.CREW_EL_MIN, CONFIG.CREW_EL_MAX) - h.gun.el, -step, step);
  }
  // Firing: sound and tracers out of the doors, no ammo used.
  h.firing = !!(ctrl.gun || ctrl.cannon);
  h.shotAcc = h.firing ? h.shotAcc + dt * CONFIG.HANGAR_SHOTS : 0;
  while (h.shotAcc >= 1) { h.shotAcc -= 1; h.events.push({ type: ctrl.cannon && !ctrl.gun ? 'cannon' : 'gun' }); }
  if (ctrl.missile) h.events.push({ type: 'missile' });
  // Tried once = ticked for the rest of the session.
  const t = h.tried, on = (key, ok) => { if (ok) t[key] = true; };
  on('rollL', ctrl.roll < -CONFIG.HANGAR_TRY); on('rollR', ctrl.roll > CONFIG.HANGAR_TRY);
  on('pull', ctrl.pitch > CONFIG.HANGAR_TRY); on('push', ctrl.pitch < -CONFIG.HANGAR_TRY);
  on('yawL', ctrl.yaw < -CONFIG.HANGAR_TRY); on('yawR', ctrl.yaw > CONFIG.HANGAR_TRY);
  on('idle', ctrl.throttle < 0.15); on('full', ctrl.throttle > 0.85);
  on('gun', ctrl.gun); on('fist', ctrl.cannon || ctrl.missile);
  on('look', o.look && Math.abs(o.look.yaw) > 12 * DEG);
  on('grip', o.grip); on('shake', o.grip && ctrl.gun);
  return h;
}

// The checklist for what you're about to do. Rows: { label, ok, live } (live = seen right now,
// not just once).
function hangarChecks(h, o) {
  const t = h.tried, rows = [];
  const row = (label, ok, live) => rows.push({ label, ok: !!ok, live: !!live });
  if (o.camera) {
    row('Camera running', o.tracking, true);
    if (o.crew) row('Both hands in view', o.hands >= 2, true);
    else {
      row('Flying hand seen', o.fly, true);
      row('Throttle hand seen', o.thr, true);
      row('Calibrated (C or clap twice)', o.calibrated);
    }
    if (o.headLook) row('Head look: turn your head', t.look && o.face);
  }
  if (o.crew) {
    row(o.camera ? 'Grab the gun: both fists' : 'Swing the gun: arrows', o.camera ? t.grip : true);
    row(o.camera ? 'Shake the fists to fire' : 'Fire: Space', o.camera ? t.shake : t.gun);
    return rows;
  }
  row('Roll left and right', t.rollL && t.rollR);
  row('Pull up and push down', t.pull && t.push);
  row(o.thrRudder || !o.camera ? 'Rudder both ways' + (o.camera ? ' (turn the left hand)' : ' (Q / E)') : 'Rudder: Q / E (Y = hand)', t.yawL && t.yawR);
  row('Throttle idle and full', t.idle && t.full);
  row('Guns' + (o.camera ? ' (pinch)' : ' (Space)'), t.gun);
  row((o.ww2 ? 'All guns + cannon' : 'Missile') + (o.camera ? ' (fist)' : o.ww2 ? ' (Shift)' : ' (F)'), t.fist);
  return rows;
}

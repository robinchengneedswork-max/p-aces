// main.js — wiring, settings, keyboard fallback, game loop.

const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');
const hctx = hudCanvas.getContext('2d');
const video = document.getElementById('cam');

let settings = loadSettings();
let controls = createControls();
// What to fly on your own (the start screen's Mode): 'range', 'dogfight' (B toggles those two in
// game), or solo bomber escort 'raid-109' / 'raid-p51' (raid.js). ?dogfight starts in dogfight.
function newGame(kind) {
  const seed = Date.now() % 100000;
  if (kind === 'raid-109' || kind === 'raid-p51' || kind === 'raid-gunner') return createRaid(seed, { 'raid-109': 'attacker', 'raid-p51': 'escort', 'raid-gunner': 'gunner' }[kind]);
  return createGame(seed, kind === 'dogfight' ? 'dogfight' : 'range', settings.plane);
}
function gameKind(g) {
  return g.solo ? { attacker: 'raid-109', escort: 'raid-p51', gunner: 'raid-gunner' }[g.solo.role] : g.mode;
}
let gunIn = createGunnerInput();          // crewing a turret: the two-fist grip (gunner.js)
let kbGun = { az: 0, el: 20 * DEG };      // …and the arrow keys' share of where the gun points
let game = newGame(new URLSearchParams(location.search).has('dogfight') ? 'dogfight' : 'range');
let world = null;
let mode = 'camera';         // 'camera' | 'keyboard'
let debug = true;
let hands = [];
let face = null;             // 6 mirrored face keypoints, or null
let head = createHead();
let clap = createClap();
let recorder = null;          // gesture recording in progress (G)
let calib = null;            // { phase: 'centre' | 'range', left: seconds, sweep }
let flashes = [];
let missileFlash = 0;
let hurtFlash = 0, warnT = 0;   // red edge flash when hit; time to the next warning tone
let shake = 0;                  // camera shake from hits, 0..1, decays
let critT = 0;                  // time to the next DAMAGE CRITICAL beep
let lockTickT = 0;
let creakT = 0;                 // time to the next over-G creak
let hang = createHangar();     // the hangar's test stand and checklist (hangar.js)
let hangarSolo = false;        // flying solo: in the hangar (before take-off, or paused with Esc)
let loading = null;            // text while the camera and hand model start (shown in the hangar)
let duel = null;               // 1v1 LAN duel state (duel.js), or null
let duelWs = null;             // its WebSocket to the host laptop
let escortEvents = [];         // escort: game events from the server (kills, fires…) to replay this frame
let drawAcc = 0;               // anime look: time banked toward the next 24 fps picture
let sinceDraw = 0;             // time since the last picture (what the renderer animates by)
let pendingEvents = [];        // game events since the last picture (explosions mustn't be skipped)
let W = 0, H = 0;
let lastTs = 0;
const keys = new Set();
const kb = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 };

function loadSettings() {
  const s = { ...CONFIG.DEFAULTS };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)); } catch (e) { /* private window */ }
  if (saved) {
    Object.assign(s, saved);
    // v2 made the flight stick the default; v3 made assist per scheme (stick = rate roll).
    // Older saves move over once, keeping their tuning.
    if (!saved.version) s.scheme = 'stick';
    if ((saved.version || 1) < 3) s.assist = { flat: saved.assist !== false, stick: false };
    // v4: head look was too twitchy at the old defaults; calm older saves down at least that far.
    if ((saved.version || 1) < 4) {
      s.headDeadzone = Math.max(s.headDeadzone, CONFIG.DEFAULTS.headDeadzone);
      s.headSmooth = Math.min(s.headSmooth, CONFIG.DEFAULTS.headSmooth);
      s.headGain = Math.max(s.headGain, CONFIG.DEFAULTS.headGain);   // the wider deadzone eats some turn
    }
    // v6: stick roll is the fist's slide again, tuned on recordings to 0.9 palm lengths.
    if ((saved.version || 1) < 6) s.stickThrow = CONFIG.DEFAULTS.stickThrow;
    // v7: the stick is rate control (hold = keep rolling). The toggle used to sit on X, next to
    // C, and an accidental press left the user's stick in assist, where it holds a bank angle.
    if ((saved.version || 1) < 7) s.assist = { ...s.assist, stick: false };
    // v8: pitch is more sensitive by default; saves still on the old 30° move to the new one.
    if ((saved.version || 1) < 8 && s.stickPitch >= 30) s.stickPitch = CONFIG.DEFAULTS.stickPitch;
    // v9: rudder only near a 90° turn of the left hand; head deadzone a bit wider.
    if ((saved.version || 1) < 9) {
      s.yawRange = CONFIG.DEFAULTS.yawRange;
      s.yawDeadzone = CONFIG.DEFAULTS.yawDeadzone;
      s.headDeadzone = Math.max(s.headDeadzone, CONFIG.DEFAULTS.headDeadzone);
    }
    s.version = 9;
  }
  return s;
}

function saveSettings() {
  try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* private window */ }
}

// Mirror into "what the player sees" coordinates: image x flipped, world x flipped.
function toHands(raw) {
  return raw.map(h => ({
    lm: h.lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })),
    world: h.world.map(p => ({ x: -p.x, y: p.y, z: p.z })),
  }));
}

// The hangar is up while you wait: a duel's lobby / calibration / result, or solo before take-off.
function inHangar() {
  return duel ? HANGAR_PHASES.includes(duel.phase) : hangarSolo || !!loading;
}

function soloTitle(g) {
  if (g.crew) return 'TOP GUNNER';
  if (g.solo) return g.team === 'attacker' ? 'BOMBER ESCORT: YOU FLY THE 109' : 'BOMBER ESCORT: YOU FLY A P-51';
  return g.mode === 'dogfight' ? 'DOGFIGHT' : 'TEST RANGE';
}

// What the hangar's panel says, and its checklist.
function hangarView() {
  const camera = mode === 'camera', g = game;
  const rows = hangarChecks(hang, {
    camera, crew: !!g.crew, tracking: !!(window.Tracker && Tracker.ready), hands: hands.length,
    fly: !!controls.assigned.fly, thr: !!controls.assigned.thr, calibrated: isCalibrated(settings),
    headLook: settings.headLook, face: !!face, thrRudder: settings.thrRudder, ww2: g.plane.spec.ERA === 'ww2',
  });
  const v = { rows, crew: !!g.crew, title: soloTitle(g), sub: '', prompt: '' };
  if (loading) { v.title = 'LOADING'; v.sub = loading; }
  else if (duel) v.prompt = duel.phase === 'calib' && !duel.ready ? 'ENTER — READY' : '';
  else v.sub = (g.crew ? "The lead bomber's top turret, twin .50s, against AI 109s."
    : planeSpec(g.plane.type).name + (g.solo ? '' : ' · K changes plane, B the mode') + '.')
    + ' Try every control on the stand; the Keys & settings menu (top right) changes things as you watch.'
    + (hang.paused ? ' Paused.' : '');
  return v;
}

// Out of the hangar (Enter or the button): the solo game starts or carries on.
function takeOff() {
  if (!hangarSolo || loading) return;
  hangarSolo = false;
  if (!hang.paused) {
    if (game.crew) flash('TOP GUNNER — grab the gun with both fists, shake them to fire', HUD.cyan);
    else if (game.solo) flash(game.team === 'attacker' ? 'YOU ARE THE 109 — bring down ' + CONFIG.ESCORT_KILLS + ' bombers; the formation is below, ahead'
      : 'ESCORT — keep the 109s off the bombers', game.team === 'attacker' ? HUD.red : HUD.cyan);
  }
  hang.paused = false;
}

function flash(text, color) {
  flashes.push({ text, color, age: 0 });
  if (flashes.length > 3) flashes.shift();
}

function startCalibration(seconds) {
  if (mode !== 'camera') return;
  if (duel && duel.phase !== 'calib' && !inHangar()) { flash('NO PAUSING IN A DUEL — you calibrate before each round', HUD.amber); return; }
  calib = { phase: 'centre', left: seconds || CONFIG.CALIB_COUNTDOWN };
  SFX.calib();
}

// Second step: sweep both hands to their limits; each direction's reach becomes full deflection.
function finishRange(skip) {
  const sweep = calib.sweep;
  calib = null;
  if (skip) { flash('RANGE SKIPPED — kept the previous range', HUD.dim); duelReady(); return; }
  const set = rangeSweepFinish(sweep, settings);
  controls = createControls();
  saveSettings();
  SFX.ring();
  flash(set.length ? 'RANGE SET: ' + set.join(', ') : 'NO MOVEMENT SEEN — range unchanged', set.length ? HUD.green : HUD.amber);
  duelReady();
}

// ---- Duel (two laptops on the same Wi-Fi) ----
// Each laptop runs its own Sky Ace on localhost (the camera needs it) and connects here to the
// host laptop's server. host '' = this laptop hosts.
// mode 'escort': the bomber-escort room on the same server (escort.js).
function duelConnect(name, host, mode = 'duel') {
  duel = createDuel(name, mode);
  game = createGame(Date.now() % 100000, mode, settings.plane);
  if (mode === 'escort') game.bombersRemote = true;
  const addr = (host || 'localhost').trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  duel.host = addr.includes(':') ? addr : addr + ':8068';
  try { duelWs = new WebSocket('ws://' + duel.host + '/' + mode); } catch (e) { duel.phase = 'failed'; return; }
  duelWs.onopen = () => duelSend({ t: 'hello', name });
  duelWs.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    const now = performance.now() / 1000;
    if (duel.mode === 'escort') {
      const r = escortReceive(duel, game, m, now);
      escortEvents.push(...r.ev);
      r.ui.forEach(duelEvent);
    } else for (const u of duelReceive(duel, game, m, now)) duelEvent(u);
  };
  duelWs.onclose = () => { if (duel) duel.phase = duel.phase === 'connecting' ? 'failed' : 'disconnected'; };
}

function duelSend(m) {
  if (duelWs && duelWs.readyState === 1) duelWs.send(JSON.stringify(m));
}

function duelReady() {
  if (!duel || duel.phase !== 'calib' || duel.ready) return;
  duel.ready = true;
  duelSend({ t: 'ready' });
}

function duelEvent(u) {
  const op = duelOpponent(duel), them = op ? op.name : 'OPPONENT';
  if (u.type === 'calib') {
    flash('ROUND ' + u.round + ' — CALIBRATE', HUD.amber);
    // Every round starts with a calibration (centre, then range): nobody can pause mid-fight.
    if (mode === 'camera') startCalibration(CONFIG.CALIB_COUNTDOWN);
    else duelReady();
  } else if (u.type === 'go') {
    calib = null;
    SFX.calib();
    if (duel.mode === 'escort') flash(game.team === 'attacker' ? 'YOU ARE THE 109 — bring down ' + CONFIG.ESCORT_KILLS + ' bombers' : 'ESCORT — keep the 109 off the bombers', game.team === 'attacker' ? HUD.red : HUD.cyan);
  } else if (u.type === 'escort-over') {
    const mine = u.winner === game.team;
    const why = { bombers: CONFIG.ESCORT_KILLS + ' bombers down', time: 'the bombers reached the target', shot: 'the 109 was shot down ' + CONFIG.ESCORT_LIVES + ' times', left: 'the 109 left' }[u.why] || '';
    duel.result = { text: (u.winner === 'attacker' ? 'THE 109 WINS' : 'THE ESCORTS WIN') + (mine ? ' — YOU WIN' : ''), sub: why + ' · Enter for the next mission (the 109 passes on)', color: mine ? HUD.green : HUD.red };
    SFX.kill();
  }
  else if (u.type === 'round' && u.draw) duel.result = { text: 'TIME — NO POINT', sub: 'nobody went down in ' + Math.round(CONFIG.DUEL_ROUND_TIME / 60) + ' minutes', color: HUD.amber };
  else if (u.type === 'round') duel.result = { text: u.won ? 'ROUND TO YOU' : 'ROUND TO ' + them.toUpperCase(), sub: u.how === 'crash' ? (u.won ? them + ' flew into the ground' : 'you flew into the ground') : '', color: u.won ? HUD.green : HUD.red };
  else if (u.type === 'over') duel.result = { text: u.won ? 'YOU WIN THE DUEL' : them.toUpperCase() + ' WINS THE DUEL', sub: 'Enter for a rematch', color: u.won ? HUD.green : HUD.red };
  else if (u.type === 'left') flash(them.toUpperCase() + ' LEFT — waiting for an opponent', HUD.amber);
  else if (u.type === 'full') flash('THAT DUEL IS FULL (two pilots already)', HUD.red);
}

// Calibrates whatever it can see: the flying hand's centre and, if a face is visible, "forward".
function finishCalibration() {
  calib = null;
  const gotHand = calibrateNeutral(settings, hands);
  const room = gotHand ? neutralRoom(settings.neutral[settings.scheme]) : '';
  if (room) setTimeout(() => flash(room, HUD.amber), 900);
  const gotHead = calibrateHead(settings, face);
  if (gotHead) head = createHead();
  if (gotHand) controls = createControls();
  if (gotHand || gotHead) saveSettings();
  if (gotHand) {
    SFX.ring();
    flash('CENTRED' + (gotHead ? ' (+ HEAD)' : '') + ' — now sweep to your limits', HUD.green);
    calib = { phase: 'range', left: CONFIG.RANGE_TIME, sweep: createRangeSweep() };
  } else {
    flash('NO HAND SEEN — PRESS C AGAIN', HUD.red);
  }
}

function startRecording() {
  if (mode !== 'camera' || !window.Tracker || !Tracker.ready || recorder) return;
  calib = null;
  recorder = createRecorder(performance.now() / 1000);
  SFX.calib();
}

// Saves to recordings/ through serve.js; if that fails, the browser downloads the file instead.
async function finishRecording() {
  const rec = recorder;
  recorder = null;
  SFX.ring();
  // The recording's centred step is the freshest calibration there is: adopt it.
  const fresh = neutralFromRecording(rec);
  if (fresh) {
    const old = settings.neutral && settings.neutral[settings.scheme];
    settings.neutral = { ...(settings.neutral || {}), [settings.scheme]: { ...fresh, range: old && old.range } };
    saveSettings();
    controls = createControls();
    flash('RE-CENTRED FROM RECORDING', HUD.green);
    const room = neutralRoom(fresh);
    if (room) setTimeout(() => flash(room, HUD.amber), 900);
  }
  const data = recorderResult(rec, settings, {
    date: new Date().toISOString(),
    video: video.videoWidth + 'x' + video.videoHeight,
    trackerFps: Tracker.fps,
    detectMs: Tracker.detectMs,
    faceMs: Tracker.faceMs,
    renderFps: perf.fps,
    delegate: Tracker.delegate,
    trackerMode: Tracker.mode,
    userAgent: navigator.userAgent,
  });
  const body = JSON.stringify(data);
  try {
    const r = await fetch('recordings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { file } = await r.json();
    flash('SAVED ' + file, HUD.green);
  } catch (err) {
    console.warn('Upload failed, downloading instead', err);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = 'sky-ace-recording-' + Date.now() + '.json';
    a.click();
    flash('DOWNLOADED RECORDING', HUD.amber);
  }
}

// Arrow keys etc. ramp toward full deflection, so keyboard flying isn't twitchy.
function keyboardStep(dt) {
  const k = c => (keys.has(c) ? 1 : 0);
  const ramp = (cur, target) => cur + clamp(target - cur, -4 * dt, 4 * dt);
  kb.roll = ramp(kb.roll, k('ArrowRight') - k('ArrowLeft'));
  kb.pitch = ramp(kb.pitch, k('ArrowDown') - k('ArrowUp'));   // stick convention: down arrow = pull back
  kb.yaw = ramp(kb.yaw, k('KeyE') - k('KeyQ'));
  kb.throttle = clamp(kb.throttle + (k('KeyW') - k('KeyS')) * 0.6 * dt, 0, 1);
  return keys.has('ArrowLeft') || keys.has('ArrowRight') || keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('KeyQ') || keys.has('KeyE');
}

function statusLine() {
  const T = window.Tracker;
  return (T.delegate || '?') + ' ' + Math.round(T.fps) + ' fps · ' + hands.length + ' hand' + (hands.length === 1 ? '' : 's')
    + ' · flying hand ' + settings.hand + ' · ' + (isCalibrated(settings) ? 'calibrated' : 'NOT calibrated');
}

function frame(ts) {
  const workStart = performance.now();
  const dt = Math.min(0.1, lastTs ? (ts - lastTs) / 1000 : 0);
  lastTs = ts;
  const now = performance.now() / 1000;
  const camera = mode === 'camera';
  let fresh = false;            // a new camera frame was processed this frame

  if (camera && window.Tracker && Tracker.ready) {
    const res = Tracker.detect(performance.now());
    fresh = !!res;
    if (res) {
      hands = toHands(res.hands);
      face = res.face ? res.face.map(k => ({ x: 1 - k.x, y: k.y })) : null;
      headUpdate(head, face, now, settings);
      if (calib && calib.phase === 'range') rangeSweepAdd(calib.sweep, hands, settings);
      if (clapUpdate(clap, hands, now) && !recorder && !calib && !game.crew) {   // (a turret's shaking fists aren't claps)
        flash('CLAP CLAP — CALIBRATING', HUD.green);
        startCalibration(CONFIG.CLAP_COUNTDOWN);
      }
    }
  }
  if (camera) controlsUpdate(controls, hands, now, settings, fresh);
  if (camera && game.crew) gunnerInputUpdate(gunIn, hands, now, settings, fresh);
  if (game.crew) {
    // Arrows swing the gun (the hands and the head add to them).
    const ax = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0), ay = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
    kbGun.az += ax * 1.2 * dt;
    kbGun.el = clamp(kbGun.el + ay * 0.9 * dt, CONFIG.CREW_EL_MIN, CONFIG.CREW_EL_MAX);
  }
  const headOn = camera && settings.headLook;
  if (camera) headFollow(head, dt, settings);
  if (recorder) {
    recorderStep(recorder, now);
    if (fresh) recorderAdd(recorder, now, hands, settings, controls);
    if (recorder.done) finishRecording();
  }
  const kbActive = keyboardStep(dt);
  if (keys.has('KeyW') || keys.has('KeyS')) controls.out.throttle = kb.throttle;
  else kb.throttle = controls.out.throttle;

  // Keyboard always works; while a flight key is held it overrides the hand.
  const useKb = !camera || kbActive;
  const ctrl = {
    roll: useKb ? kb.roll : controls.out.roll,
    pitch: useKb ? kb.pitch : controls.out.pitch,
    yaw: useKb ? kb.yaw : controls.out.yaw,
    throttle: camera ? controls.out.throttle : kb.throttle,
    gun: keys.has('Space') || (camera && (game.crew ? gunIn.grip && gunIn.fire : controls.out.gun)),
    gunAz: kbGun.az + (camera ? gunIn.az : 0) + (headOn ? head.look.yaw : 0),
    gunEl: kbGun.el + (camera ? gunIn.el : 0) + (headOn ? head.look.pitch : 0),
    reload: settings.reload,
    cannon: keys.has('ShiftLeft') || keys.has('ShiftRight') || (camera && controls.out.cannon),
    gunAssist: settings.gunAssist,
    missile: (camera && controls.out.missile) || keys.has('KeyF'),
    assist: assistOn(settings),
  };
  keys.delete('KeyF');
  if (!camera) controls.out.throttle = kb.throttle;

  if (calib) {
    calib.left -= dt;
    if (calib.left <= 0) { if (calib.phase === 'range') finishRange(false); else finishCalibration(); }
  }

  // The game pauses while recording or calibrating, so nobody crashes into a hill holding
  // "push forward" or spins while their hand finds the stick again. In the hangar the plane sits
  // on its test stand instead.
  const hangarUp = inHangar();
  document.body.classList.toggle('hangar', hangarUp);
  document.body.classList.toggle('hangar-solo', hangarUp && !duel && !loading);
  if (hangarUp) {
    hangarStep(hang, ctrl, dt, { look: headOn ? head.look : null, grip: camera && gunIn.grip });
    for (const e of hang.events) { if (e.type === 'gun') SFX.gun(); if (e.type === 'cannon') SFX.cannon(); if (e.type === 'missile') SFX.missile(); }
  }
  const duelHold = duel && !duelFlying(duel);
  if (duel && duel.phase === 'fight' && duel.countdown > 0) duel.countdown -= dt;
  if (!recorder && !calib && !duelHold && !hangarUp) gameUpdate(game, ctrl, dt);
  else game.events.length = 0;
  if (duel) {
    duelRemoteStep(duel, game, now, dt);
    if (duel.mode === 'escort') {
      escortStep(duel, game, dt);
      game.events.push(...escortEvents);
      escortEvents = [];
    }
    for (const e of game.events) {
      if (e.type === 'bomber-hit') duelSend({ t: 'bhit', id: e.id, part: e.part, dmg: e.dmg });
      if (e.type === 'duel-hit') { duelSend({ t: 'hit', dmg: e.dmg, to: e.to }); SFX.hit(); }
      if (e.type === 'shot-down' || e.type === 'crash') duelSend({ t: 'down', how: e.type === 'crash' ? 'crash' : 'shot' });
    }
    duel.sendAcc += dt;
    if (duel.sendAcc >= 1 / CONFIG.DUEL_SEND_HZ) { duel.sendAcc = 0; duelSend(duelSnapshot(game, ctrl.gun && !duelHold, ctrl.cannon && !duelHold)); }
  }
  pendingEvents.push(...game.events);
  for (const e of game.events) {
    if (e.type === 'gun') SFX.gun();
    if (e.type === 'cannon') SFX.cannon();
    if (e.type === 'missile') { SFX.missile(); missileFlash = 0.4; }
    if (e.type === 'kill') {
      SFX.kill();
      if (e.bomber && game.mode === 'escort') flash(game.team === 'attacker' ? 'BOMBER DOWN' : 'WE LOST A BOMBER', game.team === 'attacker' ? HUD.green : HUD.red);
      else if (e.bandit && e.how === 'gunner') flash('THE GUNNERS GOT A 109', HUD.green);
      else if (e.bandit && e.team) flash(e.how === 'crashed' ? (e.team === 'attacker' ? 'A 109' : 'A P-51') + ' FLEW INTO THE GROUND' : 'SPLASH ONE — ' + (e.team === 'attacker' ? '109' : 'P-51') + ' DOWN', HUD.green);
      else if (e.bomber) flash(e.how === 'fire' ? 'BOMBER DOWN — BURNED OUT' : 'SPLASH ONE — BOMBER DOWN', HUD.green);
      else flash(e.bandit ? (e.how === 'crashed' ? SKILLS[e.skill].name + ' FLEW INTO THE GROUND' : 'SPLASH ONE — ' + SKILLS[e.skill].name + ' DOWN') : 'SPLASH ONE', HUD.green);
    }
    if (e.type === 'bomber') flash('BOMBER — crossing ahead', HUD.amber);
    if (e.type === 'engine-fire') { SFX.boom(); flash('ENGINE ON FIRE', HUD.amber); }
    if (e.type === 'bomber-crash') SFX.crash();
    if (e.type === 'gunner-down') flash(e.name + ' GUNNER OUT', HUD.green);
    if (e.type === 'bandit') flash((game.solo ? '109 INBOUND — ' : 'BANDIT — ') + SKILLS[e.skill].name, HUD.red);
    if (e.type === 'reload-start') flash(e.group === 'belt' ? 'CHANGING BELT' : (e.group === 'mg' ? 'MG' : 'CANNON') + ' EMPTY — RELOADING', HUD.amber);
    if (e.type === 'reloaded') flash(e.group === 'belt' ? 'NEW BELT' : (e.group === 'mg' ? 'MG' : 'CANNON') + ' RELOADED', HUD.green);
    if (e.type === 'turret-out') { SFX.crash(); flash(e.how === 'hit' ? 'YOU ARE HIT' : 'BOMBER GOING DOWN — BAIL OUT', HUD.red); }
    if (e.type === 'crew-move') flash('YOU TAKE OVER THE NEXT TOP TURRET', HUD.cyan);
    if (e.type === 'raid-over') { SFX.ring(); flash(e.winner === game.team ? 'MISSION WON' : 'MISSION LOST', e.winner === game.team ? HUD.green : HUD.red); }
    if (e.type === 'hit') SFX.hit();
    if (e.type === 'hurt') { SFX.hurt(); hurtFlash = Math.min(0.85, hurtFlash + 0.35); shake = Math.min(1, shake + e.dmg / 20); }
    if (e.type === 'enemy-missile') SFX.enemyLaunch();
    if (e.type === 'enemy-gun') SFX.enemyGun();
    if (e.type === 'shot-down') SFX.crash();
    if (e.type === 'boom') SFX.boom();
    if (e.type === 'crash') { SFX.crash(); if (game.plane.wingFailed) flash('WING FAILURE — over-G', HUD.red); }
    if (e.type === 'ring') { SFX.ring(); flash('RING +50', HUD.amber); }
    if (e.type === 'ring-miss') { SFX.ringMiss(); flash('MISSED RING', HUD.dim); }
    if (e.type === 'lock') SFX.locked();
  }
  if (game.lock.target && !game.lock.locked && !hangarUp) {
    lockTickT -= dt;
    if (lockTickT <= 0) { SFX.lockTick(); lockTickT = 0.12; }
  }
  missileFlash = Math.max(0, missileFlash - dt);
  hurtFlash = Math.max(0, hurtFlash - dt * 1.5);
  shake = Math.max(0, shake - dt * 2.2);
  if (world) world.shake = shake;
  // Nearly dead: a slow alarm until you're fixed (respawn) or down.
  critT -= dt;
  if (!hangarUp && !game.plane.crashed && game.hp > 0 && game.hp <= CONFIG.CRITICAL_HP && critT <= 0) { SFX.critical(); critT = 0.9; }
  // Warning tones: a slow beep while something locks you, fast and rising as a missile closes.
  warnT -= dt;
  if (warnT <= 0 && !game.plane.crashed && !hangarUp) {
    const m = game.warn.missile;
    if (m) { SFX.warnMissile(m.dist < CONFIG.BREAK_DIST[1]); warnT = clamp(m.dist / 4000, 0.07, 0.3); }
    else if (game.warn.lock) { SFX.warnLock(); warnT = 0.45; }
  }
  const gp = game.plane;
  if (hangarUp) engineSet(hang.throttle * 0.8, true, game.crew || gp.spec.PROP);   // (on the stand: the throttle runs it up)
  else engineSet((gp.speed - gp.spec.SPEED_MIN) / (gp.spec.SPEED_MAX - gp.spec.SPEED_MIN), !gp.crashed && !(gp.engineCut > 0), gp.spec.PROP);
  // WW2 wing over-stressed: creaks, faster the closer it is to letting go.
  creakT -= dt;
  if (!hangarUp && gp.spec.G_LIMIT && !gp.crashed && gp.overG > gp.spec.OVER_G_WARN && creakT <= 0) {
    SFX.creak(gp.overG > 1);
    creakT = gp.overG > 1 ? clamp(0.35 - gp.wingStress * 0.3, 0.06, 0.35) : 0.5;
  }
  for (const f of flashes) f.age += dt;
  flashes = flashes.filter(f => f.age < 1.4);

  // The anime look draws on a fixed 24 fps cadence; the game, input and sound above run every frame.
  sinceDraw += dt;
  drawAcc += dt;
  // Any cap below 60 uses the same cadence: fewer pictures leave the GPU to the hand tracking.
  const cap = settings.anime ? CONFIG.ANIME_FPS : settings.maxFps;
  const step = 1 / cap;
  const capped = cap < 60;
  const draw = !capped || drawAcc >= step;
  if (capped) { if (draw) drawAcc = drawAcc - step > step ? 0 : drawAcc - step; } else drawAcc = 0;
  if (draw) {
    const view = Object.create(game);
    view.events = pendingEvents;
    if (hangarUp) renderHangar(world, hang, game.crew ? 'bomber' : game.plane.type, sinceDraw, now, headOn && !game.crew ? head.look : null);
    else renderWorld(world, view, sinceDraw, now, camera && !game.crew ? head.look : null, ctrl);   // (a turret: the head swings the gun)
    pendingEvents = [];
    sinceDraw = 0;
    perf.draws++;
  }

  const assigned = camera ? controls.assigned : { fly: null, thr: null };
  let warn = '';
  if (camera && !assigned.fly && !kbActive) warn = 'SHOW YOUR FLYING HAND';
  else if (camera && controls.edge) warn = 'HAND AT EDGE OF CAMERA — bring it toward the middle';
  else if (camera && controls.offCentre && !kbActive) warn = 'Hand is still but the plane is still steering — press C to re-centre';
  else if (camera && !isCalibrated(settings)) warn = 'Press C to calibrate';
  if (draw) (hangarUp ? drawHangar : drawHud)(hctx, W, H, {
    game, world, settings, ctrl: controls, flashes, debug, camera, video, assigned, calib, warn, face, head, recorder, now,
    throttle: ctrl.throttle, gun: ctrl.gun, missileFlash, hurt: hurtFlash, duel, gunner: gunIn,
    status: camera ? (window.Tracker && Tracker.ready ? statusLine() : 'camera starting…') : '',
    perf: perfLine(camera),
    hangar: hangarUp ? hangarView() : null,
  });
  if (!camera) {
    controls.raw = { roll: kb.roll, pitch: kb.pitch, yaw: kb.yaw };
    controls.out = { ...controls.out, roll: kb.roll, pitch: kb.pitch, yaw: kb.yaw };
  }
  perfSample(ts, performance.now() - workStart);
  requestAnimationFrame(frame);
}

// Frames per second, and how long our JS takes per frame (hand detection included).
// GPU time isn't in "ms": if fps is low but ms is small, the GPU is the bottleneck.
const perf = { frames: 0, since: 0, fps: 0, workMs: 0, draws: 0, drawFps: 0 };

function perfSample(ts, workMs) {
  perf.workMs += (workMs - perf.workMs) * 0.05;
  perf.frames++;
  if (ts - perf.since >= 1000) {
    perf.fps = perf.frames * 1000 / (ts - perf.since);
    perf.drawFps = perf.draws * 1000 / (ts - perf.since);
    perf.frames = 0;
    perf.draws = 0;
    perf.since = ts;
  }
}

function perfLine(camera) {
  let s = Math.round(perf.fps) + ' fps (drawn ' + Math.round(perf.drawFps) + ') · ' + perf.workMs.toFixed(1) + ' ms js';
  if (camera && window.Tracker) s += ' · hands ' + Math.round(Tracker.fps) + ' Hz on ' + Tracker.delegate + ', ' + Tracker.detectMs.toFixed(1) + ' ms'
    + (Tracker.mode === 'worker' ? ' (background)' : ' (main thread)') + ' · sees ' + Tracker.handsSeen + ' hand' + (Tracker.handsSeen === 1 ? '' : 's')
    + (Tracker.lastError ? ' · ERROR ' + Tracker.lastError.slice(0, 60) : '')
    + (Tracker.faceDetector ? ' · face ' + Tracker.faceMs.toFixed(1) + ' ms' : ' · NO FACE MODEL (head look off)' + (Tracker.faceError ? ': ' + Tracker.faceError.slice(0, 60) : ''));
  return s + ' · x' + settings.renderScale;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  hudCanvas.width = W * dpr;
  hudCanvas.height = H * dpr;
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (world) resizeWorld(world, W, H);
}

function buildPanel() {
  const panel = document.getElementById('panel');
  // The Keys & settings menu: remember which parts were left open. A clicked summary or slider keeps
  // focus, and then Space (guns) / the arrows (flying) would toggle or slide it: let go of focus.
  document.querySelectorAll('#menu, #menu details').forEach((d, i) => {
    const key = 'sky-ace-menu-' + i;
    try { const v = localStorage.getItem(key); if (v !== null) d.open = v === '1'; } catch (e) { /* private window */ }
    d.addEventListener('toggle', () => { try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) { /* private window */ } });
  });
  document.getElementById('menu').addEventListener('pointerup', () => setTimeout(() => document.activeElement && document.activeElement.blur(), 0));
  for (const sl of CONFIG.SLIDERS) {
    const row = document.createElement('label');
    row.className = 'slider-row';
    const name = document.createElement('span');
    const val = document.createElement('b');
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: sl.min, max: sl.max, step: sl.step, value: settings[sl.key] });
    name.textContent = sl.label;
    val.textContent = settings[sl.key];
    input.addEventListener('input', () => {
      settings[sl.key] = Number(input.value);
      val.textContent = input.value;
      saveSettings();
      if (sl.key === 'renderScale' && world) { world.renderer.setPixelRatio(settings.renderScale); resize(); }
    });
    row.append(name, val, input);
    panel.appendChild(row);
  }
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (id) document.getElementById(id).classList.add('active');
}

// With the camera you wait in the hangar while the hand model loads, and fly solo from there
// (Enter takes off). Keyboard-only solo goes straight up; Esc brings the hangar back.
async function start(useCamera, duelOpts) {
  ac();
  if (loading) return;
  const msg = document.getElementById('start-msg');
  mode = useCamera ? 'camera' : 'keyboard';
  if (!world) {
    world = createWorld(glCanvas, settings.renderScale);
    if (settings.anime) setAnime(world, true);
    resize();
    requestAnimationFrame(frame);
  }
  showScreen(null);
  document.body.classList.toggle('debug', debug);
  if (!duelOpts) {
    game = newGame(modePick.value);
    gunIn = createGunnerInput();
    kbGun = { az: 0, el: 20 * DEG };
  }
  hangarSolo = !duelOpts;
  hang.paused = false;
  if (useCamera || duelOpts) openMenu();
  if (useCamera) {
    loading = 'Starting the camera and the hand model (a few seconds the first time)…';
    try {
      if (!window.Tracker) throw new Error('Tracker module did not load (open it over http/https — start.bat locally — not by double-clicking the file)');
      await Tracker.init(video);
    } catch (err) {
      console.error(err);
      loading = null;
      hangarSolo = false;
      mode = 'keyboard';
      showScreen('screen-start');
      msg.textContent = 'Camera failed: ' + err.message + '. You can still fly with the keyboard.';
      return;
    }
    loading = null;
  }
  if (!useCamera && !duelOpts) takeOff();
  if (duelOpts) duelConnect(duelOpts.name, duelOpts.host, duelOpts.mode);
  else if (useCamera && !isCalibrated(settings) && !game.crew) startCalibration();   // (a turret needs no calibration: grabbing it is the centre)
}

// The hangar opens the Keys & settings menu: tuning is what it's for.
function openMenu() {
  const m = document.getElementById('menu');
  if (!m.open) m.open = true;
}

function toggle(key, a, b, text) {
  settings[key] = settings[key] === a ? b : a;
  saveSettings();
  controls = createControls();
  head = createHead();
  flash(text(settings[key]), HUD.ink);
}

// Start screen: mode, plane and minimal HUD.
const modePick = document.getElementById('mode-pick');
if (new URLSearchParams(location.search).has('dogfight')) modePick.value = 'dogfight';
const planePick = document.getElementById('plane-pick'), minHudBox = document.getElementById('min-hud'), reloadBox = document.getElementById('reload-guns');
reloadBox.checked = settings.reload !== false;
reloadBox.addEventListener('change', () => { settings.reload = reloadBox.checked; saveSettings(); });
planePick.value = PLANES[settings.plane] ? settings.plane : DEFAULT_PLANE;
minHudBox.checked = !!settings.minHud;
planePick.addEventListener('change', () => {
  settings.plane = planePick.value;
  saveSettings();
  if (!duel && !game.solo) game = createGame(Date.now() % 100000, game.mode, settings.plane);
});
minHudBox.addEventListener('change', () => { settings.minHud = minHudBox.checked; saveSettings(); });

document.getElementById('btn-camera').addEventListener('click', () => start(true));
document.getElementById('btn-keys').addEventListener('click', () => start(false));
document.getElementById('btn-takeoff').addEventListener('click', e => { e.currentTarget.blur(); takeOff(); });

// Duel start: name + host address (blank = this laptop hosts), remembered for next time.
function duelOptsFromForm() {
  const name = document.getElementById('duel-name').value.trim() || 'Pilot';
  const host = document.getElementById('duel-host').value.trim();
  try { localStorage.setItem('sky-ace-duel', JSON.stringify({ name, host })); } catch (e) { /* private window */ }
  return { name, host };
}
try {
  const saved = JSON.parse(localStorage.getItem('sky-ace-duel'));
  if (saved) { document.getElementById('duel-name').value = saved.name || ''; document.getElementById('duel-host').value = saved.host || ''; }
} catch (e) { /* nothing saved */ }
// From https (the Vercel site) a browser won't open a plain ws:// connection to a laptop, and the
// camera needs localhost: duels only work from a local copy started with start.bat / start.command.
if (location.protocol === 'https:') {
  document.querySelector('.duel-box').innerHTML = '<p class="small"><b>Duels</b> run from a local copy: download the game, run start.bat '
    + '(Windows) or start.command (Mac), and pick Duel there. Browsers block this site from talking to a laptop on your Wi-Fi.</p>';
} else {
  document.getElementById('btn-duel-cam').addEventListener('click', () => start(true, duelOptsFromForm()));
  document.getElementById('btn-duel-keys').addEventListener('click', () => start(false, duelOptsFromForm()));
  document.getElementById('btn-escort-cam').addEventListener('click', () => start(true, { ...duelOptsFromForm(), mode: 'escort' }));
  document.getElementById('btn-escort-keys').addEventListener('click', () => start(false, { ...duelOptsFromForm(), mode: 'escort' }));
}

const PREVENT = ['Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];
window.addEventListener('keydown', e => {
  if (PREVENT.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (!world) return;
  if (e.code === 'KeyD') { debug = !debug; document.body.classList.toggle('debug', debug); }
  if (e.code === 'KeyC') startCalibration();
  if (e.code === 'Escape') {
    const busy = calib || recorder;
    if (calib && calib.phase === 'range') finishRange(true);
    calib = null;
    if (recorder) { recorder = null; flash('RECORDING CANCELLED', HUD.dim); }
    // Nothing to cancel: back to the hangar (solo; the game waits). Enter takes off again.
    if (!busy && !duel && !hangarSolo) { hangarSolo = true; hang.paused = true; openMenu(); }
  }
  if (e.code === 'Enter' && !duel && hangarSolo) takeOff();
  if (e.code === 'KeyG' && !duel) startRecording();
  if (e.code === 'KeyV') world.view = world.view === 'chase' ? 'cockpit' : 'chase';
  if (e.code === 'Enter' && duel) {
    if (duel.phase === 'calib') { calib = null; duelReady(); }
    if (duel.phase === 'over') duelSend({ t: 'rematch' });
  }
  if (e.code === 'KeyR' && !duel) { game = newGame(gameKind(game)); gunIn = createGunnerInput(); kbGun = { az: 0, el: 20 * DEG }; hang.paused = false; flash(game.solo ? 'NEW MISSION' : 'RESET', HUD.ink); }
  if (e.code === 'KeyN' && !duel && !game.solo) {
    if (game.bombers.filter(b => b.alive).length < CONFIG.BOMBER_MAX) spawnBomber(game);
    else flash('BOMBERS: ' + CONFIG.BOMBER_MAX + ' AT ONCE', HUD.dim);
  }
  if (e.code === 'KeyK' && game.solo) flash('THE MISSION PICKS YOUR PLANE', HUD.dim);
  if (e.code === 'KeyK' && !duel && !game.solo) {
    const i = PLANE_ORDER.indexOf(settings.plane);
    settings.plane = PLANE_ORDER[(i + 1) % PLANE_ORDER.length];
    saveSettings();
    game = createGame(Date.now() % 100000, game.mode, settings.plane);
    flash(planeSpec(settings.plane).name, HUD.ink);
  }
  if (e.code === 'KeyU') {
    settings.minHud = !settings.minHud;
    saveSettings();
    flash(settings.minHud ? 'MINIMAL HUD — no markers, find them yourself' : 'FULL HUD', HUD.ink);
  }
  if (e.code === 'KeyB' && !duel) {
    game = newGame(game.mode === 'range' ? 'dogfight' : 'range');
    flash(game.mode === 'dogfight' ? 'DOGFIGHT — bandits incoming' : 'TEST RANGE', HUD.ink);
  }
  if (e.code === 'Digit1' && settings.scheme !== 'flat') toggle('scheme', 'flat', 'stick', () => 'FLAT HAND');
  if (e.code === 'Digit2' && settings.scheme !== 'stick') toggle('scheme', 'flat', 'stick', () => 'FLIGHT STICK');
  if (e.code === 'KeyM') {
    settings.assist = { ...settings.assist, [settings.scheme]: !assistOn(settings) };
    saveSettings();
    flash(assistOn(settings) ? 'ASSIST: hand angle = bank angle (holds the bank)' : 'RATE: stick = how fast it turns (hold = aileron roll)', HUD.ink);
  }
  if (e.code === 'KeyP') toggle('pitchSrc', 'tilt', 'height', v => 'PITCH FROM PALM ' + (v === 'tilt' ? 'TILT' : 'HEIGHT'));
  if (e.code === 'KeyL') toggle('headLook', true, false, v => (v ? 'HEAD LOOK ON' : 'HEAD LOOK OFF'));
  if (e.code === 'KeyT') {
    settings.anime = !settings.anime;
    saveSettings();
    setAnime(world, settings.anime);
    flash(settings.anime ? 'ANIME LOOK: 24 fps, cel shading, ink' : 'NORMAL LOOK', HUD.ink);
  }
  if (e.code === 'KeyY') toggle('thrRudder', false, true, v => (v ? 'RUDDER: turn your left hand like a dial' : 'RUDDER: Q/E keys only'));
  if (e.code === 'KeyI') toggle('invertPitch', false, true, v => (v ? 'PITCH INVERTED' : 'PITCH NORMAL'));
  if (e.code === 'KeyH') toggle('hand', 'right', 'left', v => 'FLYING HAND: ' + v.toUpperCase());
  if ((e.code === 'Digit1' || e.code === 'Digit2') && mode === 'camera' && !isCalibrated(settings)) startCalibration();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', resize);

resize();
buildPanel();
// index.html?keys skips the start screen straight into keyboard flying.
if (new URLSearchParams(location.search).has('keys')) start(false);

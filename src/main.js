// main.js — wiring, settings, keyboard fallback, game loop.

const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');
const hctx = hudCanvas.getContext('2d');
const video = document.getElementById('cam');

let settings = loadSettings();
let controls = createControls();
// ?dogfight starts in dogfight mode (B toggles in game).
let game = createGame(Date.now() % 100000, new URLSearchParams(location.search).has('dogfight') ? 'dogfight' : 'range');
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
let lockTickT = 0;
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
    s.version = 8;
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

function flash(text, color) {
  flashes.push({ text, color, age: 0 });
  if (flashes.length > 3) flashes.shift();
}

function startCalibration(seconds) {
  if (mode !== 'camera') return;
  calib = { phase: 'centre', left: seconds || CONFIG.CALIB_COUNTDOWN };
  SFX.calib();
}

// Second step: sweep both hands to their limits; each direction's reach becomes full deflection.
function finishRange(skip) {
  const sweep = calib.sweep;
  calib = null;
  if (skip) { flash('RANGE SKIPPED — kept the previous range', HUD.dim); return; }
  const set = rangeSweepFinish(sweep, settings);
  controls = createControls();
  saveSettings();
  SFX.ring();
  flash(set.length ? 'RANGE SET: ' + set.join(', ') : 'NO MOVEMENT SEEN — range unchanged', set.length ? HUD.green : HUD.amber);
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
      if (clapUpdate(clap, hands, now) && !recorder && !calib) {
        flash('CLAP CLAP — CALIBRATING', HUD.green);
        startCalibration(CONFIG.CLAP_COUNTDOWN);
      }
    }
  }
  if (camera) controlsUpdate(controls, hands, now, settings, fresh);
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
    gun: keys.has('Space') || (camera && controls.out.gun),
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
  // "push forward" or spins while their hand finds the stick again.
  if (!recorder && !calib) gameUpdate(game, ctrl, dt);
  else game.events.length = 0;
  pendingEvents.push(...game.events);
  for (const e of game.events) {
    if (e.type === 'gun') SFX.gun();
    if (e.type === 'missile') { SFX.missile(); missileFlash = 0.4; }
    if (e.type === 'kill') {
      SFX.kill();
      flash(e.bandit ? (e.how === 'crashed' ? SKILLS[e.skill].name + ' FLEW INTO THE GROUND' : 'SPLASH ONE — ' + SKILLS[e.skill].name + ' DOWN') : 'SPLASH ONE', HUD.green);
    }
    if (e.type === 'bandit') flash('BANDIT — ' + SKILLS[e.skill].name, HUD.red);
    if (e.type === 'hit') SFX.hit();
    if (e.type === 'hurt') { SFX.hurt(); hurtFlash = Math.min(0.6, hurtFlash + 0.25); }
    if (e.type === 'enemy-missile') SFX.enemyLaunch();
    if (e.type === 'enemy-gun') SFX.enemyGun();
    if (e.type === 'shot-down') SFX.crash();
    if (e.type === 'boom') SFX.boom();
    if (e.type === 'crash') SFX.crash();
    if (e.type === 'ring') { SFX.ring(); flash('RING +50', HUD.amber); }
    if (e.type === 'ring-miss') { SFX.ringMiss(); flash('MISSED RING', HUD.dim); }
    if (e.type === 'lock') SFX.locked();
  }
  if (game.lock.target && !game.lock.locked) {
    lockTickT -= dt;
    if (lockTickT <= 0) { SFX.lockTick(); lockTickT = 0.12; }
  }
  missileFlash = Math.max(0, missileFlash - dt);
  hurtFlash = Math.max(0, hurtFlash - dt * 1.5);
  // Warning tones: a slow beep while something locks you, fast and rising as a missile closes.
  warnT -= dt;
  if (warnT <= 0 && !game.plane.crashed) {
    const m = game.warn.missile;
    if (m) { SFX.warnMissile(m.dist < CONFIG.BREAK_DIST[1]); warnT = clamp(m.dist / 4000, 0.07, 0.3); }
    else if (game.warn.lock) { SFX.warnLock(); warnT = 0.45; }
  }
  engineSet((game.plane.speed - CONFIG.SPEED_MIN) / (CONFIG.SPEED_MAX - CONFIG.SPEED_MIN), !game.plane.crashed);
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
    renderWorld(world, view, sinceDraw, now, camera ? head.look : null, ctrl);
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
  if (draw) drawHud(hctx, W, H, {
    game, world, settings, ctrl: controls, flashes, debug, camera, video, assigned, calib, warn, face, head, recorder, now,
    throttle: ctrl.throttle, gun: ctrl.gun, missileFlash, hurt: hurtFlash,
    status: camera ? statusLine() : '',
    perf: perfLine(camera),
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

async function start(useCamera) {
  ac();
  const msg = document.getElementById('start-msg');
  if (useCamera) {
    msg.textContent = 'Starting camera and hand model…';
    try {
      if (!window.Tracker) throw new Error('Tracker module did not load (open it over http/https — start.bat locally — not by double-clicking the file)');
      await Tracker.init(video);
    } catch (err) {
      console.error(err);
      msg.textContent = 'Camera failed: ' + err.message + '. You can still fly with the keyboard.';
      return;
    }
  }
  mode = useCamera ? 'camera' : 'keyboard';
  world = createWorld(glCanvas, settings.renderScale);
  if (settings.anime) setAnime(world, true);
  resize();
  showScreen(null);
  document.body.classList.toggle('debug', debug);
  if (useCamera && !isCalibrated(settings)) startCalibration();
  requestAnimationFrame(frame);
}

function toggle(key, a, b, text) {
  settings[key] = settings[key] === a ? b : a;
  saveSettings();
  controls = createControls();
  head = createHead();
  flash(text(settings[key]), HUD.ink);
}

document.getElementById('btn-camera').addEventListener('click', () => start(true));
document.getElementById('btn-keys').addEventListener('click', () => start(false));

const PREVENT = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];
window.addEventListener('keydown', e => {
  if (PREVENT.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (!world) return;
  if (e.code === 'KeyD') { debug = !debug; document.body.classList.toggle('debug', debug); }
  if (e.code === 'KeyC') startCalibration();
  if (e.code === 'Escape') { if (calib && calib.phase === 'range') finishRange(true); calib = null; if (recorder) { recorder = null; flash('RECORDING CANCELLED', HUD.dim); } }
  if (e.code === 'KeyG') startRecording();
  if (e.code === 'KeyV') world.view = world.view === 'chase' ? 'cockpit' : 'chase';
  if (e.code === 'KeyR') { game = createGame(Date.now() % 100000, game.mode); flash('RESET', HUD.ink); }
  if (e.code === 'KeyB') {
    game = createGame(Date.now() % 100000, game.mode === 'range' ? 'dogfight' : 'range');
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

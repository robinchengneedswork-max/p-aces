// audio.js — procedural sounds, lazy AudioContext.

let audioCtx = null;
let engine = null;

function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function noiseBuffer(dur) {
  const c = ac();
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseBurst(dur, freq, gain, freqTo) {
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(dur);
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(freq, c.currentTime);
  if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start();
}

function tone(freq, dur, type, gain, slideTo) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + dur);
}

// A looping noise roar whose filter opens with speed.
function engineSet(speed01, on) {
  const c = ac();
  if (!engine) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(2);
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
    engine = { f, g };
  }
  engine.f.frequency.setTargetAtTime(250 + speed01 * 900, c.currentTime, 0.1);
  engine.g.gain.setTargetAtTime(on ? 0.06 + speed01 * 0.06 : 0, c.currentTime, 0.2);
}

const SFX = {
  gun() { noiseBurst(0.05, 3000, 0.18); },
  missile() { noiseBurst(0.9, 3000, 0.35, 400); },
  kill() { noiseBurst(1.2, 900, 0.7, 80); tone(90, 0.6, 'sine', 0.3, 30); },
  boom() { noiseBurst(0.6, 700, 0.3, 80); },
  crash() { noiseBurst(1.8, 1200, 0.9, 60); },
  ring() { tone(880, 0.12, 'triangle', 0.25); setTimeout(() => tone(1320, 0.18, 'triangle', 0.2), 70); },
  ringMiss() { tone(220, 0.25, 'square', 0.08, 160); },
  lockTick() { tone(1100, 0.05, 'square', 0.06); },
  locked() { tone(1600, 0.25, 'square', 0.08); },
  calib() { tone(660, 0.15, 'sine', 0.2); },
  hit() { tone(2400, 0.04, 'square', 0.05); },
  hurt() { noiseBurst(0.12, 1800, 0.35, 300); },
  enemyGun() { noiseBurst(0.04, 1500, 0.05); },
  enemyLaunch() { tone(520, 0.35, 'sawtooth', 0.08, 1040); },
  critical() { tone(440, 0.18, 'sawtooth', 0.06, 330); },
  warnLock() { tone(880, 0.12, 'square', 0.05); },
  warnMissile(close) { tone(close ? 1700 : 1300, 0.06, 'square', 0.07); },
};

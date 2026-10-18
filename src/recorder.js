// recorder.js — guided gesture recording (G): asks for each stick motion in turn and records
// what the camera saw, so the hand → control mapping can be tuned from real data
// (tools/analyze-recording.js). Pure: no DOM; main.js uploads the result.
//
// Each step has a 'ready' phase (return to centre, read the next instruction) and a 'hold'
// phase (do the motion and hold it). Both are recorded; analysis mostly uses 'hold'.

const RECORD_READY = 2.5;
const RECORD_HOLD = 3;

const RECORD_STEPS = [
  { id: 'neutral', say: 'Hold the stick CENTRED, relaxed' },
  { id: 'pull', say: 'PULL BACK fully (nose up) and hold' },
  { id: 'push', say: 'PUSH FORWARD fully (nose down) and hold' },
  { id: 'roll-left', say: 'ROLL LEFT fully and hold' },
  { id: 'roll-right', say: 'ROLL RIGHT fully and hold' },
  { id: 'half-pull', say: 'Pull back HALF way and hold' },
  { id: 'pull-right', say: 'Pull back AND roll right (a hard right turn)' },
  { id: 'circle', say: 'Slowly STIR the stick round in circles', hold: 8 },
];

function createRecorder(t) {
  return { t0: t, i: 0, phase: 'ready', phaseStart: t, frames: [], done: false };
}

function recorderHoldTime(step) {
  return step.hold || RECORD_HOLD;
}

// Advance through the phases by time. Returns the recorder.
function recorderStep(rec, t) {
  if (rec.done) return rec;
  const step = RECORD_STEPS[rec.i];
  const len = rec.phase === 'ready' ? RECORD_READY : recorderHoldTime(step);
  if (t - rec.phaseStart < len) return rec;
  rec.phaseStart = t;
  if (rec.phase === 'ready') rec.phase = 'hold';
  else if (rec.i + 1 < RECORD_STEPS.length) { rec.i++; rec.phase = 'ready'; }
  else rec.done = true;
  return rec;
}

// What's left of the current phase, 0..1, for the progress bar.
function recorderProgress(rec, t) {
  const step = RECORD_STEPS[rec.i];
  const len = rec.phase === 'ready' ? RECORD_READY : recorderHoldTime(step);
  return clamp((t - rec.phaseStart) / len, 0, 1);
}

const r4 = x => Math.round(x * 10000) / 10000;

function handSample(h) {
  if (!h) return null;
  const m = measureHand(h);
  const mm = {};
  for (const k of Object.keys(m)) if (typeof m[k] === 'number') mm[k] = r4(m[k]);
  return {
    m: mm,
    lm: h.lm.map(p => [r4(p.x), r4(p.y), r4(p.z)]),
    w: h.world.map(p => [r4(p.x), r4(p.y), r4(p.z)]),
  };
}

// One camera frame: both hands as assigned, plus what the controls made of it.
function recorderAdd(rec, t, hands, s, controls) {
  if (rec.done) return;
  const { fly, thr } = controls.assigned;
  rec.frames.push({
    t: r4(t - rec.t0),
    step: RECORD_STEPS[rec.i].id,
    phase: rec.phase,
    n: hands.length,
    fly: handSample(fly),
    thr: thr ? { m: handSample(thr).m } : null,
    raw: { roll: r4(controls.raw.roll), pitch: r4(controls.raw.pitch), yaw: r4(controls.raw.yaw) },
    out: { roll: r4(controls.out.roll), pitch: r4(controls.out.pitch), yaw: r4(controls.out.yaw) },
  });
}

// The recording's 'centred' hold, as a stick neutral: a fresher calibration than C's, taken
// right before the motions it's compared with.
function neutralFromRecording(rec) {
  const hold = rec.frames.filter(f => f.step === 'neutral' && f.phase === 'hold' && f.fly);
  if (hold.length < 5) return null;
  const t0 = hold[0].t;
  // Re-measured from the saved landmarks, so the stick axes come back too.
  const pt = ([x, y, z]) => ({ x, y, z });
  const fs = hold.filter(f => f.t - t0 >= 0.5).map(f => measureHand({ lm: f.fly.lm.map(pt), world: f.fly.w.map(pt) }));
  if (fs.length < 5) return null;
  const avg = k => fs.reduce((a, m) => a + m[k], 0) / fs.length;
  const avgAxis = k => vNorm(fs.reduce((a, m) => vAdd(a, m[k]), v3(0, 0, 0)));
  const r0 = fs[0].roll, p0 = fs[0].pitch;
  return {
    roll: r0 + fs.reduce((a, m) => a + foldHalf(m.roll - r0), 0) / fs.length,
    pitch: p0 + fs.reduce((a, m) => a + wrapAngle(m.pitch - p0), 0) / fs.length,
    cx: avg('cx'), cy: avg('cy'), scale: avg('scale'), axI: avgAxis('axI'), axW: avgAxis('axW'),
  };
}

function recorderResult(rec, s, meta) {
  return {
    meta: {
      ...meta,
      scheme: s.scheme,
      hand: s.hand,
      neutral: neutralFor(s),
      settings: { stickPitch: s.stickPitch, stickThrow: s.stickThrow, rollRange: s.rollRange,
        pitchRange: s.pitchRange, deadzone: s.deadzone, expo: s.expo, invertPitch: s.invertPitch,
        thrRudder: s.thrRudder, yawRange: s.yawRange, thrNeutral: s.neutral && s.neutral.thr },
      steps: RECORD_STEPS.map(st => ({ id: st.id, say: st.say })),
      ready: RECORD_READY,
      hold: RECORD_HOLD,
    },
    frames: rec.frames,
  };
}

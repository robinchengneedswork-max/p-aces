// head.js — MediaPipe Face Detector keypoints → camera look direction. Pure: no DOM.
// The detector gives 6 points: [0] right eye, [1] left eye, [2] nose tip, [3] mouth,
// [4] right ear, [5] left ear (x mirrored by main.js, y down, image units).
//
// Turning your head moves the nose tip sideways relative to the ears and eyes; nodding moves it
// up/down relative to the eyes. Both are divided by face width, so distance doesn't matter.
// Small head turns are amplified (headGain) so you can glance far around while still seeing
// the screen.

const FK = { R_EYE: 0, L_EYE: 1, NOSE: 2, MOUTH: 3, R_EAR: 4, L_EAR: 5 };

function measureFace(kp) {
  const eyeMid = { x: (kp[FK.R_EYE].x + kp[FK.L_EYE].x) / 2, y: (kp[FK.R_EYE].y + kp[FK.L_EYE].y) / 2 };
  const earMid = { x: (kp[FK.R_EAR].x + kp[FK.L_EAR].x) / 2, y: (kp[FK.R_EAR].y + kp[FK.L_EAR].y) / 2 };
  const eyeW = Math.hypot(kp[FK.R_EYE].x - kp[FK.L_EYE].x, kp[FK.R_EYE].y - kp[FK.L_EYE].y) || 1e-3;
  const earW = Math.hypot(kp[FK.R_EAR].x - kp[FK.L_EAR].x, kp[FK.R_EAR].y - kp[FK.L_EAR].y) || 1e-3;
  const nose = kp[FK.NOSE];
  // + = turned to the player's right (mirrored screen right). Ears and eyes averaged: each is noisy alone.
  const yaw = ((nose.x - earMid.x) / earW + (nose.x - eyeMid.x) / eyeW * 0.5) / 2;
  // + = looking up (nose rises toward the eye line).
  const pitch = -(nose.y - eyeMid.y) / eyeW;
  return { yaw, pitch };
}

function createHead() {
  return {
    f: { yaw: createOneEuro(), pitch: createOneEuro() },
    m: null,                  // last measurement
    look: { yaw: 0, pitch: 0 }, // radians the camera turns
    seen: -1,
    lastT: 0,
  };
}

function headAxis(v, s) {
  const a = Math.abs(v);
  return a <= s.headDeadzone ? 0 : Math.sign(v) * (a - s.headDeadzone);
}

function headUpdate(h, kp, t, s) {
  const dt = Math.max(0, t - h.lastT);
  h.lastT = t;
  h.m = kp ? measureFace(kp) : null;
  if (!s.headLook) { h.look.yaw = 0; h.look.pitch = 0; return h; }
  // The nose tip sits well below the eye line, so pitch has no natural zero. Never calibrated:
  // average the first frames of face as "forward" (look stays put meanwhile).
  if (h.m && !s.headNeutral && (!h.auto || h.auto.n < CONFIG.HEAD_AUTO_FRAMES)) {
    h.auto = h.auto || { yaw: 0, pitch: 0, n: 0 };
    h.auto.yaw += h.m.yaw;
    h.auto.pitch += h.m.pitch;
    h.auto.n++;
    return h;
  }
  if (h.m) {
    const n = s.headNeutral || { yaw: h.auto.yaw / h.auto.n, pitch: h.auto.pitch / h.auto.n };
    const yaw = oneEuroStep(h.f.yaw, h.m.yaw - n.yaw, t, s.headSmooth, CONFIG.HEAD_BETA);
    const pitch = oneEuroStep(h.f.pitch, h.m.pitch - n.pitch, t, s.headSmooth, CONFIG.HEAD_BETA);
    const ty = clamp(headAxis(yaw, s) * s.headGain, -CONFIG.LOOK_MAX_YAW, CONFIG.LOOK_MAX_YAW);
    const tp = clamp(headAxis(pitch, s) * s.headGain * CONFIG.LOOK_PITCH_SCALE, -CONFIG.LOOK_MAX_PITCH, CONFIG.LOOK_MAX_PITCH);
    // The gain amplifies every tremor, so the view glides toward where the head points
    // instead of snapping to it.
    const k = 1 - Math.exp(-CONFIG.LOOK_EASE * dt);
    h.look.yaw += (ty - h.look.yaw) * k;
    h.look.pitch += (tp - h.look.pitch) * k;
    h.seen = t;
  } else if (t - h.seen > CONFIG.HAND_LOST_HOLD) {
    // Face gone (turned too far, or left the frame): ease the view back to forward.
    const k = Math.exp(-CONFIG.HAND_LOST_DECAY * dt);
    h.look.yaw *= k;
    h.look.pitch *= k;
    h.f = { yaw: createOneEuro(), pitch: createOneEuro() };
  }
  return h;
}

function calibrateHead(s, kp) {
  if (!kp) return false;
  s.headNeutral = measureFace(kp);
  return true;
}

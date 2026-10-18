// tracker-worker.js — MediaPipe hand + face tracking off the main thread. Hand detection takes
// ~45-55 ms a frame on the user's laptop; on the main thread that held the whole game to 16-21 fps.
// Here it runs beside the game: tracker.js posts one camera frame (ImageBitmap) at a time and
// gets landmarks back. Module worker, so it uses MediaPipe's module wasm loader.

import { FilesetResolver, HandLandmarker, FaceDetector } from '../vendor/mediapipe/vision_bundle.mjs';

const VENDOR = new URL('../vendor/mediapipe/', import.meta.url);
let hands = null, face = null, delegate = '', faceTick = 0, lastFace = null, faceError = '';

// MediaPipe's module wasm loader sets self.ModuleFactory once, as a side effect of being imported,
// and MediaPipe clears it after building a task. The second task (the face model) then imports the
// cached module, nothing runs, and it fails with "ModuleFactory not set." — which silently turned
// head look off. Put the factory back before every task.
async function restoreFactory(fileset) {
  if (!self.ModuleFactory) self.ModuleFactory = (await import(fileset.wasmLoaderPath)).default;
}

async function init(delegates) {
  const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', VENDOR).href, true);
  for (const d of delegates) {
    try {
      await restoreFactory(fileset);
      hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL('hand_landmarker.task', VENDOR).href, delegate: d },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        // Lower than default so a fist at an odd angle stays tracked instead of re-detecting.
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });
      delegate = d;
      break;
    } catch (err) {
      console.warn('[worker] HandLandmarker ' + d + ' failed', err);
    }
  }
  if (!hands) throw new Error('Could not start hand tracking in the worker');
  // Head look is a bonus: if the face model won't start, hands still work.
  try {
    await restoreFactory(fileset);
    face = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('blaze_face_short_range.tflite', VENDOR).href, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
  } catch (err) {
    console.warn('[worker] FaceDetector failed; head look disabled', err);
    faceError = String(err && err.message || err);
  }
}

function detect(bitmap, t) {
  const t0 = performance.now();
  const res = hands.detectForVideo(bitmap, t);
  const detectMs = performance.now() - t0;
  const out = (res.landmarks || []).map((lm, i) => ({ lm, world: res.worldLandmarks[i] }));
  let faceMs = 0;
  // Face every other frame: head look is heavily smoothed anyway.
  faceTick ^= 1;
  if (face && faceTick) {
    const t1 = performance.now();
    const fr = face.detectForVideo(bitmap, t);
    faceMs = performance.now() - t1;
    // Biggest face = the player, not someone walking past behind them.
    let best = null;
    for (const d of fr.detections || []) {
      const area = d.boundingBox ? d.boundingBox.width * d.boundingBox.height : 0;
      if (d.keypoints && d.keypoints.length >= 6 && (!best || area > best.area)) best = { area, kp: d.keypoints };
    }
    lastFace = best ? best.kp.map(k => ({ x: k.x, y: k.y })) : null;
  }
  return { hands: out, face: lastFace, detectMs, faceMs, hasFace: !!face };
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await init(m.delegates || ['GPU', 'CPU']);
      self.postMessage({ type: 'ready', delegate, hasFace: !!face, faceError });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  } else if (m.type === 'frame') {
    try {
      const r = detect(m.bitmap, m.t);
      self.postMessage({ type: 'result', t: m.t, ...r });
    } catch (err) {
      self.postMessage({ type: 'result', t: m.t, hands: [], face: lastFace, detectMs: 0, faceMs: 0, error: String(err && err.message || err) });
    } finally {
      m.bitmap.close();
    }
  }
};

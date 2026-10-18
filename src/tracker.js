// tracker.js — webcam + MediaPipe Hand Landmarker + Face Detector (for head look). ES module (MediaPipe ships as one);
// exposes window.Tracker for the classic scripts.
//
// Tracking runs in a worker (tracker-worker.js) so the game keeps drawing while a frame is being
// detected: on the main thread, ~50 ms detections held the game to 16-21 fps. If the worker can't
// start, it falls back to detecting on the main thread as before.

import { FilesetResolver, HandLandmarker, FaceDetector } from '../vendor/mediapipe/vision_bundle.mjs';

const WORKER_START_TIMEOUT = 30000;

const Tracker = {
  ready: false,
  mode: '',                  // 'worker' | 'main'
  video: null,
  landmarker: null,
  faceDetector: null,        // main mode: the detector; worker mode: true if the worker has one
  delegate: '',
  lastVideoTime: -1,
  fps: 0,
  detectMs: 0,
  faceMs: 0,
  faceTick: 0,
  lastFace: null,
  frames: 0,
  fpsSince: 0,
  worker: null,
  busy: false,               // worker mode: a frame is out being detected
  result: null,              // worker mode: newest result not yet handed to the game
  handsSeen: 0,              // hands in the newest result (diagnostics)
  lastError: '',             // newest detection error from the worker (diagnostics)

  // delegate: 'GPU' (falls back to CPU) or 'CPU'. GPU wins on the user's laptop even while sharing
  // with the game's drawing (22-26 Hz vs 14-15 Hz on CPU), so GPU is the default.
  async init(video, delegate) {
    this.delegates = delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
    this.video = video;
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    await video.play();
    try {
      // ?tracker=main forces the old main-thread path (a fallback while the worker is suspect).
      if (new URLSearchParams(location.search).get('tracker') === 'main') throw new Error('forced main thread by ?tracker=main');
      await this.startWorker();
      this.mode = 'worker';
    } catch (err) {
      console.warn('Tracking worker failed, detecting on the main thread instead', err);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      await this.startMain();
      this.mode = 'main';
    }
    this.fpsSince = performance.now();
    this.ready = true;
  },

  startWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./tracker-worker.js', import.meta.url), { type: 'module' });
      this.worker = w;
      const timer = setTimeout(() => reject(new Error('worker did not start in time')), WORKER_START_TIMEOUT);
      w.onerror = e => { clearTimeout(timer); reject(new Error(e.message || 'worker error')); };
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.delegate = m.delegate;
          w.onmessage = ev => this.onResult(ev.data);
          resolve();
        } else if (m.type === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      w.postMessage({ type: 'init', delegates: this.delegates });
    });
  },

  onResult(m) {
    if (m.type !== 'result') return;
    this.busy = false;
    if (m.error) { console.warn('[worker] detect failed', m.error); this.lastError = m.error; }
    this.detectMs += (m.detectMs - this.detectMs) * 0.1;
    if (m.faceMs) this.faceMs += (m.faceMs - this.faceMs) * 0.1;
    this.faceDetector = m.hasFace;
    this.countFrame(performance.now());
    this.result = { hands: m.hands, face: m.face };
    this.handsSeen = m.hands.length;
  },

  async startMain() {
    const fileset = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
    for (const delegate of this.delegates) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: 'vendor/mediapipe/hand_landmarker.task', delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          // Lower than default so a fist at an odd angle (pushed forward, knuckles at the camera)
          // stays tracked instead of dropping out and re-detecting.
          minHandPresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
        this.delegate = delegate;
        break;
      } catch (err) {
        console.warn('HandLandmarker ' + delegate + ' failed', err);
      }
    }
    if (!this.landmarker) throw new Error('Could not start hand tracking');
    // Head look is a bonus: if the face model won't start, hands still work.
    try {
      this.faceDetector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'vendor/mediapipe/blaze_face_short_range.tflite', delegate: this.delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
    } catch (err) {
      console.warn('FaceDetector failed; head look disabled', err);
    }
  },

  countFrame(nowMs) {
    this.frames++;
    if (nowMs - this.fpsSince >= 1000) {
      this.fps = this.frames * 1000 / (nowMs - this.fpsSince);
      this.frames = 0;
      this.fpsSince = nowMs;
    }
  },

  // null when there is no new tracking result; otherwise { hands: [{ lm, world }], face: 6 keypoints | null }
  // (raw, unmirrored). Worker mode: hands back the newest result and sends the next camera frame.
  detect(nowMs) {
    const v = this.video;
    if (!this.ready || v.readyState < 2) return null;
    if (this.mode === 'worker') {
      const out = this.result;
      this.result = null;
      // One frame in flight at a time: tracking never queues up behind the camera.
      if (!this.busy && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        this.busy = true;
        createImageBitmap(v).then(bitmap => {
          this.worker.postMessage({ type: 'frame', bitmap, t: nowMs }, [bitmap]);
        }, err => {
          console.warn('createImageBitmap failed', err);
          this.busy = false;
        });
      }
      return out;
    }
    if (v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(v, nowMs);
    // detectForVideo blocks the main thread, so its cost comes straight out of the frame budget.
    this.detectMs += (performance.now() - t0 - this.detectMs) * 0.1;
    this.countFrame(nowMs);
    const hands = (res.landmarks || []).map((lm, i) => ({ lm, world: res.worldLandmarks[i] }));
    this.handsSeen = hands.length;
    // Face runs every other camera frame: head look is heavily smoothed, and the recordings
    // showed hand tracking at 15-19 Hz, so the hands get the time.
    this.faceTick ^= 1;
    let face = this.lastFace;
    if (this.faceDetector && this.faceTick) {
      const t1 = performance.now();
      const fr = this.faceDetector.detectForVideo(v, nowMs);
      this.faceMs += (performance.now() - t1 - this.faceMs) * 0.1;
      // Biggest face = the player, not someone walking past behind them.
      let best = null;
      for (const d of fr.detections || []) {
        const area = d.boundingBox ? d.boundingBox.width * d.boundingBox.height : 0;
        if (d.keypoints && d.keypoints.length >= 6 && (!best || area > best.area)) best = { area, kp: d.keypoints };
      }
      face = best ? best.kp : null;
      this.lastFace = face;
    }
    return { hands, face };
  },
};

window.Tracker = Tracker;

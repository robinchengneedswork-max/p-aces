// tracker.js — webcam + MediaPipe Hand Landmarker + Face Detector (for head look). ES module (MediaPipe ships as one);
// exposes window.Tracker for the classic scripts.

import { FilesetResolver, HandLandmarker, FaceDetector } from '../vendor/mediapipe/vision_bundle.mjs';

const Tracker = {
  ready: false,
  video: null,
  landmarker: null,
  faceDetector: null,
  delegate: '',
  lastVideoTime: -1,
  fps: 0,
  detectMs: 0,
  faceMs: 0,
  frames: 0,
  fpsSince: 0,

  async init(video) {
    this.video = video;
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    await video.play();

    const fileset = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
    for (const delegate of ['GPU', 'CPU']) {
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
    this.fpsSince = performance.now();
    this.ready = true;
  },

  // null when there is no new camera frame; otherwise { hands: [{ lm, world }], face: 6 keypoints | null }
  // (raw, unmirrored).
  detect(nowMs) {
    const v = this.video;
    if (!this.ready || v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(v, nowMs);
    // detectForVideo blocks the main thread, so its cost comes straight out of the frame budget.
    this.detectMs += (performance.now() - t0 - this.detectMs) * 0.1;
    this.frames++;
    if (nowMs - this.fpsSince >= 1000) {
      this.fps = this.frames * 1000 / (nowMs - this.fpsSince);
      this.frames = 0;
      this.fpsSince = nowMs;
    }
    const hands = (res.landmarks || []).map((lm, i) => ({ lm, world: res.worldLandmarks[i] }));
    let face = null;
    if (this.faceDetector) {
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
    }
    return { hands, face };
  },
};

window.Tracker = Tracker;

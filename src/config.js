// config.js — tuning values. World units are metres; hand units are "palm lengths"
// (wrist to middle knuckle), so they hold at any distance from the camera.

const DEG = Math.PI / 180;

const CONFIG = {
  // Flight
  SPEED_MIN: 90,
  SPEED_MAX: 260,
  ACCEL: 0.6,                // speed approaches throttle target at this rate (1/s)
  CLIMB_DRAG: 40,            // m/s² lost per unit of nose-up (gravity, arcade-scaled)
  ROLL_RATE: 3.2,            // rad/s at full stick (expert)
  PITCH_RATE: 1.1,           // rad/s at full stick
  YAW_RATE: 0.35,
  MAX_BANK: 75 * DEG,        // assist: full stick = this bank angle
  BANK_GAIN: 4,              // assist: how hard it chases the target bank
  TURN_RATE: 0.75,           // assist: rad/s of heading change at 90° of bank
  LOOP_PITCH: 0.3,           // assist: pulling at least this hard past vertical/inverted = looping
  LOOP_UP: 0.2,              // …"inverted" = canopy pointing less than this far up
  LOOP_VERTICAL: 0.85,       // …"past vertical" = nose this steep (sin of ~58°)
  CEILING: 4000,
  CRASH_MARGIN: 4,
  RESPAWN_TIME: 2,
  START_ALT: 700,

  // Terrain
  TERRAIN_SIZE: 9600,
  TERRAIN_SEGS: 120,
  TERRAIN_RECENTER: 800,
  TERRAIN_HEIGHT: 900,

  // Weapons + targets
  GUN_RATE: 12,              // rounds/s
  GUN_SPEED: 900,
  GUN_LIFE: 1.4,
  MISSILE_SPEED: 420,
  MISSILE_TURN: 2.6,         // rad/s
  MISSILE_LIFE: 7,
  MISSILE_COOLDOWN: 1.2,
  LOCK_CONE: 20 * DEG,
  LOCK_RANGE: 2600,
  LOCK_TIME: 0.6,
  DRONE_COUNT: 5,
  DRONE_R: 22,               // hit radius
  DRONE_SPEED: 70,
  DRONE_SPAWN_DIST: [1500, 3200],
  DRONE_MAX_DIST: 6000,
  RING_R: 45,
  RING_AHEAD: 1300,

  // Hands → controls
  HAND_LOST_HOLD: 0.3,       // seconds to hold the last input after a hand vanishes
  STICK_LOST_HOLD: 0.6,      // a fist at an odd angle drops out more; hold it longer
  EDGE_MARGIN: 0.08,
  ROOM_MARGIN: 0.25,         // calibration warns if the stick centre is closer than this to an edge
  DEPTH_ROLL_MUTE: 0.7,      // full roll mutes the stick's depth (push/pull) term by this much
  STILL_TIME: 3,             // hand still this long (s)…
  STILL_MOVE: 0.15,          // …(moved less than this many palm lengths)…
  OFF_CENTRE: 0.35,          // …but still steering this hard = suggest re-centring         // warn when the flying hand's palm centre is this close to a frame edge
  HAND_LOST_DECAY: 3,        // then decays to centre at this rate (1/s)
  PINCH_ON: 0.32, PINCH_OFF: 0.5,
  FIST_ON: 1.2, FIST_OFF: 1.5,
  THROTTLE_LOW: 0.85, THROTTLE_HIGH: 0.3,  // image y of the throttle hand for 0 and full
  CALIB_COUNTDOWN: 3,

  // Head look
  LOOK_MAX_YAW: 160 * DEG,
  LOOK_MAX_PITCH: 60 * DEG,
  LOOK_PITCH_SCALE: 0.7,     // nodding is noisier than turning; amplify it less
  HEAD_AUTO_FRAMES: 15,      // uncalibrated: first ~0.5 s of face = "forward"
  HEAD_BETA: 0.15,           // One Euro speed term for the head (lower = calmer)
  LOOK_EASE: 5,              // view glides toward the head target at this rate (1/s)

  DEFAULTS: {
    hand: 'right',           // the hand that flies; the other one is throttle + weapons
    version: 4,
    scheme: 'stick',          // 'flat' (tilt a flat hand) | 'stick' (grip a fake stick)
    assist: { flat: true, stick: false }, // per scheme. true: hand angle = bank angle. false: rate (keep rolling)
    pitchSrc: 'tilt',        // flat scheme: 'tilt' the palm, or raise/lower the 'height'
    invertPitch: false,
    rollRange: 35,           // degrees of hand tilt for full roll
    pitchRange: 30,          // degrees of palm tilt for full pitch
    stickThrow: 1.2,         // palm lengths of fist travel for full deflection
    stickDepth: 0.25,        // stick: fist size change (log) for full pitch; 0.25 ≈ 28% bigger/smaller
    deadzone: 0.12,
    expo: 1.4,
    minCutoff: 1.0,          // One Euro filter: jitter vs lag
    beta: 0.6,
    renderScale: 1,          // pixels per CSS pixel; lower = faster on a laptop GPU
    twistRudder: false,
    headLook: true,          // turn your head to look around (face tracking)
    headGain: 11,            // radians of view per unit of nose offset (face widths)
    headDeadzone: 0.045,
    headSmooth: 0.35,        // One Euro min cutoff for the head
    headNeutral: null,       // { yaw, pitch } from calibration      // stick scheme: twisting the fist = rudder (leaks into rolls)
    neutral: null,           // { flat: {...}, stick: {...} } from calibration
  },
  SLIDERS: [
    { key: 'rollRange', label: 'Roll: tilt for full (°)', min: 10, max: 70, step: 1 },
    { key: 'pitchRange', label: 'Pitch: tilt for full (°)', min: 10, max: 70, step: 1 },
    { key: 'stickThrow', label: 'Stick throw (palms)', min: 0.3, max: 3, step: 0.05 },
    { key: 'stickDepth', label: 'Stick push/pull depth', min: 0.08, max: 0.8, step: 0.01 },
    { key: 'deadzone', label: 'Deadzone', min: 0, max: 0.4, step: 0.01 },
    { key: 'expo', label: 'Expo (1 = linear)', min: 1, max: 3, step: 0.05 },
    { key: 'minCutoff', label: 'Smooth (min cutoff)', min: 0.1, max: 5, step: 0.1 },
    { key: 'beta', label: 'Responsiveness (beta)', min: 0, max: 5, step: 0.1 },
    { key: 'renderScale', label: 'Render scale', min: 0.5, max: 2, step: 0.25 },
    { key: 'headGain', label: 'Head look gain', min: 1, max: 15, step: 0.5 },
    { key: 'headDeadzone', label: 'Head deadzone', min: 0, max: 0.1, step: 0.005 },
    { key: 'headSmooth', label: 'Head smooth (min cutoff)', min: 0.1, max: 3, step: 0.1 },
  ],
  STORAGE_KEY: 'sky-ace-settings',
};

// Default neutral poses until the player calibrates.
// flat: palm down, fingers pointing at the screen (palm tilt ≈ -70°). stick: fist mid-frame.
const DEFAULT_NEUTRAL = {
  flat: { roll: 0, pitch: -70 * DEG, cx: 0.5, cy: 0.55, scale: 0.12 },
  stick: { roll: 0, pitch: 0, cx: 0.5, cy: 0.6, scale: 0.12 },
};

// MediaPipe hand landmark indices
const HL = {
  WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_TIP: 16, PINKY_MCP: 17, PINKY_TIP: 20,
};

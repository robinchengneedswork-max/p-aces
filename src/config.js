// config.js — tuning values. World units are metres; hand units are "palm lengths"
// (wrist to middle knuckle), so they hold at any distance from the camera.

const DEG = Math.PI / 180;

const CONFIG = {
  // Flight
  SPEED_MIN: 90,
  SPEED_MAX: 260,
  ACCEL: 0.6,                // speed approaches throttle target at this rate (1/s): thrust minus drag
  CLIMB_DRAG: 55,            // m/s² lost per unit of climb (gravity, arcade-scaled; diving gains it): straight
                             // up holds ~170 m/s at full throttle, ~80 at half, stalls below ~0.3. 70 made
                             // a pull-up dodge bleed too fast: side-on missiles hit through a perfect break
  ROLL_RATE: 3.2,            // rad/s at full stick (rate mode), at ROLL_FULL_SPEED and up
  ROLL_FULL_SPEED: 130,      // slower than this, the ailerons bite less…
  ROLL_MIN: 0.6,             // …down to this share of ROLL_RATE
  PITCH_RATE: 0.96,          // rad/s at full pull, at CORNER_SPEED (the tightest turn). Was 1.2; user: "slightly
                             // slower turning, same feeling of speed" → every turn rate × 0.8, speeds untouched
  CORNER_SPEED: 170,         // best turning speed. Slower: the wings run out of lift (rate ∝ speed^LOW_EXP);
  PITCH_LOW_EXP: 0.8,        // faster: the g limit caps it (rate ∝ 1/speed). Throttle 0.5 cruises about here.
  PUSH_SHARE: 0.7,           // pushing (negative g) gets this share of the pull rate
  A_PER_G: 20.8,             // arcade m/s² per displayed g: a full pull at corner speed reads ~9 G (× 0.8 with the turns)
  TURN_BLEED: 0.85,          // m/s² of speed lost per (G-1)²: hard turns cost energy
  SLIP_GRIP: 7.2,            // how fast the flight path follows the nose (1/s) at corner speed: a hard
                             // pull runs ~7° of slip; slower = more slip (mushier)
  STALL_SPEED: 70,           // below this the nose drops on its own…
  STALL_DROP: 0.9,           // …at up to this rate (rad/s), and pulls fade out
  SPEED_FLOOR: 35,
  G_ONSET: 5,                // sustained G above this builds strain = tunnel vision. Looks only: it never
  G_STRAIN_TIME: 6,          // takes the stick (user). Builds at (G - onset) / this per second (a full pull
  G_RECOVER: 0.5,            // shows within ~1 s, heavy by ~3 s); drains this much per second below onset
  REDOUT_G: -2.5,            // pushing past this tints the view red
  YAW_RATE: 0.35,
  MAX_BANK: 75 * DEG,        // assist: full stick = this bank angle
  BANK_GAIN: 4,              // assist: how hard it chases the target bank
  TURN_RATE: 0.6,            // assist: rad/s of heading change at 90° of bank
  LOOP_PITCH: 0.3,           // assist: pulling at least this hard past vertical/inverted = looping
  LOOP_UP: 0.2,              // …"inverted" = canopy pointing less than this far up
  LOOP_VERTICAL: 0.85,       // …"past vertical" = nose this steep (sin of ~58°)
  CEILING: 15000,
  CRASH_MARGIN: 4,
  RESPAWN_TIME: 2,
  VAPOR_MIN_RATE: 0.28,      // wingtip vapour starts when the nose swings this fast (rad/s)…
  VAPOR_FULL_RATE: 0.44,     // …and is full this much faster again (a full pull is ~0.9 rad/s)
  VAPOR_LIFE: 1.4,           // seconds a trail lingers
  VAPOR_WIDTH: 0.35,         // half-width at the wingtip (m); widens as it drifts back
  START_ALT: 8000,           // metres above the ground at start/respawn (user: "try 8k and 15k")

  // Terrain
  TERRAIN_SIZE: 9600,
  TERRAIN_SEGS: 120,
  TERRAIN_RECENTER: 800,
  TERRAIN_HEIGHT: 900,
  FAR_TERRAIN_SIZE: 60000,   // a coarse ground layer under the detailed one, so from 8-15 km up there's
  FAR_TERRAIN_SEGS: 120,     // ground to the horizon (500 m cells)…
  FAR_RECENTER: 4000,        // …re-baked when you've flown this far
  FOG_BASE: 4600,            // fog ends this far away near the ground, plus FOG_PER_ALT × altitude
  FOG_PER_ALT: 1.6,
  FOG_MAX: 30000,

  // Weapons + targets
  GUN_RATE: 12,              // rounds/s
  GUN_SPEED: 900,
  GUN_LIFE: 1.4,
  GUN_RANGE: 800,            // lead marker turns green inside this (m)…
  GUN_LEAD_RANGE: 2500,      // …and is shown for the best target within this, and within…
  GUN_LEAD_CONE: 40 * DEG,   // …this far off your nose
  GUN_ASSIST_RANGE: 1100,    // magnetism works out to here
  MISSILE_SPEED: 420,
  MISSILE_TURN: 1.04,        // rad/s (× 0.8 with the planes). Missiles chase where you ARE (pure pursuit, no lead): then a hard
                             // break at the right moment beats one, flying straight never does. Yours
                             // turn a little harder than theirs (bandits get a narrower dodge window)
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

  // Dogfight (B): one bandit at a time, rookie → regular → ace
  PLAYER_HP: 100,
  CRITICAL_HP: 35,           // at or below: red pulse, DAMAGE CRITICAL, alarm
  SMOKE_HP: 0.6,             // planes below this share of their HP trail smoke (yours, bandits, the duel opponent)
  BANDIT_R: 16,              // gun hit radius on a bandit (generous, like the drones)
  PLANE_HIT_R: 9,            // …and on you
  BANDIT_GUN_RATE: 8,        // rounds/s while it has a firing solution
  BANDIT_GUN_SPREAD: 0.6 * DEG,
  BANDIT_GUN_DMG: 5,         // HP per round that hits you (20 hits = down)
  MISSILE_DMG: 10,           // bandit hp per player missile (rookie 8, regular 10, ace 16)
  ENEMY_MISSILE_DMG: 45,     // your HP per enemy missile
  ENEMY_MIN_RANGE: 600,      // bandits don't launch closer than this (guns range)
  ENEMY_LOCK_TIME: 1.6,      // a bandit must hold you in its cone this long to launch (LOCK WARNING meanwhile)
  ENEMY_MISSILE_TURN: 0.88,  // rad/s (turn radius ~680 m at full speed; × 0.8 with the planes)
  BREAK_DIST: [950, 1450],   // (re-swept after the × 0.8 turns; was 900-1250) a full pull started with the missile this far away (m) beats it from any
                             // side (swept: behind, beside, head-on). As a TIME it varies 3x by aspect,
                             // as a distance it doesn't: ~2 missile turn radii. HUD shows BREAK in it.
  MISSILE_FUSE: 14,          // proximity fuse (m)
  MISSILE_GIMBAL: 75 * DEG,  // target further off the seeker's nose than this = it loses you
  BANDIT_SPAWN_DIST: 3500,
  SPOT_RANGE: 8000,          // minimal HUD: a plane further than this is invisible (no speck)

  // Bomber (N): a big four-engined target for gunnery practice that flies straight and level; its
  // gunners shoot back (BOMBER_GUNNERS). Hit anywhere on its shape (BOMBER_PARTS); an engine that takes
  // BOMBER_ENGINE_HP burns and keeps costing it HP.
  BOMBER_SPEED: 130,
  BOMBER_HP: 60,             // gun rounds to bring it down (a missile is BOMBER_MISSILE_DMG)
  BOMBER_MISSILE_DMG: 20,
  BOMBER_ENGINE_HP: 6,
  BOMBER_BURN: 1.2,          // HP/s per burning engine
  BOMBER_CROSS: 2500,        // spawns so its track crosses this far ahead of you…
  BOMBER_LEAD_TIME: 9,       // …about this many seconds after it appears
  BOMBER_MAX: 3,             // at once
  BOMBER_MAX_DIST: 15000,    // flown off: gone
  BOMBER_REWARD: 500,
  // Its shape in its own frame (x right, y up, z back, m): fuselage, wings, engines, tail.
  BOMBER_PARTS: [
    { zone: 'fuselage', x: 0, y: 0, z: -10, r: 3 }, { zone: 'fuselage', x: 0, y: 0, z: -4, r: 3.2 },
    { zone: 'fuselage', x: 0, y: 0, z: 2, r: 3.2 }, { zone: 'fuselage', x: 0, y: 0, z: 8, r: 2.6 },
    { zone: 'tail', x: 0, y: 2.5, z: 12, r: 3 }, { zone: 'tail', x: -4.5, y: 0.5, z: 12, r: 2 }, { zone: 'tail', x: 4.5, y: 0.5, z: 12, r: 2 },
    { zone: 'wing', x: -8, y: 0, z: 0, r: 2.6 }, { zone: 'wing', x: 8, y: 0, z: 0, r: 2.6 },
    { zone: 'wing', x: -14, y: 0, z: 0.5, r: 2.2 }, { zone: 'wing', x: 14, y: 0, z: 0.5, r: 2.2 },
    { zone: 'wing', x: -17.5, y: 0, z: 1, r: 1.6 }, { zone: 'wing', x: 17.5, y: 0, z: 1, r: 1.6 },
    { zone: 'engine', engine: 0, x: -11, y: -0.3, z: -2.5, r: 2.1 }, { zone: 'engine', engine: 1, x: -5.5, y: -0.3, z: -3, r: 2.1 },
    { zone: 'engine', engine: 2, x: 5.5, y: -0.3, z: -3, r: 2.1 }, { zone: 'engine', engine: 3, x: 11, y: -0.3, z: -2.5, r: 2.1 },
    { zone: 'gunner', gunner: 0, x: 0, y: 1.8, z: -6, r: 1.4 }, { zone: 'gunner', gunner: 1, x: 0, y: -1.8, z: -1, r: 1.4 },
    { zone: 'gunner', gunner: 2, x: 0, y: 0.2, z: 13.4, r: 1.3 },
  ],
  // Its gunners: top turret (anything above the wings), ball turret (below), tail (a cone behind).
  // Aim starts loose and tightens while you hold a steady spot in their view (line of sight
  // turning slower than GUNNER_STEADY): sit on its six and they walk the rounds onto you; keep
  // moving across their view and they stay loose. A gunner hit GUNNER_HP times is out.
  BOMBER_GUNNERS: [
    { name: 'TOP', x: 0, y: 1.8, z: -6, covers: 'up' },
    { name: 'BALL', x: 0, y: -1.8, z: -1, covers: 'down' },
    { name: 'TAIL', x: 0, y: 0.2, z: 13.4, covers: 'back' },
  ],
  GUNNER_RANGE: 900,
  GUNNER_RATE: 5,            // rounds/s each
  GUNNER_POWER: 0.8,         // damage per round in jet-gun rounds (4 of your HP)
  GUNNER_HP: 3,
  GUNNER_ERR_MAX: 7 * DEG,   // aim error when you've just arrived / keep moving…
  GUNNER_ERR_MIN: 0.5 * DEG, // …and once they've settled on you
  GUNNER_SETTLE: 3,          // s: time constant to tighten while you hold still in their view…
  GUNNER_UNSETTLE: 0.6,      // …and to loosen again when you move
  GUNNER_STEADY: 4 * DEG,    // line of sight turning slower than this (rad/s) = "holding still"
  GUNNER_SPREAD: 0.4 * DEG,
  WAVE_GAP: 3,               // seconds between a splash and the next bandit

  // Escort (bomber escort over the LAN, duel-server.js escort room): one 109 against a formation
  // and its P-51 escorts. The server flies the bombers and their gunners (who shoot only at the 109).
  FORMATION: [[0, 0, 0], [-85, 70, 25], [85, 70, 25], [0, 150, -30], [-170, 150, -10], [170, 150, -10]],
  FORMATION_SPEED: 100,      // m/s: a loaded formation is slower than a lone target bomber (BOMBER_SPEED)
  ESCORT_ALT: 6000,          // formation height above the ground at the start
  ESCORT_KILLS: 3,           // bombers the 109 must bring down
  ESCORT_LIVES: 3,           // times the escorts must shoot the 109 down
  ESCORT_TIME: 300,          // s: then the bombers reach the target (escorts win)
  ESCORT_RESPAWN: 5,         // s before you're back in (the 109 high above, escorts by the formation)
  ESCORT_SEND_HZ: 20,        // bomber states from the server
  // Solo escort (raid.js): AI pilots for the other side.
  RELOAD: { mg: 8, cannon: 12 },   // s to rearm a gun group once it runs dry (settings.reload)
  // Crewing a bomber's top turret (gunner.js; solo escort role 'gunner').
  CREW_TURRET: 0,            // BOMBER_GUNNERS index: the top turret (the 109s dive from above)
  CREW_RATE: 10,             // rounds/s, twin .50s
  CREW_POWER: 0.4,
  CREW_BELT: 250,            // rounds (~25 s of fire), then…
  CREW_RELOAD: 5,            // …s to change the belt
  CREW_SLEW: 1.6,            // rad/s: the turret's drive (also smooths hand jitter)
  CREW_EL_MIN: 2 * DEG, CREW_EL_MAX: 85 * DEG,
  CREW_ASSIST_SCALE: 1.5,    // × the gun-assist slider (the same as the WW2 fighters' hidden assist)
  CREW_ASSIST_RANGE: 700,    // m: the gun assist (slider x ASSIST_SCALE) bends rounds onto the lead inside this

  // Hangar (hangar.js): the plane on its test stand leans this far at full deflection.
  HANGAR_ROLL: 35 * DEG, HANGAR_PITCH: 15 * DEG, HANGAR_YAW: 15 * DEG,
  HANGAR_EASE: 0.12,         // s: how quickly the stand follows
  HANGAR_TRY: 0.6,           // deflection that ticks a control off the checklist
  HANGAR_SHOTS: 12,          // gun sounds/tracers per second on the stand
  GRIP_HOLD: 0.3,            // s a lost hand keeps its grip (blur, a dropped frame)
  AIM_SMOOTH: 0.12,          // s: the fists' position is smoothed this much for aiming (shaking mustn't aim)
  SHAKE_ON: 0.15, SHAKE_OFF: 0.08,   // fist jolt (palm lengths per reading, smoothed): fire above ON, stop below OFF
  SHAKE_SMOOTH: 0.2,         // s
  RAID_ESCORTS: 3,           // AI P-51s with the bombers when you fly the 109 (a regular + rookies)
  RAID_109S: 6,              // AI 109s you must get through when you fly escort…
  RAID_109_AT_ONCE: 3,       // …this many in the air at a time
  RAID_GAP: 12,              // s before a downed AI pilot is replaced
  RAID_FIRE_RANGE: 1.5,      // an AI pilot opens fire on a bomber from this × its usual gun range
  RAID_BREAK: 150,           // m: an AI 109 breaks off its pass this close to a bomber…
  RAID_PASS: 4,              // …or after this long in gun range
  RAID_AWAY: 4,              // s it dives away before coming round again
  RAID_GUNNER_VS_AI: 0.5,    // the gunners' rounds on an AI 109 (they'd shred a pilot who flies it like a bot)
  RAID_ENGAGE: 3500,         // m: AI escorts leave the bombers once the 109 is this close to them

  // Duel (two laptops, duel-server.js): same guns and missiles as a bandit fight, both sides equal
  DUEL_ROUND_TIME: 180,      // s: a round nobody wins by then is a draw (WW2 ammo runs out; keep in step with duel-server.js)
  DUEL_HIT_R: 12,            // gun hit radius on the other human's plane (same both ways)
  DUEL_SEND_HZ: 30,          // state updates per second to the other laptop
  DUEL_INTERP: 0.1,          // draw their plane this far in the past (s), between two updates…
  DUEL_EXTRAP_MAX: 0.35,     // …or guess ahead from its velocity for up to this long if updates stall

  // Hands → controls
  HAND_LOST_HOLD: 0.3,       // seconds to hold the last input after a hand vanishes
  STICK_LOST_HOLD: 0.6,      // a fist at an odd angle drops out more; hold it longer
  EDGE_MARGIN: 0.08,
  ROOM_MARGIN: 0.25,         // calibration warns if the stick centre is closer than this to an edge
  STICK_IMAGE_PITCH: 0.5,    // the image-landmark stick axis leans ~half as far as the 3D one
  STILL_TIME: 3,             // hand still this long (s)…
  STILL_MOVE: 0.15,          // …(moved less than this many palm lengths)…
  OFF_CENTRE: 0.35,          // …but still steering this hard = suggest re-centring         // warn when the flying hand's palm centre is this close to a frame edge
  HAND_LOST_DECAY: 3,        // then decays to centre at this rate (1/s)
  PINCH_ON: 0.32, PINCH_OFF: 0.5,
  FIST_ON: 1.2, FIST_OFF: 1.5,
  GUN_HOLD: 2,               // guns need the pinch for this many camera readings (~0.1 s); missiles are instant
  FIST_ROLLBACK: 0.2,        // on a fist, throttle + rudder go back to where they were this long ago…
  FIST_SETTLE: 0.2,          // …and hold until the hand has been open this long
  JUMP_MAX: 1.0,             // flying hand moving further than this (palm lengths) in one reading = glitch…
  JUMP_CONFIRM: 2,           // …unless it's still there after this many readings (recordings: real max 0.5)
  THROTTLE_LOW: 0.85, THROTTLE_HIGH: 0.3,  // image y of the throttle hand for 0 and full
  CALIB_COUNTDOWN: 3,
  RANGE_TIME: 6,             // after centring: seconds to sweep both hands to their limits
  RANGE_USE: 0.85,           // full deflection at this share of your swept reach (no straining)
  RANGE_MIN: 0.2,            // reach below this (raw units) = you didn't move that way: keep the slider
  RANGE_MAX: 2.5,
  RANGE_MIN_SAMPLES: 5,
  THROTTLE_MIN_TRAVEL: 0.08, // left hand must move this much of the image height to set the throttle range
  INPUT_EASE: 12,            // stick/rudder output glides toward the filtered input at this rate (1/s),
                             // every drawn frame: hand tracking only updates ~20x/s, and the steps
                             // between updates were most of the jitter (-58% on the recordings, no added lag)
  ANIME_FPS: 24,             // anime look: the picture updates on this cadence (the game doesn't)
  FOV_BASE: 65,              // camera field of view at minimum speed (degrees)…
  FOV_SPEED: 18,             // …plus this much at top speed (and a little more past it)
  CLAP_COUNTDOWN: 4,         // after a double clap: an extra second to get back on the stick
  CLAP_TOGETHER: 1.4,        // palms closer than this (palm lengths) = hands together…
  CLAP_APART: 2.4,           // …further than this = apart again (hysteresis)
  CLAP_WINDOW: 1.2,          // two claps within this many seconds = calibrate
  CLAP_MERGE: 3.5,           // two hands this close that become one = they met (the tracker merged them)

  // Head look
  LOOK_MAX_YAW: 160 * DEG,
  LOOK_MAX_PITCH: 60 * DEG,
  LOOK_PITCH_SCALE: 0.7,     // nodding is noisier than turning; amplify it less
  HEAD_AUTO_FRAMES: 15,      // uncalibrated: first ~0.5 s of face = "forward"
  HEAD_BETA: 0.15,           // One Euro speed term for the head (lower = calmer)

  DEFAULTS: {
    hand: 'right',           // the hand that flies; the other one is throttle + weapons
    plane: 'jet',            // planes.js type (start screen / K)
    minHud: false,           // U: no target markers or arrows, no ladder: find them yourself
    reload: true,            // a gun group that runs dry rearms after RELOAD s (start screen)
    gunnerGain: 20,          // turret: degrees of swing per 10% of the frame the fists move
    gunnerShake: 1,          // turret: shake-to-fire sensitivity (higher = a smaller shake fires)
    gunnerPivot: true,       // turret: fists down = muzzle up, like a pivoting gun (false = the muzzle follows the fists)
    version: 9,
    scheme: 'stick',          // 'flat' (tilt a flat hand) | 'stick' (grip a fake stick)
    assist: { flat: true, stick: false }, // per scheme. true: hand angle = bank angle. false: RATE — the stick
                                          // sets how fast it rolls/pitches, hold it over = aileron roll
    pitchSrc: 'tilt',        // flat scheme: 'tilt' the palm, or raise/lower the 'height'
    invertPitch: false,
    rollRange: 35,           // degrees of hand tilt for full roll
    pitchRange: 30,          // degrees of palm tilt for full pitch
    stickThrow: 0.9,         // palm lengths of fist travel for full deflection (stick roll, flat 'height' pitch)
    stickPitch: 18,          // stick: degrees of lean toward/away from the camera for full pitch
                             // (user kept turning 30 down; pulls on the recordings reach ~20-30°)
    thrRudder: true,         // turning the throttle hand like a dial = rudder (yaw)
    yawRange: 85,            // degrees of throttle-hand turn for full rudder…
    yawDeadzone: 0.65,       // …and nothing under this share of it (~55°): rudder only when you really
                             // turn the hand toward 90° (user: small turns made it hard to focus)
    deadzone: 0.12,
    expo: 1.4,
    minCutoff: 1.0,          // One Euro filter: jitter vs lag
    pitchSmooth: 0.7,        // pitch's own min cutoff: its signal is noisier, so it's filtered harder
    beta: 0.6,
    renderScale: 1,          // pixels per CSS pixel; lower = faster on a laptop GPU
    maxFps: 30,              // normal look: draw at most this often. Drawing shares the GPU with hand
                             // tracking: at 60 each detection took 25-40% longer (measured on the user's
                             // laptop), and with real hands in view tracking got much worse.
    anime: false,            // T: anime look (24 fps cadence, cel shading, ink, speed lines)
    headLook: true,          // turn your head to look around (face tracking)
    headGain: 11,            // radians of view per unit of nose offset (face widths)
    headDeadzone: 0.065,     // (user: slightly higher than 0.045)
    headSmooth: 0.35,        // One Euro min cutoff for the head
    gunAssist: 3.5,          // degrees: with the gun sight this close to the lead marker, rounds go to it
                             // (user couldn't land guns by hand; 0 = off)
    headSpring: 9,           // how stiffly the view chases the head (rad/s): settles in ~4/headSpring s
    headNeutral: null,       // { yaw, pitch } from calibration      // stick scheme: twisting the fist = rudder (leaks into rolls)
    neutral: null,           // { flat: {...}, stick: {...} } from calibration
  },
  SLIDERS: [
    { key: 'rollRange', label: 'Roll: tilt for full (°)', min: 10, max: 70, step: 1 },
    { key: 'pitchRange', label: 'Pitch: tilt for full (°)', min: 10, max: 70, step: 1 },
    { key: 'stickThrow', label: 'Stick: slide for full roll (palms)', min: 0.3, max: 3, step: 0.05 },
    { key: 'stickPitch', label: 'Stick: lean for full pitch (°)', min: 8, max: 60, step: 1 },
    { key: 'yawRange', label: 'Rudder: left-hand turn for full (°)', min: 10, max: 120, step: 1 },
    { key: 'yawDeadzone', label: 'Rudder deadzone', min: 0, max: 0.9, step: 0.01 },
    { key: 'deadzone', label: 'Deadzone', min: 0, max: 0.4, step: 0.01 },
    { key: 'expo', label: 'Expo (1 = linear)', min: 1, max: 3, step: 0.05 },
    { key: 'minCutoff', label: 'Smooth (min cutoff)', min: 0.1, max: 5, step: 0.1 },
    { key: 'pitchSmooth', label: 'Pitch smooth (min cutoff)', min: 0.1, max: 5, step: 0.1 },
    { key: 'beta', label: 'Responsiveness (beta)', min: 0, max: 5, step: 0.1 },
    { key: 'renderScale', label: 'Render scale', min: 0.5, max: 2, step: 0.25 },
    { key: 'maxFps', label: 'Max draw fps (normal look)', min: 20, max: 60, step: 5 },
    { key: 'headGain', label: 'Head look gain', min: 1, max: 15, step: 0.5 },
    { key: 'headDeadzone', label: 'Head deadzone', min: 0, max: 0.1, step: 0.005 },
    { key: 'headSmooth', label: 'Head smooth (min cutoff)', min: 0.1, max: 3, step: 0.1 },
    { key: 'gunAssist', label: 'Gun assist (° of magnetism, 0 = off)', min: 0, max: 8, step: 0.5 },
    { key: 'headSpring', label: 'Head look glide (higher = snappier)', min: 3, max: 20, step: 0.5 },
    { key: 'gunnerGain', label: 'Turret: swing per 10% of frame (°)', min: 5, max: 45, step: 1 },
    { key: 'gunnerShake', label: 'Turret: shake-to-fire sensitivity', min: 0.3, max: 3, step: 0.1 },
  ],
  STORAGE_KEY: 'sky-ace-settings',
};

// Default neutral poses until the player calibrates.
// flat: palm down, fingers pointing at the screen (palm tilt ≈ -70°). stick: fist mid-frame.
const DEFAULT_NEUTRAL = {
  flat: { roll: 0, pitch: -70 * DEG, cx: 0.5, cy: 0.55, scale: 0.12 },
  stick: { roll: 0, pitch: 0, cx: 0.5, cy: 0.6, scale: 0.12, axI: { x: 0, y: -1, z: 0 }, axW: { x: 0, y: -1, z: 0 } },
};

// MediaPipe hand landmark indices
const HL = {
  WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_TIP: 16, PINKY_MCP: 17, PINKY_TIP: 20,
};

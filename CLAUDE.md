# Sky Ace

Ace Combat-style arcade flying controlled by **webcam hand tracking** (MediaPipe Hand Landmarker).
A control test bed first: it exists to find out whether flying with your hands feels good.

Repo: github.com/robinchengneedswork-max/p-aces — this folder is its own git repo. Push **working**
builds (tests green) to `main`; it's a static Vercel site (`vercel.json`, `.vercelignore` keeps
test/tools/serve.js off it). On Vercel the recorder downloads instead of saving to `recordings/`.

Run: `start.bat` → `http://localhost:8068/` (MediaPipe's wasm/model can't load from `file://`;
localhost also satisfies the camera's secure-context rule). `index.html?keys` skips straight to
keyboard flying, `?dogfight` starts in dogfight mode. Tests: `node test/headless.js` (235 checks, synthetic hands,
no camera) , `node test/dogfight.js [report]` (17 checks: AI-vs-AI fights and missile dodges, ~1 min)
`node test/duel.js` (22 checks: the LAN duel server with real WebSocket clients) and `node test/planes.js [report]`
(19 checks: WW2 flight models).

## Controls
- **Flying hand** (right by default, `H` swaps):
  - `1` **flat hand**: roll = tilt of the knuckle line on screen; pitch = palm tipping toward/away
    from the camera (3D world landmarks), or hand height with `P`.
  - `2` **flight stick**: fist position off a calibrated centre = roll/pitch; twisting it = rudder.
- **Other hand**: height = throttle, pinch thumb+index = gun, close the fist = missile (needs lock).
- `C` (or double clap): 3 s to hold your centre, then a 6 s **range sweep** — move both hands to your
  comfortable limits; each direction's reach becomes full deflection (Esc skips the sweep). Stored per scheme.
- `N` spawns a **bomber** (range or dogfight, up to 3): a big four-engined target crossing ahead,
  straight and level; top, ball and tail gunners shoot back. Hits count anywhere on its shape; 6 rounds into an engine
  set it burning (drains HP). Shot down it falls burning to the ground.
- `K` cycles the plane (jet, Spitfire Mk I, Bf 109E, P-51D; also on the start screen); `U` minimal HUD
  (no markers/arrows/ladder; planes too far to see show as a speck, only where they are on screen).
- `B` toggles the test range (drones + rings) and **dogfight** (one bandit at a time that shoots back:
  rookie, rookie, regular, regular, then aces).
- `M` RATE (stick = how fast it rolls/pitches; hold over = aileron roll; the stick default) / ASSIST (hand angle = bank angle, banks turn; the flat-hand default).
- Keyboard always works and overrides while held: arrows (down = pull up), Q/E yaw, W/S throttle,
  Space guns, F missile. `V` chase/cockpit, `D` debug panel + camera view, `R` reset.

## Layout
Classic scripts sharing globals, plus `tracker.js` as an ES module (MediaPipe ships as one).
`math.js`, `flight.js`, `hands.js`, `game.js` are pure (no DOM, no THREE) and load in the test vm.
`render.js` is the only file that touches THREE; `hud.js` draws the 2D overlay.
Vendored: `vendor/three/three.min.js` (r149, the last UMD build), MediaPipe tasks-vision bundle +
wasm (copied from light-gun) + `hand_landmarker.task`.

## Findings so far
- A real knuckle line isn't level (pinky knuckle sits lower): an uncalibrated level hand reads ~3°,
  opposite sign per hand. Inside the deadzone, but calibration matters — it auto-prompts on start.
- ±2 px landmark jitter → ~0.4° roll noise at the default filter, 67 ms step lag. Jitter is not the
  problem; lag/tracking loss on real hands is the unknown.
- Hand lost: input holds 0.3 s (blur, dropped frame), then springs to centre.
- **First real flight (2026-10-17):** the user liked the **flight stick** best; it chugged (debug
  view off) and roll vs yaw felt "roughly wrong". Fixes:
  - Assist pitch now rotates about the plane's own wing axis. It used to pitch about the world
    horizontal, so a banked pull slid the nose sideways (read as yaw) instead of tightening the turn.
  - Stick twist → rudder is off by default (`T` toggles): a pivoting stick tilts your fist as it
    moves sideways, so twist leaked yaw into every roll.
  - Perf: render scale 1× (slider; was up to 2× DPR), clouds = one InstancedMesh (was ~200 meshes),
    terrain re-bake cached + allocation-free, camera 640×480@30 (was 720p@60; detection blocks
    the main thread). Always-on readout under the score: fps · JS ms/frame · hand Hz + detect ms.
    Low fps with small JS ms = GPU-bound → lower Render scale.
- **Head look (2026-10-17):** MediaPipe Face Detector (BlazeFace short range, 230 KB, 6 points)
  runs on the same camera frame as the hands (`head.js`). Yaw = nose offset from the ear and eye
  midpoints ÷ face width; pitch = nose height vs the eye line. Amplified by `headGain` (15° head
  turn ≈ 70° view), capped at 160°/60°; the view orbits round the plane in chase view. The nose
  sits well below the eye line, so pitch has no natural zero: C calibrates the head along with the
  hand, and an uncalibrated head auto-centres on its first 0.5 s. `L` toggles. Optional: if the
  face model fails to load, hands still work.
- **Round 3 (2026-10-17):** stick is now the default (settings v2/v3 migrate old saves); assist
  loops over the top (hands over to rate control while pulling past vertical/inverted, rolls you
  upright when you let go inverted); cockpit model (dash + live gauges + canopy) for `V`.
- **Stick diagnosis from the user ("can't roll, yaw works, pulling up only sometimes, pushing
  down loses the fist"):**
  - Roll only read the sideways *slide*; people roll an imaginary stick by *tilting* the fist,
    which was the (clean) yaw signal. Now roll = tilt + slide; twist rudder is opt-in (`T`).
  - Knuckle-angle differences weren't folded: a stick grip holds the knuckle line near vertical,
    where a few degrees of tilt read as ~174° the other way. Fixed with `foldHalf`.
  - A front camera sees push/pull mostly as *depth*. Pitch = height + log(fist size / calibrated
    size) (`stickDepth` slider), so less vertical travel and no shoving out of the frame.
  - Assist is per scheme: stick = rate roll (hold over = keep rolling), flat hand = assist.
  - Lower tracking confidences (0.3), 0.6 s hold on stick dropouts, edge-of-frame warning.
- **Round 4 (2026-10-17):** user now holds a **chopstick pressed against a table** as the stick.
  - Head look calmer: deadzone 0.045 (~5° of head turn), min cutoff 0.35, beta 0.15, plus a
    LOOK_EASE glide; gain 11 (15° turn ≈ 53°). Settings v4 migrates older saves.
  - Cockpit was see-through: its walls sat ~1 m from the eye = the world camera's near plane.
    Now its own scene + close-range camera (near 0.03), drawn as a second pass after a depth
    clear. Fuller tub (walls, consoles, two canopy arches), and a stick + throttle that move
    with the inputs.
  - **Gesture recorder (G):** pauses the game and walks through neutral / pull / push / roll L /
    roll R / half pull / pull+roll / stir circles (2.5 s ready + 3 s hold each, ~49 s), recording
    measured features + all 21 image and world landmarks for both hands per camera frame.
    `serve.js` saves it to `recordings/rec-*.json` (browser download if that fails).
    `node tools/analyze-recording.js [file|latest]` prints, per step, each candidate signal's
    change from neutral in units of resting noise, dropouts, and which signals best separate
    pull/push and roll R/L. Read that before changing the stick mapping.
  - Known: the game's flat-hand pitch reading (`measureHand().pitch`) flips by ~180° when an
    upright stick grip rolls past vertical (fold in the de-rotation). Stick mode doesn't use it;
    the analyzer uses roll-invariant elevation instead.
- **Round 5 (2026-10-18), from the user's first two chopstick recordings** (gitignored, in
  `recordings/`; replay script was a scratch file, the analyzer has the numbers):
  - Bug: a lone hand always flew. When the stick fist dropped out, the **open throttle hand took
    over flying**. Now a lone hand goes to the role it was last near (`assignHands` memo) once
    both roles are known; before that it flies.
  - The saved centre was stale: resting reads were pitch -0.81 (rec 1) and +0.34 (rec 2),
    mostly depth from sitting at a different distance. The recorder now adopts its centred step
    as the calibration, and a still-but-steering hand shows "press C to re-centre".
  - The fist rested at 75-80% across the frame; rolling right hit 94% (weaker than left).
    Calibration now warns if the centre is within 25% of an edge.
  - With a true centre, roll works (rec 2: -1.00/+1.10; slide dx is the strongest signal).
    Pitch is the weak axis: push/pull is depth to a front camera, and depth is polluted by rolls
    (the fist swings away round the pivot), fist rotation and posture. Depth is now muted 70% at
    full roll (roll-left false nose-up 0.66 → 0.21). A per-session least-squares fit didn't
    transfer between sessions (rms 0.72-0.77), so no personal fitted mapping.
  - Hand tracking ran at 15-19 Hz: face detection now runs every other frame; recordings log
    detect/face ms and render fps.
- **Round 6 (2026-10-18): ring-axis stick** — the user's idea ("concentric circles of the
  closed fist"): the four curled fingers are rings round the stick, so the line through their
  centres (`ringAxis`, power iteration on the 3x3 covariance) is the stick's axis.
  - Validated on 4 real recordings before shipping (replay through the game's own
    `controlsUpdate`, rms vs asked-for motion, after deadzone/expo): mid-frame recordings
    0.48 / 0.38 vs old mapping 0.85 / 0.80 (the old one read pulls as pushes, rolls as dives).
  - **Pitch** = axis lean toward/away from camera, average of 3D world (÷ stickPitch 30°) and
    image (÷ 15°, swings ~half as far). Angle-based: sitting closer / raising the fist don't steer.
  - **Roll** = fist slide, ÷ stickThrow 0.9 palms. The analyzer's leak score showed slide leaks
    5-8% into pull/push vs up to 76% for the axis's own sideways lean (pushes tip it sideways).
  - Old size/height pitch, depth mute and twist-rudder are gone. Pre-ring-axis stick
    calibrations count as uncalibrated (`isCalibrated`); settings v6.
  - **Left-hand rudder**: the throttle hand turned like a dial (knuckle line vs its calibrated
    rest, ÷ yawRange 30°); C records its rest; `Y` toggles. Height/pinch/fist don't move it.
  - Analyzer: `side`, `fwd3d`, `fwdImg` stick-axis features, and signals ranked by separation
    discounted by **leak** into the other axis (separation alone ranked leaky height/aim first).
- **Round 7 (2026-10-18):** user: "pitch/roll should be how quickly things turn, not the
  position — holding roll right does an aileron roll". Rate mode already did that; the user's
  stick was in assist, almost certainly from an accidental X (it sat next to C). Toggle moved
  to `M`, labelled RATE / ASSIST (not "Expert"), and settings v7 resets the stick to RATE.
  **Wingtip vapour trails** (user request): `vaporAmount` = how fast the nose swings (pitch or
  turn, not roll) → crossed ribbons from both tips with vertex-alpha fade; a full pull = full
  vapour, a pure roll or gentle pull = none.
- **Round 8 (2026-10-18):** user: "much better!"
  - Rudder has its own deadzone (`yawDeadzone` 0.25 ≈ 7.5° of left-hand turn): that hand also
    throttles and fires, so it wobbles.
  - **Double clap = calibrate** (`clapUpdate`): palm gap in palm lengths, < 1.4 together /
    > 2.4 apart; two hands that were < 3.5 apart becoming one detection also counts (palms merge at
    contact). Two claps within 1.2 s → 4 s countdown. Tests: normal two-handed flying and a
    flickering lone hand never trigger it.
  - The sim now pauses during any calibration countdown (rate stick + hands off it = spinning).
  - Cockpit view shows your own plane: wings, tail, canards and engine from `makePlaneModel` (minus
    fuselage shell + glass) in the cockpit scene, plus a nose cone past the dash and a spine
    behind the seat.
- **Round 9 (2026-10-18):** user turned pitch sensitivity up every time; "pitch only, roll is
  ok; a little lag is fine"; jittery; wanted FOV with speed.
  - stickPitch 30° → 18° (settings v8 moves saves still on 30).
  - **INPUT_EASE**: outputs glide toward the filtered input every drawn frame (12/s). Swept on
    the recordings at 60 fps: jitter -58% with no added lag. Changing the One Euro cutoff/beta
    alone only traded jitter for lag.
  - FOV 65° + 18° × speed fraction, eased.
  - **Root cause of jitter/chug, not yet fixed:** recordings log hand detection at 44-54 ms on the
    main thread (GPU delegate), so the game drew at only 16-21 fps. Fix = run MediaPipe in a Web
    Worker (send `createImageBitmap(video)` frames), so rendering stays at 60 fps; testable
    headless with Edge's fake camera (`--use-fake-device-for-media-stream`).
- **Round 10 (2026-10-18): "game runs one way and then the look is separate".**
  - **Tracking in a module worker** (`tracker-worker.js`): MediaPipe's module wasm loader
    (`forVisionTasks(path, true)` + `vision_wasm_module_internal.*`), one ImageBitmap in flight at a
    time; main-thread path kept as fallback. Measured in real time via the DevTools protocol with
    Edge's fake camera: worker 60 fps / 1.6 ms JS per frame vs fallback 41 fps / 24 ms. (Fake camera
    has no hands, so detection is the cheap palm-only path; real hands cost ~2x.)
  - **Anime look (`T`)**: presentation only. main.js keeps sim/input/sound every frame and draws on
    a 24 fps cadence (events queued between pictures so explosions aren't skipped; measured 60 fps
    sim / 24.0 drawn); lit materials swap to MeshToonMaterial (3-band gradient), inverted-hull ink on
    plane/drones/ring/clouds (instanced ink twin), random-per-picture speed lines in the HUD.
- **Round 11 (2026-10-18):** user: with the worker the game was smoother but hand tracking
  "drastically worse"; toon (24 fps) made everything smoother. Cause: drawing and the GPU hand
  model share the laptop's GPU. Measured (fake camera, real GPU, 25 s each): GPU tracking
  detect 40.6 ms at 60 fps drawn vs 29-33 ms at 24-30; CPU tracking only 14-15 Hz (vs 22-26 GPU).
  → normal look now draws at most `maxFps` 30 (slider), GPU tracking kept; perf line shows
  "drawn N" and the delegate. Real hands add the landmark stage, so contention is worse than
  the fake-camera numbers.
- Next: user flies at the 30 cap; if tracking still suffers, consider adaptive cap (lower the
  draw rate when tracking Hz drops).
- **Round 12 (2026-10-19): input clean-up** (from a survey of how people clean MediaPipe input).
  Already had: One Euro, deadzone + expo, rate stick, clap calibration, lost-hand hold/decay,
  pinch/fist hysteresis. Added:
  - **Impossible-jump rejection**: flying-hand palm moving > `JUMP_MAX` 1.0 palm lengths in one
    reading is held for up to `JUMP_CONFIRM` 2 readings, then believed. Measured on the 4
    recordings: real moves peak at 0.41-0.50 palms/reading; rec 1's 3-4 palm leaps were the
    swapped hand. Not applied after a dropout.
  - **`pitchSmooth`** 0.7: pitch has its own One Euro min cutoff (slider), lower than roll's 1.0.
  - **Guns** need the pinch for `GUN_HOLD` 2 camera readings (~0.1 s); release is instant.
    **Missiles are deliberately NOT debounced** (user: "we need to be able to fire off the
    missiles really quick") — hysteresis only, fire on the first fist reading.
  - **Fist freeze**: on a fist, throttle + rudder roll back to their value `FIST_ROLLBACK` 0.2 s
    ago (before the fingers began curling) and hold until the hand has been open `FIST_SETTLE`
    0.2 s. Not done for pinch: rudder corrections while gunning are the point of the rudder.
  - `controlsUpdate(..., fresh)`: main calls it every drawn frame but readings come ~20/s, so
    jump/gun counts step only on fresh readings.
  - None of this tested on camera yet; whether a real fist actually drags throttle is unmeasured
    (the recorder has no left-hand steps).
- **Round 13 (2026-10-19): light flight model + AI bandits.** User: Ace Combat-level, "a little slip
  makes the high-g manoeuvres cooler", light G effects.
  - **Flight (`flight.js`)**: the nose still answers the stick instantly; realism only sets limits and
    costs. Pull rate peaks at `CORNER_SPEED` 170 (∝ speed^0.8 below, ∝ 1/speed above = g limit);
    turns bleed speed (`TURN_BLEED` × (G-1)²), climbs cost / dives gain (`CLIMB_DRAG` 55), stall
    below 70 (nose falls, pulls fade), roll weaker when slow. **Slip**: the flight path (`p.path`)
    trails the nose (`SLIP_GRIP` 9/s at corner speed → ~7° in a full pull); position moves along
    the path. **G** = path turn rate × speed / `A_PER_G` + up.y (full pull at cruise ≈ 8.5 G).
    HUD: G meter, cyan flight-path marker (the gap to the pipper is the slip), STALL.
  - **G strain is looks only** (user: G-LOC shouldn't force a blackout; AI doesn't care): strain
    builds above 6 G and draws tunnel vision (edges grey and close in); negative G tints red. It
    never touches the controls. Hard-turn "fatigue" is the energy bleed.
  - **AI (`ai.js`)**: a bandit is a plane through the same `flightStep` (rate mode), flown by
    `pilotStep` → the same ctrl a hand makes. Lift-vector-on-target steering; priorities: imminent
    ground → dodge missile → soft ground → break when on its six → extend when slow → lead-pursuit
    attack (+ guns / missile lock). Skill = reaction, aim error, pull, trigger cone, dodge timing,
    energy discipline (rookies yank and bleed).
  - **Missiles are pure pursuit** (no lead). With lead prediction a break could never work (a pulling
    plane strays only ~7 m from the prediction). Swept: the dodge window as a TIME varies 3× with
    aspect, as a DISTANCE it doesn't — a full pull with the missile **0.9–1.25 km** away
    (`BREAK_DIST`, ~2 missile turn radii) beats it from behind, beside or head-on; straight or late
    = hit. HUD: LOCK WARNING, MISSILE + distance, "BREAK! PULL HARD" in the window; warning tones.
    Enemy missiles turn 1.1 rad/s, yours 1.3 (narrower window for bandits). Bandits don't launch
    inside 600 m.
  - **Balance** (`test/dogfight.js report`): the player keeps a human's edge (100 HP = 20 rounds,
    0.6 s lock, 1.2 s missile cooldown vs bandit 8-16 hits), so AI-vs-AI "who wins" means little.
    Measured instead: vs a player who only dodges, rookie / regular / ace win 3 / 6 / 9 of 16;
    vs one who shoots back they last 31 / 92 / 95 s on average; no bandit hit terrain in 144 fights.
    Found by the harness: ace holding full pull lost (bled slow) → energy discipline; bandits
    culled at 9 km respawned mid-fight; `pilotStep` crashed on a dead player (would have frozen the
    game on SHOT DOWN).
  - Browser-verified (real-time headless Edge via CDP): 60 fps sim / 30 drawn; a rookie locked,
    launched, hit and gunned a passive player; screenshots of the bandit marker, tunnel vision and
    BREAK cue. **Not yet flown by the user.**
- **Round 14 (2026-10-19), after the user's first dogfights: "lost 0 to 10 — could never beat him in
  the turn or out-energy him", never saw tunnel vision, wanted calibration to set max range too,
  then "start higher alt… try 8k and 15k".**
  - **Range calibration**: after the centre countdown, a 6 s sweep (live reach bars on screen).
    Per direction, 95th percentile of the sweep × `RANGE_USE` 0.85 = full deflection (`applyRange`,
    stored as `neutral[scheme].range = { roll: [L, R], pitch: [-, +] }`, `neutral.thr = { roll, yaw,
    cy: [top, bottom] }`). A direction you didn't move keeps the slider. Re-centring (C, recorder)
    keeps the range. Most likely why the user lost: his hands only reached part of the stick
    while bandits pull 60-100%.
  - Tunnel vision sooner: onset 5 G, builds at (G-5)/6 per s (visible within ~1 s of a hard pull).
  - Bandits: rookies pull ≤0.6 at ≤0.7 throttle, regulars 0.8 / 0.85 (aces unchanged); no missile
    on the first merge (cooldown starts at 60%); regulars + aces **don't joust** (slide 12° off a
    head-on pass and hold fire: they lose jousts to your bigger gun/their bigger hitbox) and chop
    throttle to break a missile when fast (g-limited). HUD speed hint: BEST TURN / SLOW / FAST.
  - Harness after: vs a pilot who shoots back, rookie/regular/ace last 23/55/145 s; an AI that only
    dodges is now rarely caught (both just turn), so that matchup is reported, not checked.
  - **Altitude**: start 8000 m above ground, ceiling 15000 (user's numbers, read as metres = the ALT
    readout). Rendering: a coarse far terrain layer (60 km, 500 m cells, polygon-offset behind the
    detailed patch), 84 km sea, fog far = 4600 + 1.6 × altitude (max 30 km), camera far 40 km.
    Screenshots: ground to the horizon at 8 km with clouds below; 15 km is hazy; low level unchanged.
- **Round 15 (2026-10-19):** user got his first kill after range calibration. Then: "slightly slower,
  same feeling of fast — turning radius a little slower". Every turn rate × 0.8 (pitch 0.96, assist
  turn 0.6, missiles 1.04 / 0.88, vapour thresholds), with A_PER_G and SLIP_GRIP × 0.8 so a full
  pull still reads ~9 G and slips ~7°. Speeds, FOV and roll rate untouched. BREAK_DIST re-swept →
  950-1450 m (AI dodge ideal 1200). Fights run longer (bandit life vs a shooting regular 31/72/150 s).
- **Round 16 (2026-10-19): LAN 1v1 duel.** User: "two people on two laptops on the same wifi" →
  1v1, guns + missiles, "slightly further range but lower", recalibrate every round ("in a duel you
  can't pause"). Also asked for Mac support.
  - **Each laptop runs its own copy on localhost** (start.bat / start.command): getUserMedia needs a
    secure origin, so the guest can't just open the host's http://172.16.x.x page; and the Vercel
    https site can't open ws:// to a LAN address (mixed content), so duels are local-copy only
    (the https start screen says so). serve.js now listens on 0.0.0.0 (firewall prompt) but serves
    recordings/POST only to localhost.
  - `duel-server.js`: hand-written WebSocket (RFC 6455 handshake + text frames, no npm) + the round
    referee: lobby → calib (both calibrate) → both ready → go {spawns 7 km apart nose to nose, 3 km
    above ground, new spot each round} → 3 s countdown → fight → `down` (shot or crash) → point to
    the other → calib again; first to 5 → over → rematch. Downs during the countdown are ignored.
    LAN address picked like Endor (routed adapter wins over the 192.168.137.x hotspot).
  - `src/duel.js` (pure): each laptop flies its own plane and sends a snapshot 30×/s (pos, nose,
    canopy, speed, hp, firing, its missiles); the other plane is drawn 0.1 s in the past between two
    snapshots (extrapolated ≤0.35 s if they stall). **Shooter decides hits** (game.js 'duel-hit'
    events → `hit` messages; DUEL_HIT_R 12 both ways, 5 per round, 45 per missile). Remote missiles
    only raise your warning; remote tracers are looks only. No respawn in a duel.
  - Calibration in a duel: auto-starts on each `calib` (keyboard players auto-ready; Enter = ready /
    rematch); C/clap mid-round is refused. R/B/G disabled in a duel.
  - Verified: 191 headless (incl. two games back to back with simulated latency), 20 server checks
    over real sockets, and two headless Edge pages, the guest joining via the real Wi-Fi address
    (172.16.185.115): lobby shows the address, both auto-ready, countdown, the guest's plane closes,
    20 hits → round to the host, round 2 calibrates. Background tabs throttle rAF in one headless
    browser (test-only). **Not yet played on two real laptops / a Mac.**
  - Mac: `start.command` (LF endings forced by .gitattributes, mode 755 in git); needs Node + Chrome.
- **Round 17 (2026-10-19), after the first real two-laptop duel ("that really worked!"):**
  - Head deadzone default 0.045 → 0.065 (settings v9 raises saves below it).
  - The loser's next-round calibration was hidden by SHOT DOWN (their plane is still down when
    `calib` arrives): HUD order is now recorder → calibration → duel screens → crashed.
  - Getting hit: camera shake (∝ damage, decays), stronger red flash; ≤ `CRITICAL_HP` 35: pulsing
    red border, DAMAGE CRITICAL, alarm tone; planes under 60% HP trail dark smoke (own, bandits,
    duel opponent: `damageSmoke`, a separate soft-sprite point system — the missile one drew big
    white squares right behind your own plane).
  - Rudder only near a 90° turn of the left hand: yawRange 85°, yawDeadzone 0.65 (starts ~55°),
    v9 resets saves. measureHand now also returns `dial`, the UNFOLDED knuckle angle: the folded
    ±90° angle flips sign exactly at 90°. Calibration stores `thr.dial`; the range sweep no longer
    sets rudder (it would undo the deliberate deadzone).
- **Round 18 (2026-10-19): gun help** (user: "haven't been able to fly well enough to get the gun to
  work"; likes the slip, keep it). `gunSolution(g)`: best target within 40° / 2.5 km, aim direction
  solved in the plane's moving frame (rounds inherit our velocity → target drifts by its velocity −
  ours; fixed-point on flight time). HUD **lead marker** drawn at the sight's 700 m depth (exact
  alignment, chase-cam parallax <1°) + dotted line to its target; **colour = range** (user's idea):
  dim beyond `GUN_RANGE` 800 m, green inside, filled dot when the assist has it. **Magnetism**:
  sight within `gunAssist` 3.5° (slider, 0 = off) of the marker and ≤1100 m → rounds fire along the
  solution. Bandits get no assist. Tests: sight on the marker hits a 70 m/s crosser at 600 m, sight
  on the target misses, 3.2° off hits only with the assist.
- **Round 19 (2026-10-20), branch `plane-specs`: per-plane flight models, step 1 (refactor only).**
  User wants WW2 planes (real wing G limits, energy, prop quirks like carburettor cut-out on
  negative G vs fuel injection) and War Thunder-style component damage instead of HP, in this game.
  `planes.js`: `PLANES[type]` lists only what differs from CONFIG; `planeSpec(type)` = CONFIG with
  those laid over it (prototype fallback, cached). Planes carry `type` + `spec`; `flightStep`,
  `pitchEnvelope(speed, spec)`, AI energy, HUD speed hint, FOV, gauges and engine pitch read the
  plane's spec. Respawn keeps the type; duel snapshots carry `ty` (missing = jet, so old clients
  still duel). `jet` = CONFIG unchanged. Plan: 2 = Spitfire Mk I vs Bf 109E (prop thrust, wing
  G limit, neg-G cut), 3 = zone damage, 4 = more planes.
- **Round 20 (2026-10-20): bomber target** (user: "a big target that flies in a straight line";
  later idea: crew its gunner). `spawnBomber` (N): track crosses `BOMBER_CROSS` 2.5 km ahead ~9 s
  after it appears, 30-150° to your heading, 130 m/s. Hit shape = `BOMBER_PARTS` spheres in its
  own frame (fuselage, wings to the 18 m tips, tail, 4 engines) — the first zone-based hit test,
  groundwork for WW2 zone damage. 60 HP, missile 20, engine 6 → burns at 1.2 HP/s. Killed: noses
  over, rolls, falls, `bomber-crash` on the ground. Model has three gunner bubbles (looks only).
- **Round 21 (2026-10-20): bomber gunners + tracers.** User: "basic AI gunners — low initial aim
  that moves closer if you just sit in the same spot"; "tracers more tracing".
  - `updateGunners`: top (above the wings), ball (below), tail (70° cone behind), 900 m, 5 rds/s,
    4 HP a hit, all led like your own sight. Aim error eases from 7° to 0.5° (τ 3 s) while your
    line of sight from that gunner turns slower than 4°/s, back to 7° (τ 0.6 s) when you move; the
    miss direction wanders slowly so rounds walk round you then onto you. Measured, holding still:
    first hit 5-9 s, down ~2.5-5 s later (300-800 m, six or beam); weaving ±160 m at 500 m: 2 hits
    in 20 s. Turrets are hit zones (3 hits = gunner out, "TAIL GUNNER OUT").
  - Shot-down bombers now nose toward world down (pitching about their own wing while rolling
    looped them forever — caught by the falling test once gunners changed the rng sequence).
  - Tracers: camera-facing ribbons (WebGL lines are 1 px), ~100 m long but never longer than the
    round has flown, width ∝ distance (~6 px), bright head → clear tail; yours yellow, others
    red-orange. Normal blending: additive washed both to white against the pale sky.
- **Round 22 (2026-10-20): WW2 planes, step 2.** User: per-plane flight models "slightly less arcadey"
  (real G limits on the wings, energy, carburettor neg-G), limited ammo, 109 cannons, and NO lead
  marker for WW2 ("use tracers on MG to get the lead, then open up with cannon"); minimal HUD.
  - `planes.js`: spitfire / bf109 / p51 over a shared `WW2` base. PROP: thrust = POWER × throttle /
    max(speed, V_STATIC 80), drag = DRAG_K v² (full throttle levels at SPEED_MAX), gravity 9.81,
    real G. Pitch envelope ∝ v below corner, ∝ v above it × `stickForce` (heavy controls past
    STIFF_SPEED), so pulls past G_LIMIT are possible: wingStress += (G/limit − 1) × 2 per s, heals
    0.15/s, at 1 → `wingFailed` (crash, "WING FAILURE"). Turn bleed × (corner / v)² (induced drag),
    so fast pulls hold their G and slow ones bleed. Spitfire `NEG_G_CUT` 1.4 s (109/P-51 none).
  - `test/planes.js report` numbers: climb 13.8 / 15.8 / 17.6 m/s; sustained 360° 15 / 18 / 18 s
    (real ~19 / ~22 / ~22: ~25% quick, same order); full stick out of a 200 m/s dive breaks the
    Spitfire wing in 1.1 s, the P-51 in 1.6 s, the 109's heavy elevator can't (7 G) — historical.
    Full stick at cruise (150) holds (it bleeds speed). First tuning had best climb at 40 m/s
    (thrust ∝ 1/v unbounded → V_STATIC) and nothing ever broke (speed-blind bleed → (c/v)²).
  - Guns (`fireGuns`): per-gun spot, rate, muzzle speed, power (jet-round units: 1 = 5 HP on a
    human), ammo; wing guns aim at CONVERGENCE; rounds drop. Pinch = MG, fist (`controls.out.cannon`
    = fist held) / Shift = everything. Spitfire 8 × .303 (~15 s), 109 2 MG + 2 × 20 mm (power 4 =
    20 HP, 28 rounds ≈ 7 s), P-51 6 × .50. Rearm on respawn / round. Hit radius on WW2 planes 7 m.
    No missiles, no lead marker, no assist (spec LEAD/MISSILES false). Reflector sight: a fighter
    fills the ring at 125 m, the dotted half-ring at ~250 m.
  - AI flies the enemy type (PLANE_ENEMY: Spitfire ↔ 109, P-51 → 109) with its real guns (unlimited,
    cannon only on a sure shot), pulls ≤ 95% of G_LIMIT, WW2 gun range × 0.55, throttle cap mostly
    lifted (a prop at 70% power never caught you). 3 × 60 s: no AI wing failures.
  - Duel: snapshots carry `cn` (cannon), the other laptop draws their real guns; `DUEL_ROUND_TIME`
    180 s → draw, no point (server `roundTime`). Chase camera closer for WW2 (CHASE_BACK 20).
  - Models: `makePropModel` (elliptical / square-tip / tapered wings, coloured cowl, 3-blade prop),
    cockpit shows the long cowling over the dash. Sounds: lower prop drone, cannon thump, wing creak.
  - Browser-checked: models, cockpit, sight, minimal HUD speck, over-G HUD at 10 G. Two-page duel:
    each side sees the other's type (background tab froze A's countdown: headless-only).

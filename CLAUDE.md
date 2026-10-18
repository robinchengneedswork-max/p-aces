# Sky Ace

Ace Combat-style arcade flying controlled by **webcam hand tracking** (MediaPipe Hand Landmarker).
A control test bed first: it exists to find out whether flying with your hands feels good.

Run: `start.bat` → `http://localhost:8068/` (MediaPipe's wasm/model can't load from `file://`;
localhost also satisfies the camera's secure-context rule). `index.html?keys` skips straight to
keyboard flying. Tests: `node test/headless.js` (57 checks, synthetic hands, no camera).

## Controls
- **Flying hand** (right by default, `H` swaps):
  - `1` **flat hand**: roll = tilt of the knuckle line on screen; pitch = palm tipping toward/away
    from the camera (3D world landmarks), or hand height with `P`.
  - `2` **flight stick**: fist position off a calibrated centre = roll/pitch; twisting it = rudder.
- **Other hand**: height = throttle, pinch thumb+index = gun, close the fist = missile (needs lock).
- `C` 3-second calibration countdown: hold your neutral pose. Stored per scheme.
- `X` assist (hand angle = bank angle, banks turn) / expert (stick = roll rate).
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
- Next: user records with the chopstick; analyze, then retune the stick mapping from the data.

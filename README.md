# Sky Ace

Ace Combat-style arcade flying in the browser, steered by your webcam: grip an imaginary flight
stick (a chopstick pressed on a table works well), and turn your head to look around.
MediaPipe hand + face tracking, three.js, no build step.

- **Play locally:** `start.bat` → http://localhost:8068/ (the camera needs http/https, not file://)
- **Deployed:** static site on Vercel; push to `main` deploys. HTTPS means the camera works there too.
- **Keyboard only:** add `?keys` to the URL.

## Controls
- **Flying hand (stick):** grip a stick (a chopstick pressed on the table works). Pull back / push forward to pitch — read from the angle of the line through your curled fingers (the stick's axis), so sitting closer doesn't steer. Lean it sideways to roll. `1` flat-hand mode, `2` stick.
- **Other hand:** height = throttle, pinch = guns, close the fist = missile, turn it like a dial = rudder (`Y` toggles).
- **Head:** turn a little to look around (`L` toggles).
- `C` calibrate · `X` assist/expert · `V` cockpit/chase · `D` tuning panel · `G` record gestures · `R` reset
- Keyboard: arrows fly, W/S throttle, Space guns, F missile.

## Development
- `node test/headless.js` — synthetic hands/faces drive the real control, flight and game code.
- `G` in the game records your hand motions; `node tools/analyze-recording.js latest` reports which
  hand signals moved for each motion (recordings save to `recordings/` when run via `serve.js`,
  or download in the browser when deployed).

Vendored: three.js r149 (MIT), MediaPipe Tasks Vision + hand landmarker + BlazeFace models (Apache 2.0).

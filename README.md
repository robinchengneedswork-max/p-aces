# Sky Ace

Ace Combat-style arcade flying in the browser, steered by your webcam: grip an imaginary flight
stick (a chopstick pressed on a table works well), and turn your head to look around.
MediaPipe hand + face tracking, three.js, no build step.

- **Play locally:** `start.bat` (Windows) or `start.command` (Mac — double-click; Linux: `sh start.command`) → http://localhost:8068/ (the camera needs localhost or https, not file://). Needs [Node](https://nodejs.org); nothing to install beyond that.
- **Deployed:** static site on Vercel; push to `main` deploys. HTTPS means the camera works there too.
- **Keyboard only:** add `?keys` to the URL.

## Duel a friend (same Wi-Fi)
Both laptops get this folder (`git clone` is best — a zipped copy on a Mac may need right-click → Open the first time) and run it locally. On the start screen pick **Duel**: the host leaves the address blank and their screen shows an address like `172.16.x.x`; the other laptop types that. Windows asks once to let Node through the firewall — allow it on private networks. 1v1, guns and missiles, first to 5; both pilots calibrate (centre + range) before every round. Duels don't work from the Vercel site: browsers block an https page from talking to a laptop on your network.

## Controls
- **Flying hand (stick):** grip a stick (a chopstick pressed on the table works). Pull back / push forward to pitch — read from the angle of the line through your curled fingers (the stick's axis), so sitting closer doesn't steer. Lean it sideways to roll. `1` flat-hand mode, `2` stick.
- **Other hand:** height = throttle, pinch = guns, close the fist = missile, turn it like a dial = rudder (`Y` toggles).
- **Head:** turn a little to look around (`L` toggles).
- `B` test range ↔ dogfight against AI bandits · `C` or clap twice to calibrate (centre, then sweep to your limits) · `M` rate/assist (stick defaults to rate: hold = keep rolling) · `V` cockpit/chase · `D` tuning panel · `T` anime look (24 fps, cel shading, ink, speed lines) · `G` record gestures · `R` reset
- Keyboard: arrows fly, W/S throttle, Space guns, F missile.
- **Hangar:** while you wait (duel/escort lobby, calibrating, the hand model loading) and before a solo take-off, your plane sits on a test stand that moves with your hands, with a setup checklist and the settings menu open. `Enter` takes off; `Esc` in solo flight goes back (paused).

## Development
- `node test/headless.js` — synthetic hands/faces drive the real control, flight, game and duel code.
- `node test/dogfight.js report` — AI-vs-AI fights and missile-dodge sweeps.
- `node test/duel.js` — the duel server end to end with real WebSocket clients.
- `node test/headless.js` also covers solo escort (`raid.js`) and the hidden WW2 gun assist.
- `node test/escort.js` — the bomber-escort room (server-flown formation, roles, kills, lives, time) over real sockets.
- `node test/planes.js report` — WW2 flight models vs rough historical figures (climb, turn, zoom, over-G).
- `G` in the game records your hand motions; `node tools/analyze-recording.js latest` reports which
  hand signals moved for each motion (recordings save to `recordings/` when run via `serve.js`,
  or download in the browser when deployed).

Vendored: three.js r149 (MIT), MediaPipe Tasks Vision + hand landmarker + BlazeFace models (Apache 2.0).

# Mobile (phones and tablets)

Roadster Flight Test is built for desktop GPUs, but it starts and is playable on current phones and
tablets in landscape. This page lists what is supported, what is known not to work well, and how
the mobile path was tested.

## Supported

| Platform | Browser | Renderer | Notes |
|---|---|---|---|
| iOS / iPadOS 26+ | Safari (all iOS browsers use WebKit) | WebGPU | preferred path |
| iOS / iPadOS 15.4 – 18 | Safari | WebGL 2 fallback | expected, not tested on that engine; slower start (see below) |
| Android 12+ | Chrome / Edge | WebGPU (Chrome 121+), otherwise WebGL 2 | |
| Android | Firefox | WebGL 2 | |

The build targets ES2022; older browsers show a plain English message after 90 s instead of an
endless boot screen (the UI language is not loaded at that point).

## What happens on a phone

- **Device profile.** `classifyDevice()` (`src/render/quality.ts`) treats a mobile user agent, a
  touch-first device (coarse pointer, no hover) or an iPad (desktop Safari UA with touch) as
  `mobile`. Touch laptops with a mouse stay `desktop`.
- **Quality.** Without a stored choice, phones start on **Low**. On top of any preset the mobile
  profile caps the budgets (`MOBILE_CAPS`): pixel ratio 1, shadow maps 1024, 1 500 particles, 300
  audience silhouettes, 1 000 stars, no SSR and no motion blur, and dynamic resolution may drop
  to 50 %. A quality picked in Settings is kept, the caps still apply.
- **Boot screen.** `index.html` shows the downloaded MB; `src/main.ts` adds a localized phase line
  (*Loading…* → *Preparing graphics… 42 s*). If the game is not ready after 75 s and nothing was
  downloaded for 25 s, it offers **Simple graphics** (reload with `?q=low&webgl`) or **Keep
  waiting**. A start failure shows a localized message with the error details instead of loading
  forever. three's `WebGPURenderer` already falls back to WebGL 2 when no WebGPU device can be
  created; any later start failure with WebGPU is retried once with `?webgl` (Low on phones).
  A lost WebGL context during the start counts as a failure.
- **Touch controls** (`src/ui/touchControls.ts`, `src/input/touch.ts`), visible only on touch
  devices and only while driving:
  - left: floating drive stick (steer; push = throttle, pull = brake) and **Handbrake**;
  - right: floating attitude stick (yaw; pull = nose up, as on a gamepad) and a three-row button
    block: the two roll buttons on top, **Boost** and **Down** on the left, a tall **Lift** at the thumb;
  - top right: **⋯** (tray with assist level, fans, aero, compressor, reverse, launch mode, slow
    motion, photo mode, pause, help), **Cam**, **↺** (reset) and **☰** (menu).
  The overlay writes analog values per control id into `InputManager.touch`; the mapper treats
  them like a gamepad, so every action of `src/input/bindings.ts` is reachable and keyboard or
  gamepad rebinding has no effect on the touch layout. Menus are plain buttons and work by tap.
- **Tilt steering** (optional, off by default; `src/input/gyro.ts` pure mapping, `src/input/gyroSensor.ts`
  sensor side, `src/ui/gyroSwitch.ts`). The **TILT** button at the left of the top-right bar (or Settings →
  Controls → *Tilt steering*) switches it on; **⊙** next to it recenters while it is on. In portrait both sit at the
  front of the **⋯** tray instead (the top bar would reach under the HUD top left).
  - Switching on calls `DeviceOrientationEvent.requestPermission()` inside the tap (iOS 13+), then waits up to
    1.5 s for a first `deviceorientation` event with real angles. Denied permission or no sensor: hint in the HUD
    and under the settings toggle, the option stays off. A stored "on" is resumed at the next start without a
    prompt (Android); on iOS the permission is asked again on the first tap anywhere.
  - Mapping: `beta`/`gamma` give the "up" vector in device coordinates, rotated by `screen.orientation.angle`
    (fallback `window.orientation`) into screen coordinates, so landscape left (90°) and right (270°) and
    upside-down behave the same on screen. Pitch = forward/back lean of that vector (`atan2(y, z)`), roll =
    sideways lean (`asin(-x)`), both relative to the zero pose: leaning back = nose up, right edge down = roll
    right. Dead zone 3° (rescaled, no jump), full deflection at 3° + 25° / sensitivity (Settings: 0.3–3),
    low-pass 80 ms.
  - Zero pose: the pose when switching on, at every run start / restart (`App.startSession`), on **⊙** or
    *Recenter* in the settings, and the first pose after the screen rotates.
  - The tilt values are added to the touch attitude (`mergeAttitude`: signed sum per axis, clamped) and go
    through the same mapper path as the right stick, including *Invert pitch*. Yaw, steering, throttle and the
    other buttons are unchanged; menus ignore the tilt.
- **HUD with touch controls** (`src/ui/hud/Hud.ts`). While the touch overlay is shown, the HUD
  measures the visible buttons, the stick rests and the stick hints and lays itself out around them:
  - the gauge row (G-force, attitude sphere, top view, altitude) moves from the screen corners into the
    lowest band that is free, centred between the sticks; when four gauges do not fit, the top view is
    left out and the sphere turns into the PITCH ring on a wall;
  - the readouts top right start below the ⋯ / CAM / ↺ / ☰ bar and get a soft dark backing; in portrait
    they move below the mode block; the damage view goes next to them when the space down to the
    button block is too short; the low-air warning sits below the readouts, the 0–60 timer above the gauges;
  - text keeps a minimum size (readouts ≈ 10 px labels / 16 px values, gauge labels ≥ 9 px);
  - everything stays inside the safe area (notch, Dynamic Island, home indicator): the overlay and the
    HUD canvas both use `env(safe-area-inset-*)` through the CSS variables `--rft-sa-*`
    (`src/ui/touch.css`).
  Without the touch overlay (desktop, or a menu open) the HUD keeps the stream layout.
- **Portrait.** A dismissable hint asks to turn the device to landscape. Title menu and HUD are
  laid out for landscape; in portrait the sticks sit side by side left of the button block and the
  gauge row moves above them, so the game stays usable.

## Limits

- **First start can take minutes on WebGL 2.** Shader compilation (`warmup()` +
  `prewarmFrames()` in `GameRenderer`) is the long phase; on a Mac under WebKit/WebGL 2 it takes
  ~15 s + ~5 s, and Low quality does not shorten it noticeably (same material set). Phones are
  several times slower. WebGPU (iOS 26, Android Chrome) compiles asynchronously and is much faster.
- **Memory.** The McGregor scene needs ~33 MB of downloads, ~175 MB of decoded textures and
  ~170 MB of JS heap at start (measured in Chromium); worlds add 17–51 MB of downloads each. On
  phones with 3–4 GB RAM Safari may reload the tab when switching worlds. Low quality and the
  mobile caps reduce render targets but not the texture set.
- `roadster.glb` is requested and parsed twice at start (renderer setup and `App.init()`; the
  second request is usually a cache hit), costing parse time and ~7 MB of transient memory. The
  boot MB counter counts it twice.
- After the automatic WebGL 2 retry the tab keeps `?webgl=1&q=low` in its URL.
- The "taking long" hint can appear during one very long download (no completed request for 25 s).
- A WebGPU device loss *after* the start is not handled here.
- Menu footers and the help screen still show keyboard hints (the input device is never `touch`).
- The **⋯** tray covers the top-right HUD readouts while it is open (it has its own dark panel).
- No haptics, no on-screen rebinding for the touch layout.
- Tilt steering was tested with simulated sensor events only; the sign of `screen.orientation.angle`
  (90 = device top to the left) follows the spec and Chrome/Safari, not a real-device check.
- The gauge ring labels (G-FORCE, ALTITUDE, …) stay English like the stream graphics.
- Safe-area insets are emulated in the tests (`--rft-safe-<side>`), not measured on a real notch.

## How it was tested

No real device was available; all checks are emulation on a Mac (Apple GPU), so phone shader
speed and Safari's per-tab memory limit are **not** reproduced.

- Playwright 1.63, Chromium with mobile emulation (`devices['Pixel 7']`, touch, DPR 2.625) and
  WebKit with `devices['iPhone 15']` (and `iPhone 13` with `navigator.gpu` removed to force the
  WebGL 2 path), against the live site and a local production build.
- `tests/e2e/mobile.spec.ts` (“mobile boot + touch drive”): boots in portrait, checks the
  landscape hint and the Low default, switches to landscape, taps through the title menu, drives
  with the virtual stick, lifts with the touch button, opens the pause menu with ☰ and resumes by
  tap, and asserts no console errors. Three more tests cover the start failures: a failing WebGPU
  device still boots on WebGL 2 (three's own fallback; the `?webgl` reload is not triggered by
  any test); no usable context shows the localized failure box
  without a reload loop; a stalled start (`?bootslow=6` shortens the thresholds) shows the
  “taking long” box and *Keep waiting* dismisses it for good. Run it with a phone project, e.g.:

  ```ts
  projects: [
    { name: 'pixel7', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone15', use: { ...devices['iPhone 15'], browserName: 'webkit' } },
  ]
  ```

  (WebKit needs `npx playwright install webkit`.) `playwright.config.ts` has these phone projects;
  they only run the `mobile*` specs:

  | Project | Device | Landscape viewport | Browser |
  |---|---|---|---|
  | `phone-small` | iPhone SE (3rd gen) | 667 × 375 | Chromium |
  | `galaxy` | Galaxy S24 | 780 × 360 | Chromium |
  | `pixel7` | Pixel 7 | 839 × 412 | Chromium |
  | `iphone-max` | iPhone 15 Pro Max, notch emulated | 739 × 430 | WebKit |

  ```bash
  PORT=4640 npx playwright test tests/e2e/mobile --project=phone-small --project=galaxy --project=pixel7 --project=iphone-max
  ```

  `iphone-max` is only defined when WebKit is installed (`npx playwright install webkit`).

  Under the `desktop` project the spec forces the touch UI with `?touch` and skips the mobile-only
  quality check.
- `tests/e2e/mobile-hud.spec.ts` (“mobile HUD layout”): free play in landscape (screenshots in English,
  German, Russian, French, Japanese; geometry checked in all 14 languages) and portrait, the ⋯ tray, pause and settings menus. It checks
  geometrically that no HUD group (`Hud.layoutBoxes()`) overlaps another one or a touch control, that
  stick rests and hints do not run into the buttons, that nothing leaves the screen and that no button
  label is clipped. Screenshots go to `$RFT_SHOTS` (`hud-<project>-<view>.png`).
- `tests/e2e/mobile-gyro.spec.ts` (“tilt steering”): fakes the sensor with `dispatchEvent(new
  DeviceOrientationEvent(…))` at ~30 Hz for the current screen angle (exact inverse of the mapping; Playwright's
  WebKit has no constructor, so there it dispatches a plain `Event` carrying the angles); checks off by default, switching on with
  TILT (zero pose), pitch and roll signs on `manual.axes` and on the commanded lift-nozzle duties (`session.lastOutput`, RAW assist: front > rear for nose up, left > right for roll right), dead zone,
  recenter (⊙ and restart), the settings rows and switching off there; a denied `requestPermission` and a
  silent sensor leave the option off with the hint.
- Unit tests: `tests/ui/touch.test.ts` (stick mapping, touch → mapper, every control reachable,
  device classification, mobile caps); `tests/ui/gyro.test.ts` (tilt → stick: screen angles 0/90/180/270,
  calibration, ±180° wrap, dead zone, sensitivity, smoothing, merge with the touch values).

Debug switches: `?touch` forces the touch UI on desktop, `?q=low`, `?webgl` force quality and
renderer, `?bootslow=<s>` shortens the stall hint thresholds, `?nosw` removes the service worker and
its caches.

## Install as an app

The site is a Progressive Web App: `public/manifest.json` (name *Roadster Flight Test*, short name
*Roadster FT*, full-screen, landscape, black), own icons in `public/icons/` (192, 512, maskable 512,
180 for iOS, SVG; regenerate with `node tools/make-icons.mjs`) and a small hand-written service worker
(no Workbox / vite-plugin-pwa).

- **Chrome / Edge** (Windows, macOS, Linux, Android): *Install* in the address bar or the menu
  (Android: *Add to Home screen* → *Install*). Verified with Chromium's own installability check
  (`Page.getInstallabilityErrors` is empty, `tests/e2e/pwa.spec.ts`).
- **iPhone / iPad**: Safari → *Share* → *Add to Home Screen*. `index.html` carries
  `apple-touch-icon`, `apple-mobile-web-app-capable`, `-title` and a black-translucent status bar.
  iOS has no install prompt and ignores the manifest orientation; the app opens without browser UI.
- Paths are relative (`start_url`, `scope` and `id` are `./`, the worker is `./sw.js`), so the app works
  on GitHub Pages in `/roadster-flight-test/` and from the web ZIP in any folder of any web server.
  Service workers need HTTPS (or `localhost`); over plain HTTP or `file://` the game runs without one.

**Service worker** (`tools/pwa/sw.template.js`, written as `sw.js` into the build output by the Vite
plugin `tools/pwa/plugin.ts`; registered by `src/pwa/register.ts`):

| What | Cache | Strategy |
|---|---|---|
| `index.html`, manifest, icons, fonts, hashed JS/CSS/workers in `assets/` (6.4 MB, ~2.5 MB over gzip) | `rft-shell-<build hash>` | precached on install; cache first; any `?query` gets the cached page |
| everything under `assets/<folder>/` (car, McGregor scene, textures, worlds, props; 147 files) | `rft-assets` | cached on first use, key = URL + content hash of the file |
| other files (licence texts, `LIESMICH.txt`) | – | network |

- The worker registers only after the game is ready, so the precache does not slow the first start.
  On the first visit the page loaded its files before the worker existed; the worker then copies those
  files into its cache (mostly from the HTTP cache), so the next start is already offline-capable.
- **Versions:** the plugin hashes every file at build time. A new deploy gets a new shell cache (the old
  one is deleted) and keeps every asset whose content did not change; changed assets are dropped and
  fetched again when needed. The new worker installs in the background during a visit and waits; at the
  next start `register.ts` activates it and reloads the page once, so that start already runs the new
  build with matching assets (a version is never mixed with the other's files in one session).
- **Offline after one visit:** title menu, free play, the stunts at McGregor and every world that was
  opened online at least once. Worlds never opened need a connection. The browser may evict the
  cache when storage runs low; Safari also clears the data of a site not used for 7 days unless it
  was added to the home screen.
- **Boot screen:** Resource Timing has no sizes for files served by a worker (`transferSize` 0; WebKit
  also reports 0 body size). Under the worker, `index.html` therefore counts the sizes the worker
  reports for each file it serves (taken from the build), so the MB figure and the bar move on cached
  starts too (measured: Chromium 23.5 MB network / 29.4 MB cached, WebKit 24.6 / 26.6 MB; the figure is
  the amount loaded, not network traffic).
- `?nosw` unregisters the worker and deletes its caches (debugging).

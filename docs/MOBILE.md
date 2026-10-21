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
  - right: floating attitude stick (yaw; pull = nose up, as on a gamepad), **Lift**, **Down**,
    **Boost** and the two roll buttons;
  - top right: **⋯** (tray with assist level, fans, aero, compressor, reverse, launch mode, slow
    motion, photo mode, pause, help), **Cam**, **↺** (reset) and **☰** (menu).
  The overlay writes analog values per control id into `InputManager.touch`; the mapper treats
  them like a gamepad, so every action of `src/input/bindings.ts` is reachable and keyboard or
  gamepad rebinding has no effect on the touch layout. Menus are plain buttons and work by tap.
- **Portrait.** A dismissable hint asks to turn the device to landscape. Title menu and HUD are
  laid out for landscape; the title screen also fits in portrait.

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
- The **⋯** tray covers the top-right HUD readouts while it is open.
- No gyro steering, no haptics, no on-screen rebinding for the touch layout.
- The HUD is sized for desktop; on small phones some secondary readouts are tight.

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

  (WebKit needs `npx playwright install webkit`.) Under the default desktop config the spec
  forces the touch UI with `?touch` and skips the mobile-only quality check.
- Unit tests: `tests/ui/touch.test.ts` (stick mapping, touch → mapper, every control reachable,
  device classification, mobile caps).

Debug switches: `?touch` forces the touch UI on desktop, `?q=low`, `?webgl` force quality and
renderer, `?bootslow=<s>` shortens the stall hint thresholds.

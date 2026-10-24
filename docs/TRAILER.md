# Trailer

The trailer is rendered from the game itself, frame by frame on a fixed clock: no screen recording, no dropped
frames, any resolution, and every shot can be rendered again exactly the same. Everything lives in `tools/trailer/`;
the output goes to `trailer-out/` (not in git).

## Story (≈ 83 s)

| Part | Shots |
|---|---|
| Earth | `01-liftoff` McGregor at night, the jets fire · `02-stonehenge` · `03-giza` · `04-starbase` drift on the build field, the camera rises to the tower as Starship lifts off · `05-ascent` |
| Space | `06-moon` Tranquility Base · `07-mars` Jezero with Perseverance · `08-sun` the car against the solar disc · `09-roadster1` Roadster 1 with Starman, fade to black |
| Twist | `dos` DOS boot · `10-editor` the retro editor builds Starbase Sprint on the beat of the 8-bit tune, click on "Test drive" |
| Back | `11-return` from the editor's top view down to the start line, flight over the loop · `12-finale` Super Heavy is caught by the tower, end card with QR code |

## Running it

```bash
npm run build && npx vite preview --port 4173      # the shots run against the production build
node tools/trailer/run.mjs 01-liftoff 02-stonehenge  # 1080p60 frames + game sound → trailer-out/<shot>.mp4
SCOUT=1 node tools/trailer/run.mjs 04-starbase      # 8 stills → trailer-out/scout/<shot>.jpg (framing)
W=3840 H=2160 node tools/trailer/run.mjs …          # 4K
node tools/trailer/cards.mjs                         # DOS boot frames + end card (TRAILER_LANG=en for English)
node tools/trailer/audio.mjs                         # 8-bit tune, DOS and editor sounds (after cards + 10-editor)
node tools/trailer/assemble.mjs                      # → trailer-out/trailer.mp4
```

Music: put the score as `trailer-out/music.wav` (or `.mp3`); `assemble.mjs` lays it from the first frame to the end of
the Sun part and fades it out there. The 8-bit tune, the DOS and editor sounds are synthesised in `audio.mjs` (own
work, no samples).

## How it works

- `window.__rft.captureBegin()` stops the real-time loop and holds the full resolution;
  `captureFrame(dt)` runs one fixed simulation + render step; `captureCut()` clears the temporal history on a cut.
- Game sound: the AudioEngine is moved onto an `OfflineAudioContext` that is suspended at every frame time, so the
  sound is rendered in lockstep with the pictures (`record()` in `lib.mjs`).
- `flyPath()` puts the car on a spline before every physics step (jets, wheels, dust and tracks react as usual),
  `controls()` replaces the device input, `camera()` drives the camera along keys (fixed points above the ground,
  points relative to the car in world axes or in its heading frame, the Starship stages).
- The editor shot draws its own mouse pointer and writes the times of key presses and clicks for the sound.

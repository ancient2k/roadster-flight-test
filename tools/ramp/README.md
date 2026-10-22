# Wall-ramp profile fit (R15)

Fits the wall ramp of `src/shared/track.ts` (`WALL`) and the stream cameras to frames of the Tesla stream
(`research/videos/tesla_roadster_event_x.mp4`, not in the repository).

```
python3 tools/ramp/masks.py <video.mp4> <workdir>      # frames + ramp masks (674, 700, 720, 727–728 s)
python3 tools/ramp/fit.py <workdir> one 4                # arc to 170° + straight; 'free' = three arcs + straight
```

- `ramp.py` – profile sampling (same as `sampleProfile`), pinhole camera, silhouette rendering, IoU.
- `masks.py` – lit driving surface (grey concrete + red LED edges) per frame inside a region of interest.
- `fit.py` – least squares on silhouette edges (two-way chamfer), the car at the ramp foot (scale and angle of
  each camera), the car's roof position at 14 HUD pitch readings and the settled HUD hang altitude.

Needs Python 3 with numpy, scipy and opencv-python, and ffmpeg. The evidence and the trade-offs against the
HUD are in docs/PHYSICS.md (Stunts and validation).

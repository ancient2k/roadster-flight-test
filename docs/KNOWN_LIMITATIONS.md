# Known limitations

- **Not photorealistic.** The look follows the live stream closely in framing, light and effects, but the
  condensation clouds are still too compact and rounded, the finale ground too bright, and several surfaces (car
  rear, stones, foil) too uniform for a real photo.
- **Estimated vehicle data.** Much of the Roadster's data is not public; estimates are tagged `[EST]` in
  `src/shared/roadster.ts`.
- **Drivable pyramids are a simplification.** The car drives on a smooth replacement surface through the outer
  stone courses; the real stepped and weathered faces would not be drivable.
- **Sun dive** leaves out the ≈ 30 km/s orbital velocity (it could not be removed with the onboard air).
- **Stonehenge layout:** stone 22 is shown as a stump and lintel 122 is missing (both were re-erected in 1958).
- **Apollo 15 "Falcon"** stands level; the real descent stage is tilted by ≈ 11°.
- **Lunar tyre tracks** still show segment ends in close-ups.
- **Performance:** Giza at "high" can drop below 60 fps on mid-range hardware.
- **Tested hardware:** automated tests ran on macOS with Chromium (WebGPU and WebGL2). Safari, Firefox,
  Windows, Linux and mobile devices were not tested.

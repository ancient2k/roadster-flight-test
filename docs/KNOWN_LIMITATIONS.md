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
- **Languages:** apart from English and German, the 12 UI languages are machine translations and have not been
  reviewed by native speakers. Right-to-left languages (Arabic, Hebrew) are not supported: menus, canvas HUD and
  result chart are laid out left-to-right. The HUD ring captions, unit labels and the 0–60 timer stay English in
  every language (they mimic the stream graphics), and the default units stay imperial like the stream.
- **Fonts:** the project font "RFT Display" covers Latin (with the accents of the shipped languages) and
  Cyrillic only. Japanese, Korean and Chinese fall back to the system font (system-ui, Hiragino, PingFang,
  Microsoft YaHei, Malgun Gothic, Noto Sans), so their look depends on the operating system; without any CJK
  system font those texts show as boxes. Long translations are squeezed horizontally in the fixed HUD slots
  rather than wrapped.

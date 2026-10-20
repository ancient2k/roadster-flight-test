// Stunt tuning constants. Values marked [TOOL] come from offline sweeps in tools/gnc/*.tool.ts
// (see docs/PHYSICS.md for the sweep results).
import { G0 } from '@shared/math';
import type { AeroMode } from '@shared/types';

export const TUNING = {
  kickflip: {
    approachAccelMs2: 6.0,     // gentle run-up (fans off, low drag)
    entrySpeedMs: 19.7,        // [TOOL] sweep + tools/gnc/video.tool.ts: 3.49 g launch, 7.92 m apex, video g peaks within 0.45 g
    rollRate: 5.0,             // rad/s
    rollAccel: 12,             // rad/s²
    rollDelayS: 0.12,          // start the roll after the rear wheels have left the lip
    ballisticGain: 4,        // 1/s, cancel the roll pulses' net lift while inverted
    landingDecel: 0.9 * G0,
    bailHeightM: 2.5,
  },
  groundFlip: {
    climbTW: 2.9,              // lift thrust / weight for the take-off burn
    apexAltM: 8.0,             // TRACK reference
    rollRate: 5.0,
    rollAccel: 12,
    landingDecel: 1.0 * G0,
    bailHeightM: 2.0,
  },
  rampLaunch: {
    // Speed profile on the wall (bend R 9.8, vertical straight, curl R 10; see climb phase): g-limited at the entry like the video
    // (1.4 g), cruise on the vertical, then decelerate to the release speed at the top. [TOOL] sweep.
    entrySpeedMs: 6.2,         // 1 + v²/(R g) ≈ 1.4 g on the R 9.8 entry (video 1.4 g)
    climbGLimit: 1.40,         // specific-force budget of the speed profile (g)
    cruiseSpeedMs: 9.0,        // cap of the g-limited speed on the vertical
    exitSpeedMs: 2.0,          // speed at the release point (slow crawl over the top like the video, 17.4 -> 19.6 m in the last second)
    topDecelMs2: 1.3,          // speed-profile deceleration towards the release point (on top of gravity)
    releaseBeforeEndM: 6.4,    // fans off this far (arc length) before the end: leaves at ≈ 19.6 m (video 64.4 ft) on the stream-shaped wall
    rollRate: 3.5,
    rollAccel: 10,
    landingDecel: 0.40 * G0,   // keep = FLIGHT_DESIGN.rampLaunchLandingDecel; net: ≈ 1.4 g specific force in the burn (video 1.4 g at t = 8–9 s)
    touchSinkMs: 0.5,          // landing profile: sink at touchdown and flare height (wheel bottom above the pad)
    flareHeightM: 0.4,
    landingKv: 2.5,            // softer velocity loop than the default 5/s: fewer g overshoots in the long burn
    landingKi: 1.5,            // 1/s², integral on the velocity error: removes the sink bias of a ±10 % mass error
    awaySpeedMs: 4.5,          // horizontal speed away from the wall face during the descent
    fanLevel: null as number | null, // grip-mode fan level on the wall (null = demand control; a fixed 1 makes the skirt seal flutter on R 11)
  },
  rampHang: {
    spoolS: 3.0,
    // wing stowed for the whole stunt: the stream shows it flat on the deck in the run-up (r_017–r_031),
    // from above at ≈ 90° (r_047) and back at the bottom (r_073–r_077); the HUD only shows suction.
    // At ≤ 8 m/s the wing is worth < 10 kg of downforce against 250–4700 kg of fan suction.
    aeroMode: 'lowDrag' as AeroMode,
    approachSpeedMs: 8.0,
    approachLeadMs: 1.0,       // speed reference lead during the run-up (keeps the throttle moderate)
    climbSpeedMs: 2.6,         // crawl speed into the ramp (the climb itself follows the video pitch-time profile)
    holdS: 10.5,
    descendSpeedMs: 3.0,       // reversing off the wall after the profile has ended
    descendLeadS: 0.8,         // time lead of the video pitch reference while reversing down (drive-loop lag)
    holdPitchDeg: 170,
    trackGain: 2.5,            // 1/s, arc-length feedback on the video pitch profile
    minCrawlMs: 0.15,          // speed command limits while following the profile (the video stops briefly at 90°)
    maxCrawlMs: 8.0,
    fanLevel: null as number | null, // demand-controlled suction; 1 = always full
    descendFanMin: 0.58,       // descent fan schedule fitted to the HUD downforce (level at 0° pitch)
    descendFanPerDeg: 0.0063,  //   ... + per degree of pitch: fits the HUD descent (√(F/4700) at 72.6/53.5/35.2/16.3°), full above ≈ 67°
  },
  zero60: {
    accelLimitG: 3.4,          // "retina limit" of the launch program
    targetMs: 26.8224,         // 60 mph
    mainsThrustG: 2.0,         // jet specific force on top of the tyres (≈ 3.4 g cap − 1.4 g tyres)
  },
};
// Not `as const`: the offline tools (tools/gnc) sweep these values at runtime.

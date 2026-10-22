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
    // Speed profile on the wall (one arc R 10.9 to 170°, then the 10 m straight overhang; see climb phase):
    // g-limited at the entry like the video (1.4 g), speeding up as the wall steepens, then a deceleration
    // so the car drives off the END of the overhang (stream 725.4–725.8 s: nose over the edge, then it drops
    // off and carries on away from the wall). [TOOL] sweep (R15): off the lip end at 5.8 s, 22.2 m.
    entrySpeedMs: 6.4,         // 1 + v²/(R g) ≈ 1.4 g on the R 10.9 entry (video 1.4 g)
    climbGLimit: 1.40,         // specific-force budget of the speed profile (g)
    cruiseSpeedMs: 9.0,        // cap of the g-limited speed over the arc (42 m of wall: leaves the lip at ≈ 5.7 s like the stream)
    exitSpeedMs: 3.5,          // speed at the release point (drives off the lip end)
    topDecelMs2: 2.5,          // speed-profile deceleration towards the release point (on top of gravity)
    releaseBeforeEndM: 1.0,    // fans off with the CoG this far (arc length) before the lip end: front wheels at the edge
    rollRate: 3.5,
    rollAccel: 10,
    landingDecel: 0.50 * G0,   // keep = FLIGHT_DESIGN.rampLaunchLandingDecel; net: ≈ 1.5 g specific force in the burn (video 1.4 g at t = 8–9 s,
                               // 2.8–3.2 g peaks between the 1 fps samples); 0.40 g from the 22 m overhang exceeds the 165 kg air budget
    touchSinkMs: 0.5,          // landing profile: sink at touchdown and flare height (wheel bottom above the pad)
    flareHeightM: 0.4,
    landingKv: 2.5,            // softer velocity loop than the default 5/s: fewer g overshoots in the long burn
    landingKi: 1.5,            // 1/s², integral on the velocity error: removes the sink bias of a ±10 % mass error
    awaySpeedMs: 2.0,          // max. horizontal speed away from the wall during the descent
    awayMinMs: 0.5,            // ... down to this rolling speed at touchdown
    awayGain: 0.4,             // 1/s, away speed = gain × distance still to go to landLocalZ (tapers off before touchdown)
    coastHeightM: 2.5,         // below this wheel height the descent holds its along-heading speed (level touchdown)
    landLocalZ: -13,           // ramp-local z the descent heads for (R14 estimate ≈ 13 m in front of the ramp foot; lip end at z = −7.95).
                               // The drift off the overhang (exit speed, half flip) carries the car to ≈ −17 m anyway.
    driveAwayS: 3.5,           // after touchdown: drive off out of the landing cloud for this long (stream 729.7–733 s) ...
    driveAwaySpeedMs: 6.0,     // ... at this speed, then brake to a stop
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
    hangOnLipM: 1.6,           // the stream car crawls this far onto the straight 170° overhang before it hangs (21.06 m HUD)
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

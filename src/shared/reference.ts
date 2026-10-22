// Telemetry transcribed frame by frame from the on-screen HUD of the official Tesla stream
// (research/videos/tesla_roadster_event_x.mp4; frames in research/frames/{ramp,semi_jump}).
// Units as displayed: altitude ft, pitch deg, downforce kg, g-force g. t = seconds from the
// start of the respective manoeuvre (sampled at 1 fps for the ramp, 2 fps for the kickflip).
// Used by result screens (Sim vs. video) and by scenario tests as soft references.
import { FT } from './math';
import type { StuntId } from './types';

export interface RefSample { t: number; altitudeFt?: number; pitchDeg?: number; downforceKg?: number; g?: number; note?: string }

/** Run 1: crawl up the wall ramp on fan suction, hang inverted at 170°, crawl back down. */
const RAMP_HANG: RefSample[] = [
  { t: 0, downforceKg: 2.2, pitchDeg: 0.8, altitudeFt: 0.0, note: 'fans spooling' },
  { t: 3, downforceKg: 45.7, pitchDeg: 0.9, altitudeFt: 0.0 },
  { t: 4, downforceKg: 156, pitchDeg: 1.1, altitudeFt: 0.1 },
  { t: 5, downforceKg: 251, pitchDeg: 4.1, altitudeFt: 0.3, note: 'enters the ramp' },
  { t: 6, downforceKg: 370, pitchDeg: 18.4, altitudeFt: 1.6 },
  { t: 7, downforceKg: 676, pitchDeg: 43.0, altitudeFt: 7.3 },
  { t: 8, downforceKg: 1292, pitchDeg: 67.4, altitudeFt: 17.4 },
  { t: 9, downforceKg: 2210, pitchDeg: 85.0, altitudeFt: 27.0 },
  { t: 10, downforceKg: 3152, pitchDeg: 89.5, altitudeFt: 30.3 },
  { t: 11, downforceKg: 3830, pitchDeg: 90.0, altitudeFt: 30.7 },
  { t: 12, downforceKg: 4239, pitchDeg: 98.2, altitudeFt: 34.5 },
  { t: 13, downforceKg: 4462, pitchDeg: 119, altitudeFt: 44.5 },
  { t: 14, downforceKg: 4581, pitchDeg: 143, altitudeFt: 54.9 },
  { t: 15, downforceKg: 4642, pitchDeg: 163, altitudeFt: 61.0 },
  { t: 16, downforceKg: 4667, pitchDeg: 170, altitudeFt: 63.5 },
  { t: 17, downforceKg: 4682, pitchDeg: 170, altitudeFt: 65.1 },
  { t: 18, downforceKg: 4693, pitchDeg: 170, altitudeFt: 66.4 },
  { t: 19, downforceKg: 4697, pitchDeg: 170, altitudeFt: 67.1 },
  { t: 20, downforceKg: 4697, pitchDeg: 170, altitudeFt: 67.6, note: 'hanging inverted' },
  { t: 21, downforceKg: 4698, pitchDeg: 170, altitudeFt: 68.2 },
  { t: 22, downforceKg: 4700, pitchDeg: 170, altitudeFt: 68.7 },
  { t: 23, downforceKg: 4700, pitchDeg: 170, altitudeFt: 68.8 },
  { t: 24, downforceKg: 4697, pitchDeg: 170, altitudeFt: 68.9 },
  { t: 25, downforceKg: 4699, pitchDeg: 170, altitudeFt: 69.1 },
  { t: 26, downforceKg: 4698, pitchDeg: 169, altitudeFt: 69.1 },
  { t: 27, downforceKg: 4697, pitchDeg: 164, altitudeFt: 69.0, note: 'starts back down' },
  { t: 28, downforceKg: 4698, pitchDeg: 147, altitudeFt: 66.3 },
  { t: 29, downforceKg: 4702, pitchDeg: 128, altitudeFt: 60.3 },
  { t: 30, downforceKg: 4705, pitchDeg: 109, altitudeFt: 52.8 },
  { t: 31, downforceKg: 4707, pitchDeg: 91.0, altitudeFt: 44.3 },
  { t: 32, downforceKg: 4520, pitchDeg: 72.6, altitudeFt: 35.6 },
  { t: 33, downforceKg: 3963, pitchDeg: 53.5, altitudeFt: 27.6 },
  { t: 34, downforceKg: 3219, pitchDeg: 35.2, altitudeFt: 21.6 },
  { t: 35, downforceKg: 2378, pitchDeg: 16.3, altitudeFt: 18.1 },
  { t: 36, downforceKg: 1623, pitchDeg: 2.6, altitudeFt: 17.6, note: 'HUD altitude lags after the ramp' },
];

/**
 * Run 2: drive up the wall ramp, over the arc onto the straight overhang, drive off its end, half flip,
 * cushion the landing with lift jets. 1 fps; the 4 fps frames (R14) show the car with its nose over the
 * overhang end at 5.4 s, off it at ≈ 5.7 s (HUD peak 67.8 ft at 6.0–6.25 s, the readout lags: the end of
 * the overhang is ≈ 1.4 m higher than the hang point that settles at 69.1 ft in run 1) and touchdown at
 * ≈ 9.7 s. Where it lands: R14 read ≈ 13 m in front of the ramp foot through a wrong camera; with the
 * stream camera calibrated on the ramp (R15, tools/ramp/) the car is ≈ 33 m out at 7.5 s and ≈ 37–42 m
 * out at 8.0 s, 3–5 m up (direction from the image position and distance from the car's apparent length
 * agree). Not adopted yet: the sim lands ≈ 17 m out (docs/PHYSICS.md).
 * Between the 1 fps samples the burn peaks at 2.8–3.2 g (7.75–8.0 s), which this table does not hold.
 */
const RAMP_LAUNCH: RefSample[] = [
  { t: 0, g: 1.4, altitudeFt: 0.4, note: 'enters the ramp' },
  { t: 1, g: 1.4, altitudeFt: 6.7 },
  { t: 2, g: 0.9, altitudeFt: 25.0 },
  { t: 3, g: 0.9, altitudeFt: 43.0 },
  { t: 4, g: 0.8, altitudeFt: 57.0 },
  { t: 5, g: 1.1, altitudeFt: 64.4, note: 'over the curl onto the lip' },
  { t: 6, g: 0.4, altitudeFt: 57.5, note: 'off the lip end, half flip' },
  { t: 7, g: 0.6, altitudeFt: 47.3, note: '4 lift jets firing down' },
  { t: 8, g: 1.4, altitudeFt: 11.9 },
  { t: 9, g: 1.4, altitudeFt: 5.2 },
  { t: 10, g: 1.0, altitudeFt: 0.4, note: 'touchdown' },
  { t: 11, g: 1.0, altitudeFt: 1.0 },
];

/** Kickflip over the Semi and the row of cars (2 fps). */
const KICKFLIP: RefSample[] = [
  { t: 0.0, g: 1.1, altitudeFt: 0.0, note: 'approach' },
  { t: 0.5, g: 1.0, altitudeFt: 0.0 },
  { t: 1.0, g: 3.5, altitudeFt: 0.0, note: 'kicker' },
  { t: 1.5, g: 0.5, altitudeFt: 6.6, note: 'airborne' },
  { t: 2.0, g: 0.2, altitudeFt: 18.6, note: 'rolling' },
  { t: 2.5, g: 0.2, altitudeFt: 23.3 },
  { t: 2.75, g: 0.2, altitudeFt: 25.2, note: 'apex' },
  { t: 3.0, g: 0.2, altitudeFt: 25.1 },
  { t: 3.5, g: 0.7, altitudeFt: 20.8, note: 'landing burn' },
  { t: 4.0, g: 1.4, altitudeFt: 16.5 },
  { t: 4.5, g: 2.0, altitudeFt: 7.6 },
  { t: 5.0, g: 1.4, altitudeFt: 2.0 },
  { t: 5.5, g: 0.9, altitudeFt: 0.3, note: 'touchdown' },
  { t: 6.0, g: 1.0, altitudeFt: 0.1 },
  { t: 6.5, g: 1.1, altitudeFt: 0.0 },
];

export const VIDEO_REFERENCE: Partial<Record<StuntId, RefSample[]>> = {
  ramp_hang: RAMP_HANG,
  ramp_launch: RAMP_LAUNCH,
  kickflip: KICKFLIP,
};

export const ftToM = (ft: number): number => ft * FT;

// Airborne spawns for flight-phase tests (start the stunt automaton mid-flight on the real plant).
import { DEG, qaxisAngle, qmul, qrot, v3 } from '../../../src/shared/math';
import { TRACK, profileLength, rampLocalToWorld, sampleProfile } from '../../../src/shared/track';
import type { SpawnPose } from '../../../src/shared/types';
import type { RoadsterSim } from '../../../src/sim/core/roadsterSim';

/** Car leaving the kicker lip: on the lip surface, pitched like the lip, moving along the tangent, pitching at v/R. */
export function kickflipLipSpawn(speedMs: number): { spawn: SpawnPose; setup: (sim: RoadsterSim) => void } {
  const k = TRACK.ramps.find((r) => r.kind === 'kicker')!;
  const L = profileLength(k.profile);
  const lip = sampleProfile(k.profile, L);
  const pos = rampLocalToWorld(k, v3(0, lip.y, lip.z));
  const heading = qaxisAngle(v3(0, 1, 0), k.headingDeg * DEG);
  const quat = qmul(heading, qaxisAngle(v3(1, 0, 0), -lip.thetaRad)); // nose up = −X
  const R = (k.profile[0] as { radius: number }).radius;
  return {
    spawn: { pos, quat, speedMs },
    setup: (sim) => {
      const w = qrot(quat, v3(-speedMs / R, 0, 0));
      sim.body.setAngvel(w, true);
      sim.body.setTranslation(v3(pos.x, pos.y + 0.45 / Math.cos(lip.thetaRad) + 0.02, pos.z), true);
    },
  };
}

/** Car at the top of the wall ramp, fans just released: inverted, moving back along the overhang (lip) tangent. */
export function rampTopSpawn(sFromEnd: number, speedMs: number): { spawn: SpawnPose; setup: (sim: RoadsterSim) => void } {
  const w = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
  const L = profileLength(w.profile);
  const p = sampleProfile(w.profile, L - sFromEnd);
  const pos = rampLocalToWorld(w, v3(0, p.y, p.z));
  const heading = qaxisAngle(v3(0, 1, 0), w.headingDeg * DEG);
  const quat = qmul(heading, qaxisAngle(v3(1, 0, 0), -p.thetaRad));
  return {
    spawn: { pos, quat, speedMs },
    setup: (sim) => {
      // CoG 0.45 m inside (toward the arc centre) plus 3 cm clearance, i.e. hanging under the overhang
      const n = qrot(quat, v3(0, 0.48, 0));
      sim.body.setTranslation(v3(pos.x + n.x, pos.y + n.y, pos.z + n.z), true);
      // pitch rate v/R on a curl, none on the straight lip
      const last = w.profile[w.profile.length - 1];
      const R = last.kind === 'arc' && L - sFromEnd > L - profileLength([last]) ? last.radius : Infinity;
      sim.body.setAngvel(qrot(quat, v3(-speedMs / R, 0, 0)), true);
    },
  };
}

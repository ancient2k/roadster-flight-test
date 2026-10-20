// Nominal mass properties as GNC believes them (dry config + measured air mass).
// Deliberately NOT read from Rapier: the Monte Carlo scales the plant's true mass/inertia and the
// controller has to be robust against that mismatch.
import { ROADSTER } from '@shared/roadster';
import { v3, type Vec3 } from '@shared/math';

export interface MassProps { mass: number; com: Vec3; inertia: Vec3 }

export const newMassProps = (): MassProps => ({ mass: ROADSTER.dryMassKg, com: v3(), inertia: v3(ROADSTER.dryInertia.x, ROADSTER.dryInertia.y, ROADSTER.dryInertia.z) });

/** Mirrors RoadsterSim.updateMassProperties with nominal (unscaled) parameters. */
export function nominalMassProps(airKg: number, out: MassProps = newMassProps()): MassProps {
  const dry = ROADSTER.dryMassKg;
  const air = Math.max(0, airKg);
  const m = dry + air;
  const tp = ROADSTER.tank.pos;
  const cx = (air * tp.x) / m, cy = (air * tp.y) / m, cz = (air * tp.z) / m;
  const ax = tp.x - cx, ay = tp.y - cy, az = tp.z - cz;
  const I = ROADSTER.dryInertia;
  out.mass = m;
  out.com.x = cx; out.com.y = cy; out.com.z = cz;
  out.inertia.x = I.x + dry * (cy * cy + cz * cz) + air * (ay * ay + az * az);
  out.inertia.y = I.y + dry * (cx * cx + cz * cz) + air * (ax * ax + az * az);
  out.inertia.z = I.z + dry * (cx * cx + cy * cy) + air * (ax * ax + ay * ay);
  return out;
}

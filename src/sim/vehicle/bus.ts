// Shared scratch state between the force modules of one vehicle (one bus per sim).
import { v3, type Vec3 } from '@shared/math';

/** Functional damage fed into the vehicle modules by the damage model (src/sim/vehicle/damage.ts).
 *  Neutral values = intact car; with the damage setting off they never change. Wheels FL, FR, RL, RR. */
export class DamageFactors {
  /** Toe error from bent links (rad, + = towards +X/left), added to the wheel's steer angle. */
  readonly toeRad = new Float64Array(4);
  /** Tyre/rim condition: scales the friction peak. */
  readonly gripScale = new Float64Array(4).fill(1);
  /** 1 = wheel torn off (no contact, no forces). */
  readonly wheelLost = new Uint8Array(4);
  /** Torn fan skirt per quadrant: extra leak gap (m) along the quadrant's skirt. */
  readonly skirtLeakM = new Float64Array(4);
  /** Downforce left after the rear wing was torn off. */
  downforceScale = 1;
  reset(): void { this.toeRad.fill(0); this.gripScale.fill(1); this.wheelLost.fill(0); this.skirtLeakM.fill(0); this.downforceScale = 1; }
}

export class VehicleBus {
  /** Wheels in contact this step. */
  contactCount = 0;
  /** Mean surface normal of the contacting wheels (world), valid when contactCount > 0. */
  readonly surfaceNormal: Vec3 = v3(0, 1, 0);
  /** Max over wheels of |F_tire| / (mu Fz) last step (0..1). */
  tireUtilization = 0;
  /** Sum of tire in-plane force magnitudes last step (N). */
  tireForceN = 0;
  /** Fan suction force applied last step (N, along -Y body). */
  fanForceN = 0;
  /** Aero drag / downforce applied this step (N). */
  aeroDragN = 0;
  aeroDownforceN = 0;
  /** Mean friction of the contacting wheels' surfaces relative to asphalt (1 on asphalt). */
  muScale = 1;
  /** Max dust hint of the wheels last step (0..1). */
  dust = 0;
  readonly damage = new DamageFactors();
  reset(): void {
    this.contactCount = 0; this.surfaceNormal.x = 0; this.surfaceNormal.y = 1; this.surfaceNormal.z = 0;
    this.tireUtilization = 0; this.tireForceN = 0; this.fanForceN = 0; this.aeroDragN = 0; this.aeroDownforceN = 0;
    this.muScale = 1; this.dust = 0;
    this.damage.reset();
  }
}

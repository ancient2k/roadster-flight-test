// Shared scratch state between the force modules of one vehicle (one bus per sim).
import { v3, type Vec3 } from '@shared/math';

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
  reset(): void {
    this.contactCount = 0; this.surfaceNormal.x = 0; this.surfaceNormal.y = 1; this.surfaceNormal.z = 0;
    this.tireUtilization = 0; this.tireForceN = 0; this.fanForceN = 0; this.aeroDragN = 0; this.aeroDownforceN = 0;
    this.muScale = 1; this.dust = 0;
  }
}

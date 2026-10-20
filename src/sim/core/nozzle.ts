// Converging–diverging cold-gas nozzle. Throat area is sized so that the nozzle produces its
// nominal thrust at the regulator set point and ambient temperature; thrust and mass flow
// then follow from feed pressure/temperature (choked flow, isentropic expansion, pressure thrust).
import type { NozzleSpec } from '@shared/roadster';
import { ROADSTER } from '@shared/roadster';
import { CHOKE_GAMMA, CRIT_PR, GAMMA, P_ATM, R_AIR, pressureRatio, supersonicMach, temperatureRatio } from './gas';

export const NOZZLE_CD = 0.97;        // discharge coefficient
export const NOZZLE_VEL_EFF = 0.96;   // velocity efficiency (divergence + friction losses)

export interface NozzleOutput { thrustN: number; mdot: number; exitPressureRatio: number; exitMach: number; exitVel: number }

export class NozzleModel {
  readonly spec: NozzleSpec;
  readonly exitMach: number;
  readonly prExit: number;      // pe/p0
  readonly trExit: number;      // Te/T0
  throatArea = 0;
  exitArea = 0;

  constructor(spec: NozzleSpec, refPressure = ROADSTER.tank.regulatorSetpointPa, refTemp = ROADSTER.tank.ambientTempK) {
    this.spec = spec;
    this.exitMach = supersonicMach(spec.expansionRatio);
    this.prExit = pressureRatio(this.exitMach);
    this.trExit = temperatureRatio(this.exitMach);
    // thrust per unit throat area at the reference condition
    const unit = this.evaluate(refPressure, refTemp, 1, 1);
    this.throatArea = spec.nominalThrustN / unit.thrustN;
    this.exitArea = this.throatArea * spec.expansionRatio;
  }

  /** Choked-flow coefficient k so that ṁ = k·p0 (used by the regulator). */
  flowCoeff(T0: number): number {
    return (NOZZLE_CD * this.throatArea * CHOKE_GAMMA) / Math.sqrt(R_AIR * T0);
  }

  compute(p0: number, T0: number, pa = P_ATM): NozzleOutput {
    return this.evaluate(p0, T0, this.throatArea, this.exitArea / Math.max(this.throatArea, 1e-12), pa);
  }

  private evaluate(p0: number, T0: number, At: number, eps: number, pa = P_ATM): NozzleOutput {
    const Ae = At * (eps === 1 ? this.spec.expansionRatio : eps);
    if (p0 <= pa * 1.0001 || At <= 0) return { thrustN: 0, mdot: 0, exitPressureRatio: 1, exitMach: 0, exitVel: 0 };
    if (pa / p0 > CRIT_PR) {
      // Unchoked (very low feed pressure): subsonic isentropic flow through the throat.
      const pr = pa / p0;
      const Mt = Math.sqrt((2 / (GAMMA - 1)) * (Math.pow(pr, -(GAMMA - 1) / GAMMA) - 1));
      const Tt = T0 * temperatureRatio(Mt);
      const rho = pa / (R_AIR * Tt);
      const v = Mt * Math.sqrt(GAMMA * R_AIR * Tt);
      const mdot = NOZZLE_CD * rho * v * At;
      return { thrustN: mdot * v * NOZZLE_VEL_EFF, mdot, exitPressureRatio: 1, exitMach: Mt, exitVel: v };
    }
    const mdot = (NOZZLE_CD * p0 * At * CHOKE_GAMMA) / Math.sqrt(R_AIR * T0);
    const Te = T0 * this.trExit;
    const ve = NOZZLE_VEL_EFF * this.exitMach * Math.sqrt(GAMMA * R_AIR * Te);
    const pe = p0 * this.prExit;
    // Strongly overexpanded flow separates; clamp the negative pressure term (Summerfield-ish).
    const pressureThrust = Math.max((pe - pa) * Ae, -0.4 * pa * Ae);
    const thrust = Math.max(0, mdot * ve + pressureThrust);
    // In vacuum the ratio is unbounded; cap it (visuals/audio use it as "how underexpanded").
    return { thrustN: thrust, mdot, exitPressureRatio: pa > 1 ? pe / pa : 1000, exitMach: this.exitMach, exitVel: ve };
  }
}

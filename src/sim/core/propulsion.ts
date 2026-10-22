// Cold-gas propulsion system: valves -> regulator/feed -> nozzles -> tank.
// Shared kernel used by the vehicle sim (physics) and by GNC for thrust-availability estimates.
import { ROADSTER, type NozzleSpec } from '@shared/roadster';
import type { NozzleState } from '@shared/types';
import { v3, v3scale, type Vec3 } from '@shared/math';
import { P_ATM } from './gas';
import { NozzleModel } from './nozzle';
import { Tank } from './tank';
import { ValveBank, type ValveCfg } from './valves';

export interface NozzleForce { pointBody: Vec3; forceBody: Vec3 }

/** Compressor setting: 'game' ("Fun", default) or 'realistic'. */
export type CompressorMode = 'realistic' | 'game';

/**
 * Refill rate and supply per compressor setting.
 * - 'game': a full tank (250 kg) in 20 s on every world. Off Earth the air comes from an on-board supply,
 *   a gameplay simplification: there is nothing to draw in on the Moon or in space, and Mars (610 Pa) is far too thin.
 * - 'realistic': 6–7 h per tank as stated in the stream, and only where the atmosphere allows it (Earth).
 */
export function compressorConfig(mode: CompressorMode): { rateKgS: number; onboard: boolean } {
  return mode === 'game'
    ? { rateKgS: ROADSTER.tank.refillKgPerSGame, onboard: true }
    : { rateKgS: ROADSTER.tank.refillKgPerSRealistic, onboard: false };
}

export class Propulsion {
  readonly tank: Tank;
  readonly valves: ValveBank;
  readonly nozzles: NozzleModel[];
  readonly specs: readonly NozzleSpec[];
  /** Per-nozzle state of the last step. */
  readonly states: NozzleState[];
  /** Per-nozzle force of the last step in the body frame. */
  readonly forces: NozzleForce[];
  /** Actual open fraction of the last step, per nozzle (telemetry thrusterDuty). */
  readonly dutyActual: Float32Array;
  totalMassFlow = 0;
  ambientPressure = P_ATM;
  refillRateKgS: number = ROADSTER.tank.refillKgPerSGame;
  /** Compressor supply: false = it draws in the ambient atmosphere, so it only works where the environment
   *  allows it (Environment.canRefill); true = on-board supply (setting "Compressor: Fun"), refills on every world. */
  refillOnboard = false;
  /** Damage hooks (src/sim/vehicle/damage.ts): thrust factor per nozzle (crushed bell) and the area of a feed
   *  line leak between regulator and valves (m²); 1 / 0 for an intact car. */
  readonly thrustScale: Float64Array;
  leakAreaM2 = 0;
  /** Air lost through the leak last step (kg/s). */
  leakKgS = 0;

  /** Apply the compressor setting (see compressorConfig). */
  setCompressor(mode: CompressorMode): void {
    const c = compressorConfig(mode);
    this.refillRateKgS = c.rateKgS; this.refillOnboard = c.onboard;
  }

  constructor(specs: readonly NozzleSpec[] = ROADSTER.nozzles, valveCfg?: ValveCfg) {
    this.specs = specs;
    this.tank = new Tank();
    this.valves = new ValveBank(specs.length, valveCfg);
    this.nozzles = specs.map((s) => new NozzleModel(s));
    this.states = specs.map(() => ({ open: false, thrustN: 0, massFlowKgS: 0, exitPressureRatio: 1 }));
    this.forces = specs.map((s) => ({ pointBody: { ...s.pos }, forceBody: v3() }));
    this.dutyActual = new Float32Array(specs.length);
    this.thrustScale = new Float64Array(specs.length).fill(1);
  }

  reset(airMassKg: number = ROADSTER.tank.fullMassKg): void {
    this.tank.fill(airMassKg);
    this.valves.reset();
    for (const s of this.states) { s.open = false; s.thrustN = 0; s.massFlowKgS = 0; s.exitPressureRatio = 1; }
    for (const f of this.forces) f.forceBody.x = f.forceBody.y = f.forceBody.z = 0;
    this.dutyActual.fill(0);
    this.totalMassFlow = 0;
  }

  /**
   * Thrust each nozzle would deliver if opened alone right now (N). GNC uses this as the
   * actuator capability; it accounts for tank blowdown below the regulator set point.
   */
  availableThrust(out: Float64Array = new Float64Array(this.specs.length)): Float64Array {
    const T0 = this.tank.T;
    const pf = Math.min(this.tank.pressure, ROADSTER.tank.regulatorSetpointPa);
    for (let i = 0; i < this.nozzles.length; i++) out[i] = this.nozzles[i].compute(pf, T0, this.ambientPressure).thrustN;
    return out;
  }

  /** One fixed step: duty request -> actual forces (body frame) + tank update. */
  step(dt: number, duty: ArrayLike<number>, refill: boolean): void {
    const frac = this.valves.step(dt, duty);
    const T0 = this.tank.T;
    let k = 0;
    for (let i = 0; i < this.nozzles.length; i++) if (frac[i] > 0) k += frac[i] * this.nozzles[i].flowCoeff(T0);
    const pf = this.tank.computeFeedPressure(k);
    let mdotTotal = 0;
    for (let i = 0; i < this.nozzles.length; i++) {
      const st = this.states[i];
      const f = frac[i];
      this.dutyActual[i] = f;
      if (f <= 0 || this.tank.m <= 0.01) {
        st.open = false; st.thrustN = 0; st.massFlowKgS = 0; st.exitPressureRatio = 1;
        v3scale(this.forces[i].forceBody, 0, this.forces[i].forceBody);
        continue;
      }
      const o = this.nozzles[i].compute(pf, T0, this.ambientPressure);
      st.open = f >= 0.5;
      st.thrustN = o.thrustN * f * this.thrustScale[i];
      st.massFlowKgS = o.mdot * f;
      st.exitPressureRatio = o.exitPressureRatio;
      mdotTotal += st.massFlowKgS;
      v3scale(this.specs[i].dir, st.thrustN, this.forces[i].forceBody);
    }
    this.totalMassFlow = mdotTotal;
    // choked leak at feed pressure: ṁ = A·p·√(γ/R)·(2/(γ+1))^((γ+1)/(2(γ−1))) / √T = 0.0404·A·p/√T (air)
    this.leakKgS = this.leakAreaM2 > 0 && this.tank.m > 0.01
      ? 0.0404 * this.leakAreaM2 * Math.min(this.tank.pressure, ROADSTER.tank.regulatorSetpointPa) / Math.sqrt(T0) : 0;
    this.tank.step(dt, mdotTotal + this.leakKgS, refill ? this.refillRateKgS : 0);
  }
}

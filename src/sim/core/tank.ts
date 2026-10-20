// Composite overwrapped pressure vessels (2 x COPV, 600 L) as ONE open thermodynamic system.
//   Equation of state: Abel–Noble  p = ρRT / (1 − bρ),  u = cv·T,  h = cp·T + b·p
//   Mass:   dm/dt = ṁ_in − ṁ_out
//   Energy: d(m·u)/dt = Q̇_wall + ṁ_in·h_in − ṁ_out·h_gas
//   Wall:   M_w c_w dT_w/dt = −Q̇_wall + hA_amb (T_amb − T_w)
// Pressure regulator feeds all nozzles at a set point with a flow limit (droop) and a line loss.
// Simplification (documented): feed stagnation temperature = tank gas temperature.
import { ROADSTER } from '@shared/roadster';
import type { TankState } from '@shared/types';

type Widen<T> = { [K in keyof T]: T[K] extends number ? number : T[K] extends object ? Widen<T[K]> : T[K] };
export type TankCfg = Widen<typeof ROADSTER.tank>;

export class Tank {
  readonly cfg: TankCfg;
  m = 0;          // kg
  U = 0;          // J (internal energy of the gas)
  Tw = 288;       // K wall
  feedPressure = 0;
  regulated = false;

  constructor(cfg: TankCfg = ROADSTER.tank) {
    this.cfg = cfg;
    this.fill(cfg.fullMassKg, cfg.ambientTempK);
  }

  fill(massKg: number, tempK = this.cfg.ambientTempK): void {
    this.m = Math.max(1e-4, massKg);
    this.U = this.m * this.cfg.cv * tempK;
    this.Tw = tempK;
    this.feedPressure = Math.min(this.pressure, this.cfg.regulatorSetpointPa);
  }

  get T(): number { return this.U / (this.m * this.cfg.cv); }
  get rho(): number { return this.m / this.cfg.volumeM3; }
  get pressure(): number {
    const rho = this.rho, b = this.cfg.abelNobleB;
    return (rho * this.cfg.gasR * this.T) / Math.max(1e-6, 1 - b * rho);
  }
  get cp(): number { return this.cfg.cv + this.cfg.gasR; }
  /** Specific enthalpy of the tank gas (Abel–Noble). */
  get h(): number { return this.cp * this.T + this.cfg.abelNobleB * this.pressure; }

  /**
   * Feed pressure the regulator can hold for a requested total choked-flow coefficient.
   * Choked nozzles draw ṁ = k·p_feed with k = Σ(Cd·A*·Γ/√(R·T0)) of the open valves.
   */
  computeFeedPressure(flowCoeffSum: number): number {
    const p = this.pressure, c = this.cfg;
    if (flowCoeffSum <= 0) {
      this.regulated = p >= c.regulatorSetpointPa;
      this.feedPressure = Math.min(p, c.regulatorSetpointPa);
      return this.feedPressure;
    }
    // Upstream availability with line loss proportional to flow fraction.
    let pf = Math.min(c.regulatorSetpointPa, p);
    for (let i = 0; i < 4; i++) {
      const mdot = flowCoeffSum * pf;
      const loss = c.feedLossCoeff * Math.min(1.5, mdot / c.regulatorMaxFlowKgS);
      const upstream = p * (1 - loss);
      const flowLimited = c.regulatorMaxFlowKgS / flowCoeffSum; // pressure at which flow hits the limit
      pf = Math.min(c.regulatorSetpointPa, upstream, Math.max(flowLimited, 0));
    }
    this.regulated = pf >= c.regulatorSetpointPa * 0.999;
    this.feedPressure = Math.max(0, pf);
    return this.feedPressure;
  }

  /** Integrate one step with total outflow mdotOut (kg/s) and optional refill inflow. */
  step(dt: number, mdotOut: number, mdotIn = 0): void {
    const c = this.cfg;
    const out = Math.min(mdotOut * dt, Math.max(0, this.m - 1e-3));
    const hOut = this.h;
    const hIn = this.cp * c.ambientTempK + c.abelNobleB * this.pressure; // aftercooled compressor delivery
    const Qwall = c.wallHeatTransferWPerK * (this.Tw - this.T);
    const inn = Math.max(0, Math.min(mdotIn * dt, c.fullMassKg * 1.02 - this.m));
    this.U += Qwall * dt + inn * hIn - out * hOut;
    this.m += inn - out;
    const Qamb = c.wallToAmbientWPerK * (c.ambientTempK - this.Tw);
    this.Tw += ((-Qwall + Qamb) * dt) / (c.wallMassKg * c.wallCp);
    // Guard against numerical extremes at near-empty states.
    const Tmin = 60;
    if (this.U < this.m * c.cv * Tmin) this.U = this.m * c.cv * Tmin;
  }

  state(): TankState {
    return {
      airMassKg: this.m,
      pressurePa: this.pressure,
      gasTempK: this.T,
      wallTempK: this.Tw,
      feedPressurePa: this.feedPressure,
      regulated: this.regulated,
    };
  }
}

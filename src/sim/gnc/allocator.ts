// Thrust allocator: desired body wrench (force about CoM + moment) -> duty 0..1 per nozzle.
//
// Lexicographic (hierarchical) box-constrained least squares, solved as a short sequence of small QPs:
//   pass k:  min Σ_{r∈level k} ((B_r d − w_r)/s_r)²                     (normalised errors)
//              + W_lock Σ_{r∈level<k} ((B_r d − ŵ_r)/s_r)²              (lock what higher levels achieved)
//              + λ_fuel Σ c_i d_i + λ_rate Σ (d_i − d_prev,i)² + ε Σ d_i²
//            s.t. lo ≤ d ≤ hi
// Each axis gets a priority level per flight phase (e.g. landing: body-up force + roll/pitch moment
// first, yaw and lateral force last). Valve awareness: callers can raise `lo` for valves that are
// inside their minimum on-time (that impulse is coming anyway) and lower `hi` to mask nozzles.
import { N_NOZ, WRENCH_DIM, applyEffectiveness } from './wrench';
import { BoxQP } from './boxqp';

/** Priority level per wrench axis [Fx,Fy,Fz,Mx,My,Mz]: 0 = highest; -1 = don't care. */
export type Levels = ArrayLike<number>;

export const LEVELS = {
  /** Everything equally important (moment slightly first). */
  balanced: [1, 1, 1, 0, 0, 0],
  /**
   * Landing: wheels-down attitude (pitch/roll) first, braking (body-up force) second, then yaw and
   * lateral force. Attitude before braking: a tilted car brakes less and lands on a corner; with
   * healthy jets both are met, the order only matters when the jets saturate (e.g. a failed valve).
   */
  landing: [3, 1, 3, 0, 2, 0],
  /**
   * Emergency landing with a REAR corner jet stuck closed: the three remaining corner jets cannot make
   * lift without a nose-up moment (wet CoM behind the jets' midpoint, see docs/PHYSICS.md).
   * Braking and roll first, pitch best effort, yaw free (the yaw couple of the diagonal pair spins
   * the car, which cones the body-fixed pitch moment instead of letting it accumulate).
   */
  landingRearFault: [3, 0, 3, 1, 1, 0],
  /** Rotation manoeuvres: all moments first, then force. */
  rotate: [2, 1, 2, 0, 0, 0],
  /** Ascent/boost: attitude, then lift, then the rest. */
  ascent: [2, 1, 2, 0, 1, 0],
} as const;

const W_LOCK = 1e4;

export class Allocator {
  readonly n = N_NOZ;
  readonly duty = new Float64Array(N_NOZ);
  readonly prev = new Float64Array(N_NOZ);
  readonly lo = new Float64Array(N_NOZ);
  readonly hi = new Float64Array(N_NOZ).fill(1);
  /** Achieved wrench of the final solution. */
  readonly achieved = new Float64Array(WRENCH_DIM);
  /** Normalised residual per axis (|B d − w| / s). */
  readonly residual = new Float64Array(WRENCH_DIM);
  fuelWeight = 2e-3;
  rateWeight = 5e-3;
  ridge = 1e-7;
  private readonly qp = new BoxQP(N_NOZ);
  private readonly H = new Float64Array(N_NOZ * N_NOZ);
  private readonly g = new Float64Array(N_NOZ);
  private readonly target = new Float64Array(WRENCH_DIM);
  private readonly weight = new Float64Array(WRENCH_DIM);
  private readonly cost = new Float64Array(N_NOZ);

  reset(): void { this.duty.fill(0); this.prev.fill(0); this.lo.fill(0); this.hi.fill(1); }

  /**
   * @param B effectiveness matrix (wrench.ts)
   * @param w desired wrench [N, N·m]
   * @param scale normalisation per axis (e.g. m·g for forces, I·α_ref for moments)
   * @param levels priority level per axis
   */
  solve(B: Float64Array, w: ArrayLike<number>, scale: ArrayLike<number>, levels: Levels): Float64Array {
    const n = this.n;
    // fuel cost ∝ thrust magnitude of each nozzle (all nozzles share the same exhaust velocity)
    const sF = Math.max(1, scale[1]);
    for (let i = 0; i < n; i++) this.cost[i] = Math.hypot(B[i], B[n + i], B[2 * n + i]) / sF;
    let maxLevel = -1;
    for (let r = 0; r < WRENCH_DIM; r++) if (levels[r] > maxLevel) maxLevel = levels[r];
    this.prev.set(this.duty);
    const d = this.duty;
    for (let L = 0; L <= maxLevel; L++) {
      let any = false;
      for (let r = 0; r < WRENCH_DIM; r++) {
        const lv = levels[r];
        if (lv < 0 || lv > L) { this.weight[r] = 0; continue; }
        if (lv === L) { this.weight[r] = 1; this.target[r] = w[r]; any = true; }
        else { this.weight[r] = W_LOCK; this.target[r] = this.achieved[r]; }
      }
      if (!any) continue;
      this.assemble(B, scale);
      this.qp.solve(this.H, this.g, this.lo, this.hi, d);
      applyEffectiveness(B, d, this.achieved);
    }
    for (let r = 0; r < WRENCH_DIM; r++) this.residual[r] = Math.abs(this.achieved[r] - w[r]) / Math.max(1e-9, scale[r]);
    return d;
  }

  private assemble(B: Float64Array, scale: ArrayLike<number>): void {
    const n = this.n, H = this.H, g = this.g;
    H.fill(0); g.fill(0);
    for (let r = 0; r < WRENCH_DIM; r++) {
      const wr = this.weight[r];
      if (wr === 0) continue;
      const k = wr / (scale[r] * scale[r]);
      const t = this.target[r];
      for (let i = 0; i < n; i++) {
        const bi = B[r * n + i];
        if (bi === 0) continue;
        g[i] -= k * bi * t;
        for (let j = 0; j < n; j++) H[i * n + j] += k * bi * B[r * n + j];
      }
    }
    for (let i = 0; i < n; i++) {
      H[i * n + i] += this.rateWeight + this.ridge;
      g[i] += 0.5 * this.fuelWeight * this.cost[i] - this.rateWeight * this.prev[i];
    }
  }
}

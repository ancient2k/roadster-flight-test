// Thruster effectiveness ("wrench") matrix in the body frame about the current centre of mass.
// Column i = wrench of nozzle i fully open at its currently available thrust:
//   F_i = dir_i · T_i,  M_i = (pos_i − com) × F_i
// Rows: [Fx, Fy, Fz, Mx, My, Mz]. Row-major storage B[r * N + i].
// One geometry for feasibility analysis AND allocation (no second model).
import { ROADSTER, type NozzleSpec } from '@shared/roadster';
import type { Vec3 } from '@shared/math';
import { NOZZLE_COUNT } from '@shared/types';

export const WRENCH_DIM = 6;
export const N_NOZ = NOZZLE_COUNT;
export const AXIS_NAMES = ['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'] as const;

export function buildEffectiveness(
  com: Vec3, thrust: ArrayLike<number>, out: Float64Array = new Float64Array(WRENCH_DIM * N_NOZ),
  specs: readonly NozzleSpec[] = ROADSTER.nozzles,
): Float64Array {
  const n = specs.length;
  for (let i = 0; i < n; i++) {
    const s = specs[i], T = Math.max(0, thrust[i]);
    const fx = s.dir.x * T, fy = s.dir.y * T, fz = s.dir.z * T;
    const rx = s.pos.x - com.x, ry = s.pos.y - com.y, rz = s.pos.z - com.z;
    out[0 * n + i] = fx; out[1 * n + i] = fy; out[2 * n + i] = fz;
    out[3 * n + i] = ry * fz - rz * fy;
    out[4 * n + i] = rz * fx - rx * fz;
    out[5 * n + i] = rx * fy - ry * fx;
  }
  return out;
}

/** w = B d */
export function applyEffectiveness(B: Float64Array, d: ArrayLike<number>, out: Float64Array = new Float64Array(WRENCH_DIM)): Float64Array {
  const n = N_NOZ;
  for (let r = 0; r < WRENCH_DIM; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += B[r * n + i] * d[i];
    out[r] = s;
  }
  return out;
}

/**
 * Support function of the attainable wrench set (a zonotope for d ∈ [0,1]^N):
 * max_d uᵀ B d = Σ_i max(0, (Bᵀu)_i). Also returns the maximising duty vector.
 */
export function supportAlong(B: Float64Array, u: ArrayLike<number>, dOut?: Float64Array): number {
  const n = N_NOZ;
  let s = 0;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let r = 0; r < WRENCH_DIM; r++) c += B[r * n + i] * u[r];
    if (dOut) dOut[i] = c > 0 ? 1 : 0;
    if (c > 0) s += c;
  }
  return s;
}

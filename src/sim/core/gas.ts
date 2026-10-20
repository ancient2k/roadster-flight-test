// Compressible-flow helpers for air (calorically perfect for nozzle flow).

export const GAMMA = 1.4;
export const R_AIR = 287.05;
export const CP_AIR = (GAMMA * R_AIR) / (GAMMA - 1);
export const P_ATM = 101_325;

/** Mass-flow function Γ = sqrt(γ)·(2/(γ+1))^((γ+1)/(2(γ−1))). */
export const CHOKE_GAMMA = Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));
/** Critical pressure ratio p_star / p0. */
export const CRIT_PR = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));

/** Isentropic area ratio A/A* for Mach M. */
export function areaRatio(M: number): number {
  const g = GAMMA;
  return (1 / M) * Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M), (g + 1) / (2 * (g - 1)));
}

/** Supersonic Mach number for a given area ratio (Newton on log form). */
export function supersonicMach(eps: number): number {
  if (eps <= 1) return 1;
  let M = 1 + Math.sqrt(eps); // decent start for supersonic branch
  for (let i = 0; i < 40; i++) {
    const f = areaRatio(M) - eps;
    const h = 1e-6 * M;
    const df = (areaRatio(M + h) - areaRatio(M - h)) / (2 * h);
    const step = f / df;
    M = Math.max(1.0001, M - step);
    if (Math.abs(step) < 1e-10) break;
  }
  return M;
}

/** Static/stagnation pressure ratio p/p0 at Mach M. */
export const pressureRatio = (M: number): number => Math.pow(1 + ((GAMMA - 1) / 2) * M * M, -GAMMA / (GAMMA - 1));
/** Static/stagnation temperature ratio T/T0 at Mach M. */
export const temperatureRatio = (M: number): number => 1 / (1 + ((GAMMA - 1) / 2) * M * M);

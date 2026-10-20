// Balanced lift envelope with one corner jet dead: max body-up force with zero pitch/roll moment
// (yaw free / limited) over the healthy jets (no mains). Brute force over a duty grid.
import { it } from 'vitest';
import { ROADSTER } from '../../src/shared/roadster';
import { nominalMassProps } from '../../src/sim/gnc/massProps';
import { buildEffectiveness, N_NOZ, WRENCH_DIM } from '../../src/sim/gnc/wrench';

it('balanced lift with one dead corner', () => {
  for (const air of [250, 150, 60]) {
    const mp = nominalMassProps(air);
    const thrust = new Float64Array(N_NOZ).fill(0);
    for (let i = 0; i < N_NOZ; i++) thrust[i] = ROADSTER.nozzles[i].nominalThrustN;
    const B = new Float64Array(WRENCH_DIM * N_NOZ);
    buildEffectiveness(mp.com, thrust, B);
    const row = (r: number, d: number[]) => d.reduce((s, x, i) => s + B[r * N_NOZ + i] * x, 0);
    console.log(`air ${air} kg: CoM z ${mp.com.z.toFixed(3)} y ${mp.com.y.toFixed(3)} mass ${mp.mass.toFixed(0)}`);
    for (const dead of [-1, 4, 5, 6, 7]) {
      let best = { fy: 0, d: [] as number[], my: 0 };
      const S = 20;
      for (let a = 0; a <= S; a++) for (let b = 0; b <= S; b++) for (let c = 0; c <= S; c++) for (let e = 0; e <= S; e++) for (const y8 of [0, 0.5, 1]) for (const y9 of [0, 0.5, 1]) {
        const d = [0, 0, 0, 0, a / S, b / S, c / S, e / S, y8, y9];
        if (dead >= 0) d[dead] = 0;
        const mx = row(3, d), mz = row(5, d), my = row(4, d);
        if (Math.abs(mx) > 300 || Math.abs(mz) > 300) continue;
        const fy = row(1, d);
        if (fy > best.fy) best = { fy, d, my };
      }
      console.log(`  dead ${dead}: max balanced lift ${(best.fy / (mp.mass * 9.81)).toFixed(2)} g (yaw ${(best.my / 1e3).toFixed(1)} kNm) duty ${best.d.slice(4).map((x) => x.toFixed(2)).join(',')}`);
    }
  }
});

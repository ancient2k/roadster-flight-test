// Small dense box-constrained convex QP:  min ½ xᵀHx + gᵀx  s.t. lo ≤ x ≤ hi
// Primal active-set method with warm start. Exact (finite) for strictly convex H, deterministic,
// allocation-free after construction. n ≤ ~16 (we use n = 10 thrusters).

export class BoxQP {
  readonly n: number;
  private readonly state: Int8Array;   // 0 free, -1 at lower, +1 at upper
  private readonly idx: Int32Array;
  private readonly L: Float64Array;    // Cholesky factor of H_FF
  private readonly rhs: Float64Array;
  private readonly y: Float64Array;
  private readonly grad: Float64Array;
  iterations = 0;

  constructor(n: number) {
    this.n = n;
    this.state = new Int8Array(n);
    this.idx = new Int32Array(n);
    this.L = new Float64Array(n * n);
    this.rhs = new Float64Array(n);
    this.y = new Float64Array(n);
    this.grad = new Float64Array(n);
  }

  /** Solves in place: x holds the warm start on entry and the optimum on exit. Returns iterations. */
  solve(H: Float64Array, g: Float64Array, lo: Float64Array, hi: Float64Array, x: Float64Array, maxIter = 60): number {
    const n = this.n, st = this.state;
    for (let i = 0; i < n; i++) {
      let v = x[i];
      if (!(v >= lo[i])) v = lo[i];
      if (v > hi[i]) v = hi[i];
      x[i] = v;
      st[i] = hi[i] - lo[i] < 1e-12 ? -1 : v <= lo[i] ? -1 : v >= hi[i] ? 1 : 0;
    }
    let it = 0;
    for (; it < maxIter; it++) {
      // free set
      let nf = 0;
      for (let i = 0; i < n; i++) if (st[i] === 0) this.idx[nf++] = i;
      // candidate: y_F = −H_FF⁻¹ (g_F + H_FB x_B)
      if (nf > 0) {
        for (let a = 0; a < nf; a++) {
          const i = this.idx[a];
          let r = g[i];
          for (let j = 0; j < n; j++) if (st[j] !== 0) r += H[i * n + j] * x[j];
          this.rhs[a] = -r;
        }
        this.cholSolve(H, nf);
      }
      // step toward the candidate, stop at the first bound
      let alpha = 1, block = -1, blockSide = 0;
      for (let a = 0; a < nf; a++) {
        const i = this.idx[a], yi = this.y[a], xi = x[i];
        if (yi < lo[i] - 1e-14) {
          const al = (lo[i] - xi) / (yi - xi);
          if (al < alpha) { alpha = al; block = i; blockSide = -1; }
        } else if (yi > hi[i] + 1e-14) {
          const al = (hi[i] - xi) / (yi - xi);
          if (al < alpha) { alpha = al; block = i; blockSide = 1; }
        }
      }
      if (alpha < 0) alpha = 0;
      for (let a = 0; a < nf; a++) { const i = this.idx[a]; x[i] += alpha * (this.y[a] - x[i]); }
      if (block >= 0) {
        st[block] = blockSide as -1 | 1;
        x[block] = blockSide < 0 ? lo[block] : hi[block];
        continue;
      }
      // KKT check on bound variables (multiplier sign)
      for (let i = 0; i < n; i++) {
        let s = g[i];
        for (let j = 0; j < n; j++) s += H[i * n + j] * x[j];
        this.grad[i] = s;
      }
      let worst = -1, worstV = 1e-12;
      for (let i = 0; i < n; i++) {
        if (hi[i] - lo[i] < 1e-12) continue;
        const v = st[i] === -1 ? -this.grad[i] : st[i] === 1 ? this.grad[i] : 0;
        if (v > worstV) { worstV = v; worst = i; }
      }
      if (worst < 0) break;
      st[worst] = 0;
    }
    this.iterations = it;
    return it;
  }

  /** Cholesky of the free sub-block, solve into this.y. Adds a tiny jitter if needed. */
  private cholSolve(H: Float64Array, nf: number): void {
    const n = this.n, L = this.L, idx = this.idx;
    for (let a = 0; a < nf; a++) {
      for (let b = 0; b <= a; b++) {
        let s = H[idx[a] * n + idx[b]];
        for (let k = 0; k < b; k++) s -= L[a * n + k] * L[b * n + k];
        if (a === b) L[a * n + a] = Math.sqrt(Math.max(s, 1e-12));
        else L[a * n + b] = s / L[b * n + b];
      }
    }
    const y = this.y;
    for (let a = 0; a < nf; a++) {
      let s = this.rhs[a];
      for (let k = 0; k < a; k++) s -= L[a * n + k] * y[k];
      y[a] = s / L[a * n + a];
    }
    for (let a = nf - 1; a >= 0; a--) {
      let s = y[a];
      for (let k = a + 1; k < nf; k++) s -= L[k * n + a] * y[k];
      y[a] = s / L[a * n + a];
    }
  }
}

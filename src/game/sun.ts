// "Sonnensturz": radial fall into the Sun with time warp and a lumped thermal model of the car.
// Honest physics: cold gas (Δv ≈ 75 m/s) cannot cancel ~30 km/s of orbital velocity, so the dive is
// presented as a radial infall from rest (Kepler, GM☉) under adjustable time compression.
// Thermal: m·c·dT/dt = α·S(r)·A_abs − ε·σ·A_rad·T⁴   with S(r) = S0·(AU/r)².
// DOM-free, tested in tests/game/sun.test.ts.

export const GM_SUN = 1.32712440018e20;   // m³/s²
export const AU = 1.495978707e11;         // m
export const R_SUN = 6.957e8;             // m
export const S0 = 1361;                   // W/m² at 1 AU
export const SIGMA = 5.670374419e-8;

export interface CarThermal {
  heatCapacityJK: number;   // m·c of the whole car
  absorbArea: number;       // m², projected area facing the Sun
  radiateArea: number;      // m², total emitting area
  absorptivity: number;     // solar α ("Ano White" paint, rises once the paint chars)
  emissivity: number;       // thermal ε
}

export const ROADSTER_THERMAL: CarThermal = {
  heatCapacityJK: 1950 * 900, absorbArea: 4.0, radiateArea: 25, absorptivity: 0.35, emissivity: 0.85,
};

export interface DiveStage { id: string; label: string; tempK?: number; rAU?: number }

/** Failure / milestone stages, in order. Temperatures: realistic material limits. */
export const STAGES: DiveStage[] = [
  { id: 'venus', label: 'Venusbahn gekreuzt', rAU: 0.723 },
  { id: 'paint', label: 'Lack verkohlt', tempK: 520 },
  { id: 'mercury', label: 'Merkurbahn gekreuzt', rAU: 0.387 },
  { id: 'cfrp', label: 'Carbon-Harz zersetzt sich', tempK: 650 },
  { id: 'tires', label: 'Reifen brennen', tempK: 750 },
  { id: 'aluminium', label: 'Aluminium schmilzt', tempK: 933 },
  { id: 'glass', label: 'Scheiben erweichen', tempK: 1000 },
  { id: 'steel', label: 'Stahl schmilzt', tempK: 1700 },
  { id: 'titanium', label: 'Titan schmilzt', tempK: 1941 },
  { id: 'vapor', label: 'Verglüht', tempK: 3000 },
];

export interface DiveState {
  t: number;          // physical seconds since the dive started
  r: number;          // m from the Sun's centre
  v: number;          // m/s, radial speed toward the Sun (positive = inbound)
  tempK: number;
  stage: number;      // number of stages reached so far
  done: boolean;      // car vaporised or reached the photosphere
}

export class SunDive {
  state: DiveState;
  /** Time compression factor (physical seconds per real second). */
  warp = 1e5;
  readonly events: DiveStage[] = [];
  private readonly reached = new Set<string>();
  private readonly r0: number;

  constructor(r0AU = 1.0, startTempK = 230, readonly car: CarThermal = ROADSTER_THERMAL) {
    this.r0 = r0AU * AU;
    this.state = { t: 0, r: this.r0, v: 0, tempK: startTempK, stage: 0, done: false };
  }

  /** Solar flux at distance r (W/m²). */
  static flux(r: number): number { return S0 * (AU / r) ** 2; }

  /** Radiative equilibrium temperature at distance r for this car (K). */
  equilibriumTemp(r: number): number {
    const c = this.car;
    return ((c.absorptivity * SunDive.flux(r) * c.absorbArea) / (c.emissivity * SIGMA * c.radiateArea)) ** 0.25;
  }

  /** Analytic radial infall speed from rest at r0 (energy conservation). */
  speedAt(r: number): number { return Math.sqrt(Math.max(0, 2 * GM_SUN * (1 / r - 1 / this.r0))); }

  get rAU(): number { return this.state.r / AU; }

  /** Advance by a real-time frame dt (seconds); internally sub-steps the physical time dt·warp. */
  update(dtReal: number): DiveStage[] {
    const fresh: DiveStage[] = [];
    const s = this.state;
    if (s.done) return fresh;
    let remaining = dtReal * this.warp;
    while (remaining > 0 && !s.done) {
      // step bounded by orbit dynamics (1 % of r/v) and by the thermal time constant
      const vNow = Math.max(s.v, 1);
      const c = this.car;
      const tauThermal = c.heatCapacityJK / (4 * c.emissivity * SIGMA * c.radiateArea * s.tempK ** 3 + 1e-9);
      const h = Math.min(remaining, 0.01 * s.r / vNow, 0.2 * tauThermal, 86400);
      // radial motion (semi-implicit Euler on a = GM/r²)
      const a = GM_SUN / (s.r * s.r);
      s.v += a * h;
      s.r = Math.max(R_SUN, s.r - s.v * h);
      // thermal (implicit in the T⁴ term for stability)
      const absorbed = c.absorptivity * SunDive.flux(s.r) * c.absorbArea;
      // Newton step on f(T) = T - T0 - h/C (Q - εσA T⁴)
      let T = s.tempK;
      for (let i = 0; i < 4; i++) {
        const rad = c.emissivity * SIGMA * c.radiateArea;
        const f = T - s.tempK - (h / c.heatCapacityJK) * (absorbed - rad * T ** 4);
        const df = 1 + (h / c.heatCapacityJK) * 4 * rad * T ** 3;
        T -= f / df;
      }
      s.tempK = T;
      s.t += h;
      remaining -= h;
      // stages: temperature and distance milestones are independent of each other
      for (const st of STAGES) {
        if (this.reached.has(st.id)) continue;
        const hit = st.tempK !== undefined ? s.tempK >= st.tempK : s.r / AU <= (st.rAU ?? 0);
        if (!hit) continue;
        this.reached.add(st.id);
        s.stage = this.reached.size;
        fresh.push(st);
        this.events.push(st);
        // charred paint absorbs far more sunlight
        if (st.id === 'paint') (this as { car: CarThermal }).car = { ...this.car, absorptivity: 0.9 };
      }
      if (s.r <= R_SUN * 1.0001 || this.reached.has('vapor')) s.done = true;
    }
    return fresh;
  }
}

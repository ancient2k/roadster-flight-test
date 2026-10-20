// heliocentric orbit of Roadster 1 and how a ram changes it. DOM-free (tests/game/orbit.test.ts).
//
// Start state: JPL Horizons, object -143205 "Tesla Roadster (spacecraft)", solution s11, 2026-10-19 00:00 TDB,
// heliocentric, ecliptic & mean equinox J2000 (km, km/s). Horizons notes that the object is the whole stack
// (Falcon Heavy second stage + payload adapter + Roadster), permanently attached; the Roadster alone ≈ 1250 kg.
//
// Scene frame (Sun scene): the Sun lies ahead on +Z. Its orientation in space is taken from the state itself:
// +Z = toward the Sun (−r̂), +Y = orbit normal (ĥ, ≈ ecliptic north at i ≈ 1°), +X = Y × Z = −(direction of
// flight for a circular orbit). A Δv in the scene frame is rotated into the ecliptic frame and added to v.

/** GM of the Sun (m³/s², DE440 – as used by Horizons). */
export const GM_SUN_DE440 = 1.32712440041279e20;
export const AU_M = 1.495978707e11;
const DEGR = 180 / Math.PI;

export interface V { x: number; y: number; z: number }

/** Horizons state of Roadster 1 (m, m/s), epoch 2026-10-19 00:00 TDB. */
export const ROADSTER1_STATE = {
  epoch: '2026-10-19 00:00 TDB',
  r: { x: 2.223391517214325e11, y: 1.367733052392987e10, z: 3.038826255838319e9 },
  v: { x: -6.519644982462502e3, y: 2.189695716503070e4, z: 2.162025319287677e2 },
  /** Osculating elements Horizons lists for the same epoch (checks for the element routine). */
  horizons: { a: 1.982583704636095e11, e: 0.2559518028856563, iDeg: 1.074783648304190, q: 1.475137831062763e11, Q: 2.490029578209428e11, periodS: 4.814723479960138e7, nodeDeg: 316.8726573467081, argPeriDeg: 177.7869088186601 },
} as const;

/** Roadster + Starman (Horizons: ~1250 kg with batteries) and the whole stack it is bolted to (~5,9 t, Wikipedia). */
export const ROADSTER1_MASS_KG = 1250;
export const ROADSTER1_STACK_KG = 5900;

export interface OrbitElements {
  a: number;          // semi-major axis (m)
  e: number;
  iDeg: number;
  nodeDeg: number;    // longitude of the ascending node Ω
  argPeriDeg: number; // argument of perihelion ω
  trueAnomalyDeg: number;
  q: number;          // perihelion distance (m)
  Q: number;          // aphelion distance (m)
  periodS: number;
  speed: number;      // |v| (m/s)
  r: number;          // |r| (m)
}

const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: V) => Math.hypot(a.x, a.y, a.z);
const scale = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/** Classical orbital elements from a heliocentric state (ellipse expected). */
export function elementsFromState(r: V, v: V, mu = GM_SUN_DE440): OrbitElements {
  const rm = len(r), vm = len(v);
  const h = cross(r, v), hm = len(h);
  const ev = add(scale(cross(v, h), 1 / mu), scale(r, -1 / rm));
  const e = len(ev);
  const a = 1 / (2 / rm - (vm * vm) / mu);
  const iDeg = Math.acos(h.z / hm) * DEGR;
  const node = { x: -h.y, y: h.x, z: 0 }, nm = len(node);
  let nodeDeg = Math.atan2(node.y, node.x) * DEGR; if (nodeDeg < 0) nodeDeg += 360;
  let argPeriDeg = Math.acos(Math.max(-1, Math.min(1, dot(node, ev) / (nm * e)))) * DEGR;
  if (ev.z < 0) argPeriDeg = 360 - argPeriDeg;
  let ta = Math.acos(Math.max(-1, Math.min(1, dot(ev, r) / (e * rm)))) * DEGR;
  if (dot(r, v) < 0) ta = 360 - ta;
  return {
    a, e, iDeg, nodeDeg, argPeriDeg, trueAnomalyDeg: ta, q: a * (1 - e), Q: a * (1 + e),
    periodS: 2 * Math.PI * Math.sqrt((a * a * a) / mu), speed: vm, r: rm,
  };
}

/** Unit axes of the scene frame in ecliptic coordinates (see header). */
export function sceneAxes(r: V = ROADSTER1_STATE.r, v: V = ROADSTER1_STATE.v): { X: V; Y: V; Z: V } {
  const Z = scale(r, -1 / len(r));
  const h = cross(r, v);
  const Y = scale(h, 1 / len(h));
  const X = cross(Y, Z);
  return { X, Y, Z };
}

/** Scene-frame vector → ecliptic J2000. */
export function sceneToEcliptic(d: V, axes = sceneAxes()): V {
  return add(add(scale(axes.X, d.x), scale(axes.Y, d.y)), scale(axes.Z, d.z));
}

export interface RamResult {
  dv: V;                                   // Δv in the scene frame (m/s)
  dvMag: number;
  /** Components along the flight direction (prograde), outward from the Sun (radial) and the orbit normal. */
  prograde: number; radial: number; normal: number;
  before: OrbitElements; after: OrbitElements;
}

/** New orbit after an instantaneous Δv (scene frame) at the Horizons epoch. */
export function orbitAfterDv(dvScene: V, state: { r: V; v: V } = ROADSTER1_STATE): RamResult {
  const axes = sceneAxes(state.r, state.v);
  const dvE = sceneToEcliptic(dvScene, axes);
  const before = elementsFromState(state.r, state.v);
  const after = elementsFromState(state.r, add(state.v, dvE));
  const vh = scale(state.v, 1 / len(state.v));
  const rh = scale(state.r, 1 / len(state.r));
  return {
    dv: dvScene, dvMag: len(dvScene), prograde: dot(dvE, vh), radial: dot(dvE, rh), normal: dot(dvE, axes.Y), before, after,
  };
}

/**
 * Δv the whole stack (car + second stage, ROADSTER1_STACK_KG) would get from the same ram: same closing speed and
 * restitution → impulse ∝ reduced mass μ = m_player·m / (m_player + m).
 */
export function stackEquivalentDv(dvCar: V, playerMassKg: number, carKg = ROADSTER1_MASS_KG, stackKg = ROADSTER1_STACK_KG): V {
  const mu = (m: number) => (playerMassKg * m) / (playerMassKg + m);
  return scale(dvCar, (mu(stackKg) / mu(carKg)) * (carKg / stackKg));
}

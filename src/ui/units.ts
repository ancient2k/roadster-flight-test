// Unit conversion and number formatting in the style of the Tesla stream HUD.
// Pure, DOM-free (tested in tests/ui/units.test.ts).
//
// "imperial" mirrors the stream exactly: ft for altitude, mph for speed, but downforce stays in kg
// (the stream shows DOWNFORCE in KG). Tank pressure uses psi in imperial, bar in metric.
import { FT, MPH } from '../shared/math';

export type Units = 'imperial' | 'metric';

export interface Readout { value: string; unit: string }

const PSI = 6894.757; // Pa

/** One decimal below 100, integer above (stream: "20.8", "69.0", "98.2", "170"). */
export function fmtAdaptive(v: number): string {
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  const s = a < 99.95 ? a.toFixed(1) : Math.round(a).toString();
  return (v < 0 && s !== '0.0' && s !== '0' ? '-' : '') + s;
}

export function altitude(m: number, units: Units): Readout {
  return units === 'imperial' ? { value: fmtAdaptive(m / FT), unit: 'FT' } : { value: fmtAdaptive(m), unit: 'M' };
}

export function speed(ms: number, units: Units): Readout {
  const v = units === 'imperial' ? ms / MPH : ms * 3.6;
  return { value: Math.round(Math.abs(v)).toString(), unit: units === 'imperial' ? 'MPH' : 'KM/H' };
}

export function gForce(g: number): Readout {
  return { value: Number.isFinite(g) ? Math.abs(g).toFixed(1) : '--', unit: 'G' };
}

export function downforce(kg: number): Readout {
  return { value: Number.isFinite(kg) ? Math.max(0, Math.round(kg)).toString() : '--', unit: 'KG' };
}

export function pitch(deg: number): Readout {
  return { value: fmtAdaptive(deg), unit: 'DEG' };
}

export function pressure(bar: number, units: Units): Readout {
  return units === 'imperial'
    ? { value: Math.round((bar * 1e5) / PSI).toLocaleString('en-US'), unit: 'PSI' }
    : { value: Math.round(bar).toString(), unit: 'BAR' };
}

export function mass(kg: number): Readout {
  return { value: kg.toFixed(kg < 10 ? 1 : 0), unit: 'KG' };
}

/** Timer in the stream's 0-60 style: HH:MM:SS:CC (centiseconds). */
export function streamTimer(seconds: number): string {
  const cs = Math.max(0, Math.floor(seconds * 100 + 1e-6));
  const c = cs % 100, s = Math.floor(cs / 100) % 60, m = Math.floor(cs / 6000) % 60, h = Math.floor(cs / 360000);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(c)}`;
}

export function metresToDisplay(m: number, units: Units): number { return units === 'imperial' ? m / FT : m; }
export function speedToDisplay(ms: number, units: Units): number { return units === 'imperial' ? ms / MPH : ms * 3.6; }

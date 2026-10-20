// Phase 2: worlds (celestial body) and sites (places on it). Single source for physics, render, UI.
// Terrain heightmaps are produced under public/assets/worlds/<siteId>/:
//   height.bin  – little-endian Uint16, row-major, rows along +Z (north = -Z), columns along +X
//   meta.json   – TerrainMeta (below)
import type { Vec3 } from './math';
import { ENVIRONMENTS, type BodyId, type Environment, type SurfaceKind } from './environment';
import { fmtNum, t } from '../i18n';

export type SiteId =
  | 'earth_mcgregor' | 'earth_stonehenge' | 'earth_giza'
  | 'moon_tranquility' | 'moon_hadley' | 'moon_shackleton'
  | 'mars_jezero' | 'mars_gale' | 'mars_valles'
  | 'space_sun';

export interface TerrainMeta {
  /** Samples per side (square). */
  size: number;
  /** World extent of the heightmap (metres per side), centred on the site origin. */
  extentM: number;
  /** Height = minM + (u16 / 65535) * (maxM - minM). */
  minM: number;
  maxM: number;
  /** Height at the site origin is shifted to y = 0 by the loader. */
  source: string;
}

export interface SiteDef {
  id: SiteId;
  body: BodyId;
  /** Display name (translated on read: site.<id>.name). */
  readonly name: string;
  /** Short description for the map screen (site.<id>.subtitle). */
  readonly subtitle: string;
  /** 'track' = McGregor layout (TRACK), 'terrain' = heightmap, 'space' = no ground. */
  ground: 'track' | 'terrain' | 'space';
  /** Dominant ground material of the site (McGregor ramps are concrete, see colliderInfo kind 'ramp'). */
  surface: SurfaceKind;
  spawn: { pos: Vec3; headingDeg: number; speedMs: number };
  /** Direction TO the sun (world, unit). */
  sunDir: Vec3;
  /** Local time of day look. */
  look: 'night' | 'day' | 'lunar_day' | 'lunar_low_sun' | 'mars_day' | 'deep_space';
  /** Real-world reference (for the info panel), formatted for the current locale. */
  readonly coords: string;
  /** Latitude/longitude in degrees (+N/+E) with the number of decimals to show; null = no surface position. */
  geo: { lat: number; lon: number; digits: [number, number] } | null;
  assetDir: string;      // public/assets/worlds/<id>
  available: boolean;    // set true once the assets exist and are integrated
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

type RawSite = Omit<SiteDef, 'name' | 'subtitle' | 'coords'>;

const RAW_SITES: RawSite[] = [
  { id: 'earth_mcgregor', body: 'earth', surface: 'asphalt',
    ground: 'track', spawn: { pos: { x: 20, y: 0, z: 40 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 0.3, y: -0.4, z: 0.2 }),
    look: 'night', geo: { lat: 31.4, lon: -97.45, digits: [2, 2] }, assetDir: 'assets', available: true },
  { id: 'earth_stonehenge', body: 'earth', surface: 'grass',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: -120 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 0.6, y: 0.25, z: 0.75 }),
    look: 'day', geo: { lat: 51.1789, lon: -1.8262, digits: [4, 4] }, assetDir: 'assets/worlds/earth_stonehenge', available: true },
  { id: 'earth_giza', body: 'earth', surface: 'sand',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: -300 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: -0.4, y: 0.55, z: 0.3 }),
    look: 'day', geo: { lat: 29.9792, lon: 31.1342, digits: [4, 4] }, assetDir: 'assets/worlds/earth_giza', available: true },
  { id: 'moon_tranquility', body: 'moon', surface: 'regolith',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: -60 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: -0.8, y: 0.2, z: 0.1 }),
    look: 'lunar_day', geo: { lat: 0.674, lon: 23.473, digits: [3, 3] }, assetDir: 'assets/worlds/moon_tranquility', available: true },
  { id: 'moon_hadley', body: 'moon', surface: 'regolith',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 90, speedMs: 0 }, sunDir: norm({ x: -0.7, y: 0.3, z: -0.2 }),
    look: 'lunar_day', geo: { lat: 26.13, lon: 3.63, digits: [2, 2] }, assetDir: 'assets/worlds/moon_hadley', available: true },
  { id: 'moon_shackleton', body: 'moon', surface: 'regolith',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 1, y: 0.03, z: 0.1 }),
    look: 'lunar_low_sun', geo: { lat: -89.67, lon: 129.78, digits: [2, 2] }, assetDir: 'assets/worlds/moon_shackleton', available: true },
  { id: 'mars_jezero', body: 'mars', surface: 'mars_soil',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 0.5, y: 0.5, z: 0.2 }),
    look: 'mars_day', geo: { lat: 18.38, lon: 77.58, digits: [2, 2] }, assetDir: 'assets/worlds/mars_jezero', available: true },
  { id: 'mars_gale', body: 'mars', surface: 'mars_soil',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: -0.3, y: 0.6, z: 0.4 }),
    look: 'mars_day', geo: { lat: -5.4, lon: 137.8, digits: [1, 1] }, assetDir: 'assets/worlds/mars_gale', available: true },
  { id: 'mars_valles', body: 'mars', surface: 'mars_soil',
    ground: 'terrain', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 0.2, y: 0.7, z: -0.5 }),
    look: 'mars_day', geo: { lat: -13.5, lon: -61, digits: [1, 0] }, assetDir: 'assets/worlds/mars_valles', available: true },
  { id: 'space_sun', body: 'space', surface: 'asphalt',
    ground: 'space', spawn: { pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, speedMs: 0 }, sunDir: norm({ x: 0, y: 0, z: 1 }),
    look: 'deep_space', geo: null, assetDir: 'assets/worlds/space_sun', available: true },
];

/** "31.40° N 97.45° W" in the locale's number format and compass letters. */
export function coordsText(geo: SiteDef['geo'], id?: SiteId): string {
  if (!geo) return id === 'space_sun' ? t('site.space_sun.coords', { min: fmtNum(1, 1), max: fmtNum(1.66, 2) }) : '';
  const [dLat, dLon] = geo.digits;
  return `${fmtNum(Math.abs(geo.lat), dLat)}° ${t(geo.lat >= 0 ? 'geo.N' : 'geo.S')} ${fmtNum(Math.abs(geo.lon), dLon)}° ${t(geo.lon >= 0 ? 'geo.E' : 'geo.W')}`;
}

/** Same objects as RAW_SITES, with the display texts as getters (they follow the current locale). */
export const SITES: SiteDef[] = RAW_SITES.map((r) => Object.defineProperties(r, {
  name: { enumerable: true, get: () => t(`site.${r.id}.name`) },
  subtitle: { enumerable: true, get: () => t(`site.${r.id}.subtitle`) },
  coords: { enumerable: true, get: () => coordsText(r.geo, r.id) },
}) as SiteDef);

const BODY_IDS: BodyId[] = ['earth', 'moon', 'mars', 'space'];
export const BODY_NAMES: Record<BodyId, string> = Object.defineProperties({} as Record<BodyId, string>,
  Object.fromEntries(BODY_IDS.map((b) => [b, { enumerable: true, get: () => t(`body.${b}`) }])));

export function site(id: SiteId): SiteDef {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown site ${id}`);
  return s;
}

export function environmentFor(id: SiteId): Environment { return ENVIRONMENTS[site(id).body]; }

/** Decode a Uint16 heightmap into metres (Float32Array, size*size), shifted so the centre sample is y = 0. */
export function decodeHeightmap(buf: ArrayBuffer, meta: TerrainMeta): Float32Array {
  const u16 = new Uint16Array(buf);
  if (u16.length !== meta.size * meta.size) throw new Error(`heightmap size mismatch: ${u16.length} vs ${meta.size}²`);
  const out = new Float32Array(u16.length);
  const k = (meta.maxM - meta.minM) / 65535;
  for (let i = 0; i < u16.length; i++) out[i] = meta.minM + u16[i] * k;
  const c = Math.floor(meta.size / 2);
  const y0 = out[c * meta.size + c];
  for (let i = 0; i < out.length; i++) out[i] -= y0;
  return out;
}

/** Bilinear height at world (x, z) in metres; NaN outside the map. */
export function sampleHeight(h: Float32Array, meta: TerrainMeta, x: number, z: number): number {
  const n = meta.size, cell = meta.extentM / (n - 1);
  const fx = (x + meta.extentM / 2) / cell, fz = (z + meta.extentM / 2) / cell;
  if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return Number.NaN;
  const ix = Math.min(n - 2, Math.floor(fx)), iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// Web Worker: bakes the horizon sun visibility off the main thread (see terrainShadow.ts).
import { bakeSunVisibility, type ShadowBakeOptions } from './terrainShadow';
import { TerrainField, type HeightGrid } from './terrainData';

export interface BakeRequest {
  grid: HeightGrid;
  /** Optional height source beyond the grid: near + far tile of the field. */
  outer?: { near: HeightGrid; far: HeightGrid | null; blendM: number } | null;
  opts: Omit<ShadowBakeOptions, 'outer'>; // incl. optional rows slice
}

self.onmessage = (e: MessageEvent<BakeRequest>) => {
  const { grid, outer, opts } = e.data;
  const field = outer ? new TerrainField(outer.near, outer.far, outer.blendM) : null;
  const vis = bakeSunVisibility(grid, { ...opts, outer: field ? (x, z) => field.height(x, z) : undefined });
  (self as unknown as Worker).postMessage(vis, [vis.buffer]);
};

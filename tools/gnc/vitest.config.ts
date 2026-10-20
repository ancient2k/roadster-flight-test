// Runner for offline GNC tools (tuning sweeps, budgets): npx vitest run --config tools/gnc/vitest.config.ts
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vite.config.ts';

export default mergeConfig(base, defineConfig({
  test: { include: ['tools/gnc/**/*.tool.ts'], testTimeout: 3_600_000, silent: false },
}));

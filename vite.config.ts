import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { serviceWorkerPlugin } from './tools/pwa/plugin.ts';

export default defineConfig({
  base: './',
  plugins: [serviceWorkerPlugin()], // sw.js for the installable app (docs/MOBILE.md)
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
    },
  },
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 120_000,
    pool: 'forks',
  },
});

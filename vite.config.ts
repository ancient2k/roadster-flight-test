import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { serviceWorkerPlugin } from './tools/pwa/plugin.ts';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// version shown in the title footer (src/shared/version.ts): package.json version + short commit of the build
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
let commit = 'dev';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_COMMIT__: JSON.stringify(commit) },
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

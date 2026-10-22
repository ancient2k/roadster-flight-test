import { defineConfig, devices } from '@playwright/test';

// The "desktop" project runs every spec. The phone projects (Chromium mobile emulation; WebKit for
// the iPhone needs `npx playwright install webkit`) only run the mobile specs, e.g.
// `npx playwright test mobile --project=phone-small`. PORT overrides the preview port (parallel runs).
const PORT = Number(process.env.PORT ?? 4173);
const MOBILE_SPECS = /mobile.*\.spec\.ts/;
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1600, height: 900 }, channel: 'chromium', launchOptions: { args: GPU_ARGS } } },
    // small phones: 667 x 375 (iPhone SE, shortest long side) and 780 x 360 (Galaxy S24, shortest short side)
    { name: 'phone-small', testMatch: MOBILE_SPECS, use: { ...devices['iPhone SE (3rd gen)'], browserName: 'chromium', channel: 'chromium', launchOptions: { args: GPU_ARGS } } },
    { name: 'galaxy', testMatch: MOBILE_SPECS, use: { ...devices['Galaxy S24'], browserName: 'chromium', channel: 'chromium', launchOptions: { args: GPU_ARGS } } },
    // large Android phone: 839 x 412 in the browser (915 x 412 installed)
    { name: 'pixel7', testMatch: MOBILE_SPECS, use: { ...devices['Pixel 7'], browserName: 'chromium', channel: 'chromium', launchOptions: { args: GPU_ARGS } } },
    // large iPhone with Dynamic Island (WebKit): 739 x 430 viewport in the browser
    { name: 'iphone-max', testMatch: MOBILE_SPECS, use: { ...devices['iPhone 15 Pro Max'], browserName: 'webkit' } },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false, // always test the build of this checkout
    timeout: 240_000,
  },
});

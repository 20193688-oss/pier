/* Playwright: the main flows in a real browser, against the dev server in mock mode (the
   in-browser mock API and the demo wallet), on two phones (Pixel 7 and iPhone 14 sizes) and a
   desktop. Port 4329 so a running dev server (3000, 3200) is never reused by mistake.

   Only Chromium is installed on the machines this runs on: the iPhone 14 profile keeps the
   phone's viewport, touch, scale and user agent, rendered by Chromium rather than WebKit. */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4329;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --mode mock`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

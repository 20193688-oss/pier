/* Playwright: the main flows in a real browser, against the dev server in mock mode (the in-browser
   mock API and the demo wallet), at a phone and a desktop width. Port 4329 so a running
   `npm run dev` on 4321 is never reused by mistake. */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4329;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
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

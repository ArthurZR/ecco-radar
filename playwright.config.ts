import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8790);

/**
 * End-to-end tests run the real API and the built web app against a disposable PostgreSQL database
 * seeded with SYNTHETIC references (see server/scripts/e2e-server.ts). Run `npm run build` first.
 * The tests share one seeded database, so they run in order in a single worker.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: 'npm run e2e:server -w server',
    url: `http://localhost:${port}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});

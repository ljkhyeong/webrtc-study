import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'output/playwright/baton-entry-results',
  forbidOnly: isCi,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['line']],
  testMatch: /baton-entry\.spec\.ts/,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -w @round/web',
    env: {
      ROUND_E2E_MODE: 'true',
      VITE_ROUND_AUTH_MODE: 'baton',
      VITE_SIGNALING_URL: '',
      VITE_STUN_URLS: '',
      VITE_TURN_CREDENTIALS_URL: '',
    },
    reuseExistingServer: process.env.ROUND_E2E_REUSE_SERVER === 'true',
    timeout: 120_000,
    url: 'http://127.0.0.1:5173/round-ui/',
  },
});

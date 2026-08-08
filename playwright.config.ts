import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'output/playwright/test-results',
  fullyParallel: false,
  forbidOnly: isCi,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'output/playwright/report' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-full-media',
      testMatch: /standalone-room\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        },
      },
    },
    {
      name: 'webkit-smoke',
      testMatch: /webkit-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    env: {
      PORT: '8787',
      ROUND_AUTH_MODE: 'standalone',
      ROUND_STANDALONE_HOST_TOKEN_SHA256:
        'de7ca4487720742a8acf93c4bd14b590f2753d370b5c2f13cc0cc09590e183ef',
      ROUND_E2E_MODE: 'true',
      TURN_SHARED_SECRET: '',
      TURN_URLS: '',
      VITE_ROUND_AUTH_MODE: 'standalone',
      VITE_SIGNALING_URL: '',
      VITE_STUN_URLS: '',
      VITE_TURN_CREDENTIALS_URL: '',
    },
    reuseExistingServer: process.env.ROUND_E2E_REUSE_SERVER === 'true',
    timeout: 120_000,
    url: 'http://127.0.0.1:5173/healthz',
  },
});

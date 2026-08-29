import { defineConfig } from '@playwright/test';
import { roundE2eWebServer } from './playwright.config';

export default defineConfig({
  testDir: './e2e',
  testMatch: /mobile-layout\.spec\.ts/,
  outputDir: 'output/playwright/browserstack-ios-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  webServer: roundE2eWebServer,
});

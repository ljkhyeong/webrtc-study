// round-e2e 스킬 전용 BATON 입장 실행 설정. 저장소 설정을 상속하고 로컬 실행 조건만 바꾼다.
// ROUND_E2E_OUTPUT: output/playwright 아래 결과 폴더 이름(기본 baton-headless)
import { resolve } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';
import base from '../../../playwright.baton.config';

const root = resolve(__dirname, '../../..');
const webServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;

export default defineConfig({
  ...base,
  testDir: resolve(root, 'e2e'),
  outputDir: resolve(root, 'output/playwright', process.env.ROUND_E2E_OUTPUT ?? 'baton-headless'),
  webServer:
    webServer === undefined
      ? undefined
      : { ...webServer, cwd: root, env: { ...webServer.env, VITE_FARO_COLLECTOR_URL: '' } },
  use: {
    ...base.use,
    headless: true,
    launchOptions: {
      executablePath: chromium.executablePath(),
      args: ['--mute-audio'],
    },
  },
});

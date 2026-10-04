// round-e2e 스킬 전용 실행 설정. 저장소 설정을 그대로 상속하고 로컬 실행 조건만 바꾼다.
// ROUND_E2E_PROJECTS: 쉼표로 구분한 playwright.config.ts 프로젝트 이름(기본 chromium-full-media)
// ROUND_E2E_OUTPUT: output/playwright 아래 결과 폴더 이름(기본 headless)
// ROUND_E2E_BASE_URL: 이미 실행 중인 standalone 미리보기 서버 주소. 지정하면 서버를 새로 띄우지 않는다.
import { resolve } from 'node:path';
import { chromium, defineConfig, type Project } from '@playwright/test';
import base, { roundE2eWebServer } from '../../../playwright.config';

const root = resolve(__dirname, '../../..');
const externalBaseUrl = process.env.ROUND_E2E_BASE_URL?.trim();
const projectNames = (process.env.ROUND_E2E_PROJECTS ?? 'chromium-full-media')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

function runHeadless(project: Project): Project {
  const use = project.use ?? {};
  if ((use.defaultBrowserType ?? use.browserName) === 'webkit') {
    return { ...project, use: { ...use, headless: true } };
  }
  return {
    ...project,
    use: {
      ...use,
      headless: true,
      launchOptions: {
        ...use.launchOptions,
        executablePath: chromium.executablePath(),
        args: [...(use.launchOptions?.args ?? []), '--mute-audio'],
      },
    },
  };
}

const projects = projectNames.map((name) => {
  const project = base.projects?.find((candidate) => candidate.name === name);
  if (project === undefined) {
    throw new Error(`playwright.config.ts에 없는 프로젝트입니다: ${name}`);
  }
  return runHeadless(project);
});

export default defineConfig({
  ...base,
  testDir: resolve(root, 'e2e'),
  outputDir: resolve(root, 'output/playwright', process.env.ROUND_E2E_OUTPUT ?? 'headless'),
  reporter: [['line']],
  use: externalBaseUrl ? { ...base.use, baseURL: externalBaseUrl } : base.use,
  webServer: externalBaseUrl
    ? undefined
    : {
        ...roundE2eWebServer,
        cwd: root,
        env: { ...roundE2eWebServer.env, VITE_FARO_COLLECTOR_URL: '' },
      },
  projects,
});

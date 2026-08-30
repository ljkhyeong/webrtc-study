import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkflowContract, parseWorkflow } from './workflow-contract.mjs';

const workflowPath = new URL('../../.github/workflows/browserstack-ios.yml', import.meta.url);

function fail(message) {
  throw new Error('BrowserStack workflow 검증: ' + message);
}

const { exactKeys } = createWorkflowContract(fail);
const workflow = parseWorkflow(workflowPath, fail);
assert.deepEqual(exactKeys(workflow.on, ['workflow_dispatch'], 'on'), {
  workflow_dispatch: null,
});
assert.deepEqual(exactKeys(workflow.permissions, ['contents'], 'permissions'), {
  contents: 'read',
});

const job = workflow.jobs?.['ios-safari'];
assert.ok(job, 'ios-safari job이 필요합니다.');
assert.equal(job.env, undefined, 'BrowserStack secret을 job 전체에 전달하면 안 됩니다.');

const credentialStep = job.steps?.find((step) => step.name === 'BrowserStack 자격 증명 확인');
const executionStep = job.steps?.find(
  (step) => step.name === '실제 iOS Safari 화면 및 입장 흐름 검사',
);
assert.ok(credentialStep, 'BrowserStack 자격 증명 확인 step이 필요합니다.');
assert.ok(executionStep, 'BrowserStack 실제 실행 step이 필요합니다.');

const expectedSecretEnv = {
  BROWSERSTACK_USERNAME: '${{ secrets.BROWSERSTACK_USERNAME }}',
  BROWSERSTACK_ACCESS_KEY: '${{ secrets.BROWSERSTACK_ACCESS_KEY }}',
};
assert.deepEqual(credentialStep.env, expectedSecretEnv);
assert.deepEqual(executionStep.env, expectedSecretEnv);
assert.match(
  credentialStep.run,
  /exit 1/,
  '자격 증명이 없으면 workflow가 성공하지 말고 실패해야 합니다.',
);
assert.equal(
  job.steps.some((step) => step.if !== undefined),
  false,
  '자격 증명 누락을 이유로 실제 검사 step을 건너뛰면 안 됩니다.',
);

for (const step of job.steps) {
  if (step === credentialStep || step === executionStep) {
    continue;
  }
  assert.equal(
    JSON.stringify(step).includes('BROWSERSTACK_'),
    false,
    'BrowserStack secret은 확인과 실제 실행 step 밖에 전달하면 안 됩니다.',
  );
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
assert.equal(
  packageJson.scripts?.['test:e2e:ios-safari'],
  'npx --yes browserstack-node-sdk@1.68.0 playwright test --config playwright.browserstack.config.ts',
);

console.log('BrowserStack 최소 권한과 SDK 버전 고정 검사를 통과했습니다.');

import assert from 'node:assert/strict';
import { createWorkflowContract, parseWorkflow } from './workflow-contract.mjs';

const workflowPath = new URL('../../.github/workflows/release-images.yml', import.meta.url);
const attestationAction = 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d';
const expectedSubjects = new Map([
  ['${{ env.IMAGE_NAMESPACE }}/round-edge\0${{ steps.edge.outputs.digest }}', 'build-edge'],
  ['${{ env.IMAGE_NAMESPACE }}/round-edge\0${{ steps.edge-relay.outputs.digest }}', 'build-edge'],
  [
    '${{ env.IMAGE_NAMESPACE }}/round-baton-web\0${{ steps.baton-web.outputs.digest }}',
    'build-edge',
  ],
  [
    '${{ env.IMAGE_NAMESPACE }}/round-signaling\0${{ steps.image.outputs.digest }}',
    'build-signaling',
  ],
]);

function fail(message) {
  throw new Error(`릴리스 workflow 검증: ${message}`);
}

const { exactKeys } = createWorkflowContract(fail);
const workflow = parseWorkflow(workflowPath, fail);
assert.deepEqual(exactKeys(workflow.on, ['repository_dispatch'], 'on'), {
  repository_dispatch: { types: ['release-images'] },
});
assert.deepEqual(exactKeys(workflow.permissions, ['contents'], 'permissions'), {
  contents: 'read',
});

const preflight = workflow.jobs?.preflight;
assert.ok(preflight, 'preflight job이 필요합니다.');
assert.deepEqual(
  exactKeys(preflight.permissions, ['actions', 'contents', 'packages'], 'preflight.permissions'),
  {
    actions: 'read',
    contents: 'read',
    packages: 'read',
  },
);
assert.deepEqual(
  exactKeys(
    preflight.outputs,
    ['release_sha', 'release_tag', 'stun_urls', 'tag_object'],
    'preflight.outputs',
  ),
  {
    release_sha: '${{ steps.release-inputs.outputs.release_sha }}',
    release_tag: '${{ steps.release-inputs.outputs.release_tag }}',
    stun_urls: '${{ steps.release-inputs.outputs.stun_urls }}',
    tag_object: '${{ steps.release-inputs.outputs.tag_object }}',
  },
);

const serializedWorkflow = JSON.stringify(workflow);
assert.equal(
  (serializedWorkflow.match(/bash ops\/ci\/assert-image-tags-absent\.sh/g) ?? []).length,
  2,
  '최종 태그 미사용 검사는 공통 스크립트를 두 단계에서 실행해야 합니다.',
);
if (serializedWorkflow.includes('github.ref_name')) {
  fail('repository_dispatch가 제공하지 않는 github.ref_name을 사용하면 안 됩니다.');
}
if (!serializedWorkflow.includes('github.event.client_payload.release_tag')) {
  fail('repository_dispatch의 릴리스 태그 payload가 빠졌습니다.');
}
const releaseInputs = preflight.steps?.find((step) => step.id === 'release-inputs');
assert.equal(typeof releaseInputs?.run, 'string', '릴리스 입력 검증 단계가 필요합니다.');
for (const requiredText of [
  'refs/heads/${DEFAULT_BRANCH}',
  '"$tag_commit" != "$GITHUB_SHA"',
  'actions/workflows/ci.yml/runs',
  'head_sha=${tag_commit}',
  '.head_branch == $branch',
  '.head_sha == $sha',
  '.event == "push"',
  '.conclusion == "success"',
  '.path == ".github/workflows/ci.yml"',
]) {
  if (!releaseInputs.run.includes(requiredText)) {
    fail(`기본 브랜치와 CI workflow 검사가 빠졌습니다: ${requiredText}`);
  }
}
if (releaseInputs.run.includes('/jobs')) {
  fail('성공한 CI workflow 결론을 job 표시명으로 다시 검증하면 안 됩니다.');
}
assert.equal(workflow.jobs?.verify, undefined, '성공한 CI를 릴리스에서 다시 실행하면 안 됩니다.');

for (const jobName of ['build-edge', 'build-signaling', 'promote']) {
  const job = workflow.jobs?.[jobName];
  assert.ok(job, `${jobName} job이 필요합니다.`);
  if (jobName !== 'promote') {
    assert.equal(job.needs, 'preflight', `${jobName}은 preflight 결과만 이어받아야 합니다.`);
  }
  const checkout = job.steps?.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  );
  assert.equal(
    checkout?.with?.ref,
    '${{ needs.preflight.outputs.release_sha }}',
    `${jobName}은 검증된 릴리스 SHA를 checkout해야 합니다.`,
  );
}

for (const jobName of ['build-edge', 'build-signaling']) {
  const labels = (workflow.jobs[jobName].steps ?? [])
    .filter((step) => String(step.uses ?? '').startsWith('docker/build-push-action@'))
    .map((step) => step.with?.labels ?? '')
    .join('\n');
  assert.match(
    labels,
    /org\.opencontainers\.image\.version=\$\{\{ needs\.preflight\.outputs\.release_tag \}\}/,
    `${jobName}의 version label이 검증된 태그와 다릅니다.`,
  );
}

const foundSubjects = new Map();
for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
  const attestationSteps = (job.steps ?? []).filter((step) =>
    String(step.uses ?? '').startsWith('actions/attest@'),
  );
  if (attestationSteps.length === 0) {
    continue;
  }

  if (job['runs-on'] !== 'ubuntu-latest') {
    fail(`${jobName}은 GitHub-hosted ubuntu-latest runner를 사용해야 합니다.`);
  }

  const permissions = exactKeys(
    job.permissions,
    ['attestations', 'contents', 'id-token', 'packages'],
    `${jobName}.permissions`,
  );

  for (const [permission, expected] of [
    ['contents', 'read'],
    ['packages', 'write'],
    ['attestations', 'write'],
    ['id-token', 'write'],
  ]) {
    if (permissions[permission] !== expected) {
      fail(`${jobName}은 ${permission}: ${expected} 권한만 부여해야 합니다.`);
    }
  }

  for (const step of attestationSteps) {
    if (step.uses !== attestationAction) {
      fail(`${jobName}은 ${attestationAction}을 고정해야 합니다.`);
    }
    if (step.with?.['push-to-registry'] !== true) {
      fail(`${jobName}은 각 출처 증명을 registry에 게시해야 합니다.`);
    }
    if (step.with?.['create-storage-record'] !== false) {
      fail(`${jobName}은 지원되지 않는 개인 storage record를 요청하면 안 됩니다.`);
    }
    const subjectKey = `${step.with?.['subject-name']}\0${step.with?.['subject-digest']}`;
    if (foundSubjects.has(subjectKey)) {
      fail(`${jobName}에 중복된 출처 증명 대상이 있습니다.`);
    }
    foundSubjects.set(subjectKey, jobName);
  }
}

if (foundSubjects.size !== expectedSubjects.size) {
  fail(`출처 증명 ${expectedSubjects.size}개가 필요하지만 ${foundSubjects.size}개를 찾았습니다.`);
}
for (const [subjectKey, expectedJob] of expectedSubjects) {
  if (foundSubjects.get(subjectKey) !== expectedJob) {
    fail(`${expectedJob}의 서명 대상이 빠졌습니다.`);
  }
}

console.log('릴리스 workflow와 출처 증명 계약 검사를 통과했습니다.');

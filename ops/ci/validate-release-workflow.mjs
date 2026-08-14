import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const workflowPath = new URL('../../.github/workflows/release-images.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));
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
  ['${{ env.IMAGE_NAMESPACE }}/round-turn\0${{ steps.image.outputs.digest }}', 'build-turn'],
]);

function fail(message) {
  throw new Error(`release workflow validation: ${message}`);
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
    fail(`${jobName} must use the GitHub-hosted ubuntu-latest runner`);
  }

  for (const [permission, expected] of [
    ['contents', 'read'],
    ['packages', 'write'],
    ['attestations', 'write'],
    ['id-token', 'write'],
  ]) {
    if (job.permissions?.[permission] !== expected) {
      fail(`${jobName} must grant ${permission}: ${expected}`);
    }
  }

  for (const step of attestationSteps) {
    if (step.uses !== attestationAction) {
      fail(`${jobName} must pin ${attestationAction}`);
    }
    if (step.with?.['push-to-registry'] !== true) {
      fail(`${jobName} must push each attestation to the registry`);
    }
    if (step.with?.['create-storage-record'] !== false) {
      fail(`${jobName} must not request an unsupported personal storage record`);
    }
    const subjectKey = `${step.with?.['subject-name']}\0${step.with?.['subject-digest']}`;
    if (foundSubjects.has(subjectKey)) {
      fail(`duplicate attestation subject in ${jobName}`);
    }
    foundSubjects.set(subjectKey, jobName);
  }
}

if (foundSubjects.size !== expectedSubjects.size) {
  fail(`expected ${expectedSubjects.size} attestations, found ${foundSubjects.size}`);
}
for (const [subjectKey, expectedJob] of expectedSubjects) {
  if (foundSubjects.get(subjectKey) !== expectedJob) {
    fail(`missing signed subject in ${expectedJob}`);
  }
}

console.log('Release workflow attestation contract is valid.');

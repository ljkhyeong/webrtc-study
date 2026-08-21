#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const workflowUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('.github/workflows/external-turn-probe.yml', repoRoot);
const checkoutAction = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';

function fail(message) {
  throw new Error(`외부 TURN workflow 검증: ${message}`);
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a mapping`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const record = requireRecord(value, label);
  assert.deepEqual(
    Object.keys(record).sort(),
    [...expected].sort(),
    `${label} has an unexpected key`,
  );
  return record;
}

function requireExactStructuralKeys(value, expected, label) {
  const record = requireRecord(value, label);
  const keys = Object.keys(record).filter((key) => key !== 'name' && key !== 'description');
  assert.deepEqual(keys.sort(), [...expected].sort(), `${label} has an unexpected key`);
  return record;
}

function requireSteps(job, expectedCount, label) {
  if (!Array.isArray(job.steps)) {
    fail(`${label}.steps must be a sequence`);
  }
  assert.equal(job.steps.length, expectedCount, `${label} step count changed`);
  return job.steps.map((step, index) => requireRecord(step, `${label} step ${index + 1}`));
}

function collectSecretAccesses(value, path = '', accesses = []) {
  if (typeof value === 'string') {
    if (/\bsecrets\b/.test(value)) {
      accesses.push({ path, value });
    }
    return accesses;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSecretAccesses(item, `${path}[${index}]`, accesses));
    return accesses;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectSecretAccesses(item, path === '' ? key : `${path}.${key}`, accesses);
    }
  }
  return accesses;
}

function requireCheckout(step, expectedWith, label) {
  requireExactStructuralKeys(step, ['uses', 'with'], label);
  assert.equal(step.uses, checkoutAction, `${label} action changed`);
  const withOptions = requireExactKeys(step.with, Object.keys(expectedWith), `${label}.with`);
  assert.deepEqual(withOptions, expectedWith, `${label}.with changed`);
}

function requireRunStep(step, expectedKeys, expectedRun, label) {
  requireExactStructuralKeys(step, expectedKeys, label);
  assert.equal(step.shell, 'bash', `${label} shell changed`);
  assert.equal(step.run.trim(), expectedRun, `${label} command changed`);
}

const workflowSource = readFileSync(workflowUrl, 'utf8');
const document = parseDocument(workflowSource, {
  prettyErrors: true,
  schema: 'core',
  uniqueKeys: true,
});
if (document.errors.length > 0) {
  fail(document.errors.map((error) => error.message).join('; '));
}

const workflow = requireExactStructuralKeys(
  document.toJS({ maxAliasCount: 0 }),
  ['concurrency', 'jobs', 'on', 'permissions'],
  fileURLToPath(workflowUrl),
);
const triggers = requireExactKeys(workflow.on, ['workflow_dispatch'], 'on');
const dispatch = requireExactKeys(triggers.workflow_dispatch, ['inputs'], 'workflow_dispatch');
const inputs = requireExactKeys(dispatch.inputs, ['release_tag'], 'workflow_dispatch.inputs');
const releaseTagInput = requireExactStructuralKeys(
  inputs.release_tag,
  ['required', 'type'],
  'release_tag input',
);
assert.equal(releaseTagInput.required, true);
assert.equal(releaseTagInput.type, 'string');
requireExactKeys(workflow.permissions, [], 'top-level permissions');
assert.deepEqual(
  requireExactKeys(workflow.concurrency, ['cancel-in-progress', 'group'], 'concurrency'),
  {
    group: 'external-turn-pilot-${{ github.repository }}',
    'cancel-in-progress': false,
  },
);

const jobs = requireExactKeys(workflow.jobs, ['probe', 'release'], 'jobs');
const release = requireExactStructuralKeys(
  jobs.release,
  ['outputs', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
  'release job',
);
const probe = requireExactStructuralKeys(
  jobs.probe,
  ['environment', 'if', 'needs', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
  'probe job',
);

assert.equal(release['runs-on'], 'ubuntu-latest');
assert.equal(release['timeout-minutes'], 5);
assert.deepEqual(requireExactKeys(release.permissions, ['contents'], 'release permissions'), {
  contents: 'read',
});
assert.equal(probe.needs, 'release');
assert.equal(
  probe.if,
  "${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
);
assert.equal(probe['runs-on'], 'ubuntu-latest');
assert.equal(probe['timeout-minutes'], 10);
assert.equal(probe.environment, 'round-pilot');
assert.deepEqual(requireExactKeys(probe.permissions, ['contents'], 'probe permissions'), {
  contents: 'read',
});
if (/\bvars(?:\.|\[)/.test(JSON.stringify(workflow))) {
  fail('public probe destinations must come from the reviewed target file');
}

const releaseOutputs = requireExactKeys(
  release.outputs,
  ['probe_image', 'release_sha', 'round_url', 'tag_object_sha', 'turn_host'],
  'release outputs',
);
assert.deepEqual(releaseOutputs, {
  release_sha: '${{ steps.release.outputs.release_sha }}',
  tag_object_sha: '${{ steps.release.outputs.tag_object_sha }}',
  round_url: '${{ steps.target.outputs.round_url }}',
  turn_host: '${{ steps.target.outputs.turn_host }}',
  probe_image: '${{ steps.target.outputs.probe_image }}',
});

const releaseSteps = requireSteps(release, 4, 'release job');
const [branchStep, releaseCheckout, targetStep, releaseStep] = releaseSteps;
requireRunStep(
  branchStep,
  ['env', 'run', 'shell'],
  [
    'set -euo pipefail',
    'if [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]]; then',
    "  printf '외부 TURN probe는 default branch에서 dispatch해야 합니다.\\n' >&2",
    '  exit 1',
    'fi',
  ].join('\n'),
  'default-branch step',
);
assert.deepEqual(requireExactKeys(branchStep.env, ['DEFAULT_BRANCH'], 'default-branch env'), {
  DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
});
requireCheckout(
  releaseCheckout,
  {
    'fetch-depth': 0,
    'fetch-tags': true,
    'persist-credentials': false,
  },
  'release checkout',
);

requireRunStep(
  targetStep,
  ['id', 'run', 'shell'],
  'bash ops/turn/resolve-external-pilot-target.sh ops/turn/external-pilot-target.properties >>"$GITHUB_OUTPUT"',
  'target step',
);
assert.equal(targetStep.id, 'target');

requireRunStep(
  releaseStep,
  ['env', 'id', 'run', 'shell'],
  'bash ops/turn/resolve-external-release.sh "$RELEASE_TAG" >>"$GITHUB_OUTPUT"',
  'release reference step',
);
assert.equal(releaseStep.id, 'release');
assert.deepEqual(requireExactKeys(releaseStep.env, ['RELEASE_TAG'], 'release reference env'), {
  RELEASE_TAG: '${{ inputs.release_tag }}',
});

const probeSteps = requireSteps(probe, 4, 'probe job');
const [probeCheckout, caStep, relayStep, summaryStep] = probeSteps;
requireCheckout(probeCheckout, { 'persist-credentials': false }, 'probe checkout');

requireRunStep(
  caStep,
  ['env', 'run', 'shell'],
  [
    'set -euo pipefail',
    'if [[ -z "$TURN_PROBE_CA_PEM" ]]; then',
    '  exit 0',
    'fi',
    'ca_file="$RUNNER_TEMP/round-turn-probe-ca.pem"',
    'umask 077',
    'printf \'%s\\n\' "$TURN_PROBE_CA_PEM" >"$ca_file"',
    'chmod 0600 "$ca_file"',
    'printf \'TURN_PROBE_CA_FILE=%s\\n\' "$ca_file" >>"$GITHUB_ENV"',
  ].join('\n'),
  'private CA step',
);
assert.deepEqual(requireExactKeys(caStep.env, ['TURN_PROBE_CA_PEM'], 'private CA env'), {
  TURN_PROBE_CA_PEM: '${{ secrets.TURN_PROBE_CA_PEM }}',
});

requireRunStep(relayStep, ['env', 'run', 'shell'], 'bash ops/turn/probe.sh', 'relay step');
assert.deepEqual(
  requireExactKeys(
    relayStep.env,
    [
      'ROUND_ACCESS_PASSWORD',
      'ROUND_ACCESS_USER',
      'ROUND_URL',
      'TURN_PROBE_HOST',
      'TURN_PROBE_IMAGE',
      'TURN_PROBE_TRANSPORTS',
    ],
    'relay env',
  ),
  {
    ROUND_URL: '${{ needs.release.outputs.round_url }}',
    ROUND_ACCESS_USER: '${{ secrets.ROUND_ACCESS_USER }}',
    ROUND_ACCESS_PASSWORD: '${{ secrets.ROUND_ACCESS_PASSWORD }}',
    TURN_PROBE_HOST: '${{ needs.release.outputs.turn_host }}',
    TURN_PROBE_IMAGE: '${{ needs.release.outputs.probe_image }}',
    TURN_PROBE_TRANSPORTS: 'udp,tcp,tls',
  },
);
requireRunStep(
  summaryStep,
  ['env', 'run', 'shell'],
  [
    '{',
    "  printf '### 외부 TURN 파일럿 probe\\n\\n'",
    '  printf -- \'- 운영자 선언 release: `%s` (`%s`)\\n\' "$RELEASE_TAG" "$RELEASE_SHA"',
    '  printf -- \'- Tag object: `%s`\\n\' "$TAG_OBJECT_SHA"',
    '  printf -- \'- Workflow commit: `%s`\\n\' "$WORKFLOW_SHA"',
    '  printf -- \'- 대상: `%s` / `%s`\\n\' "$ROUND_URL" "$TURN_PROBE_HOST"',
    '  printf -- \'- Probe 이미지: `%s`\\n\' "$TURN_PROBE_IMAGE"',
    "  printf -- '- 전송 방식: 인증된 UDP, TCP 및 TLS relay\\n'",
    "  printf -- '- 결과: GitHub-hosted 외부 runner에서 통과\\n'",
    "  printf -- '- 범위: deployment identity를 자동 검증하지 않음\\n'",
    '} >>"$GITHUB_STEP_SUMMARY"',
  ].join('\n'),
  'summary step',
);
assert.deepEqual(
  requireExactKeys(
    summaryStep.env,
    [
      'RELEASE_SHA',
      'RELEASE_TAG',
      'ROUND_URL',
      'TAG_OBJECT_SHA',
      'TURN_PROBE_HOST',
      'TURN_PROBE_IMAGE',
      'WORKFLOW_SHA',
    ],
    'summary env',
  ),
  {
    RELEASE_SHA: '${{ needs.release.outputs.release_sha }}',
    RELEASE_TAG: '${{ inputs.release_tag }}',
    ROUND_URL: '${{ needs.release.outputs.round_url }}',
    TAG_OBJECT_SHA: '${{ needs.release.outputs.tag_object_sha }}',
    TURN_PROBE_HOST: '${{ needs.release.outputs.turn_host }}',
    TURN_PROBE_IMAGE: '${{ needs.release.outputs.probe_image }}',
    WORKFLOW_SHA: '${{ github.sha }}',
  },
);
assert.deepEqual(collectSecretAccesses(workflow), [
  {
    path: 'jobs.probe.steps[1].env.TURN_PROBE_CA_PEM',
    value: '${{ secrets.TURN_PROBE_CA_PEM }}',
  },
  {
    path: 'jobs.probe.steps[2].env.ROUND_ACCESS_USER',
    value: '${{ secrets.ROUND_ACCESS_USER }}',
  },
  {
    path: 'jobs.probe.steps[2].env.ROUND_ACCESS_PASSWORD',
    value: '${{ secrets.ROUND_ACCESS_PASSWORD }}',
  },
]);
process.stdout.write('외부 TURN workflow 계약 검사를 통과했습니다.\n');

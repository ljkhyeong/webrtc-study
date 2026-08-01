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
const targetUrl = process.argv[3]
  ? pathToFileURL(resolve(process.argv[3]))
  : new URL('ops/turn/external-pilot-target.properties', repoRoot);
const checkoutAction = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';

function fail(message) {
  throw new Error(`external TURN workflow validation: ${message}`);
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

function requireSteps(job, expectedNames, label) {
  if (!Array.isArray(job.steps)) {
    fail(`${label}.steps must be a sequence`);
  }
  assert.deepEqual(
    job.steps.map((step) => requireRecord(step, `${label} step`).name),
    expectedNames,
    `${label} step order changed`,
  );
  return job.steps;
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

function requireNoSecretAccess(value, label) {
  assert.deepEqual(
    collectSecretAccesses(value),
    [],
    `${label} must not access the secrets context`,
  );
}

function requireExactSecretAccesses(value, expected, label) {
  assert.deepEqual(collectSecretAccesses(value), expected, `${label} secret access changed`);
}

function requireCheckout(step, expectedWith, label) {
  requireExactKeys(step, ['name', 'uses', 'with'], label);
  assert.equal(step.uses, checkoutAction, `${label} action changed`);
  const withOptions = requireExactKeys(step.with, Object.keys(expectedWith), `${label}.with`);
  assert.deepEqual(withOptions, expectedWith, `${label}.with changed`);
  requireNoSecretAccess(step, label);
}

function requireRunStep(step, expectedKeys, expectedRun, label) {
  requireExactKeys(step, expectedKeys, label);
  assert.equal(step.shell, 'bash', `${label} shell changed`);
  assert.equal(step.run.trim(), expectedRun, `${label} command changed`);
}

function parseTarget(source) {
  const values = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    if (rawLine === '' || rawLine.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(\S+)$/.exec(rawLine);
    if (match === null) {
      fail(`invalid target line ${index + 1}`);
    }
    const [, key, value] = match;
    if (values.has(key)) {
      fail(`duplicate target key ${key}`);
    }
    values.set(key, value);
  }

  assert.deepEqual(
    [...values.keys()].sort(),
    ['ROUND_URL', 'TURN_PROBE_HOST', 'TURN_PROBE_IMAGE'],
    'pilot target must contain exactly the public probe keys',
  );
  assert.match(
    values.get('ROUND_URL'),
    /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/,
    'ROUND_URL must be an exact HTTPS origin',
  );
  assert.match(
    values.get('TURN_PROBE_HOST'),
    /^(?!-)[A-Za-z0-9.-]+$/,
    'TURN_PROBE_HOST must be a plain host',
  );
  assert.match(
    values.get('TURN_PROBE_IMAGE'),
    /^coturn\/coturn@sha256:[0-9a-f]{64}$/,
    'TURN_PROBE_IMAGE must pin the reviewed coturn/coturn repository by digest',
  );
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

const workflow = requireExactKeys(
  document.toJS({ maxAliasCount: 0 }),
  ['concurrency', 'jobs', 'name', 'on', 'permissions'],
  fileURLToPath(workflowUrl),
);
assert.equal(workflow.name, 'External TURN pilot probe');

const triggers = requireExactKeys(workflow.on, ['workflow_dispatch'], 'on');
const dispatch = requireExactKeys(triggers.workflow_dispatch, ['inputs'], 'workflow_dispatch');
const inputs = requireExactKeys(dispatch.inputs, ['release_tag'], 'workflow_dispatch.inputs');
const releaseTagInput = requireExactKeys(
  inputs.release_tag,
  ['description', 'required', 'type'],
  'release_tag input',
);
assert.deepEqual(releaseTagInput, {
  description: 'Operator-declared annotated ROUND release tag',
  required: true,
  type: 'string',
});
requireExactKeys(workflow.permissions, [], 'top-level permissions');
assert.deepEqual(
  requireExactKeys(workflow.concurrency, ['cancel-in-progress', 'group'], 'concurrency'),
  {
    group: 'external-turn-pilot-${{ github.repository }}',
    'cancel-in-progress': false,
  },
);

const jobs = requireExactKeys(workflow.jobs, ['probe', 'release'], 'jobs');
const release = requireExactKeys(
  jobs.release,
  ['name', 'outputs', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
  'release job',
);
const probe = requireExactKeys(
  jobs.probe,
  ['environment', 'if', 'name', 'needs', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
  'probe job',
);

assert.equal(release.name, 'Validate release reference and reviewed target');
assert.equal(release['runs-on'], 'ubuntu-latest');
assert.equal(release['timeout-minutes'], 5);
assert.deepEqual(requireExactKeys(release.permissions, ['contents'], 'release permissions'), {
  contents: 'read',
});
requireNoSecretAccess(release, 'release job');

assert.equal(probe.name, 'Authenticate UDP, TCP, and TLS relay traffic');
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

const releaseSteps = requireSteps(
  release,
  [
    'Require a default-branch dispatch',
    'Check out repository and tags',
    'Resolve code-reviewed pilot target',
    'Resolve the declared release reference',
  ],
  'release job',
);
const [branchStep, releaseCheckout, targetStep, releaseStep] = releaseSteps;
requireRunStep(
  branchStep,
  ['env', 'name', 'run', 'shell'],
  [
    'set -euo pipefail',
    'if [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]]; then',
    "  printf 'External TURN probes must be dispatched from the default branch.\\n' >&2",
    '  exit 1',
    'fi',
  ].join('\n'),
  'default-branch step',
);
assert.deepEqual(requireExactKeys(branchStep.env, ['DEFAULT_BRANCH'], 'default-branch env'), {
  DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
});
requireNoSecretAccess(branchStep, 'default-branch step');

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
  ['id', 'name', 'run', 'shell'],
  'bash ops/turn/resolve-external-pilot-target.sh ops/turn/external-pilot-target.properties >>"$GITHUB_OUTPUT"',
  'target step',
);
assert.equal(targetStep.id, 'target');
requireNoSecretAccess(targetStep, 'target step');

requireRunStep(
  releaseStep,
  ['env', 'id', 'name', 'run', 'shell'],
  'bash ops/turn/resolve-external-release.sh "$RELEASE_TAG" >>"$GITHUB_OUTPUT"',
  'release reference step',
);
assert.equal(releaseStep.id, 'release');
assert.deepEqual(requireExactKeys(releaseStep.env, ['RELEASE_TAG'], 'release reference env'), {
  RELEASE_TAG: '${{ inputs.release_tag }}',
});
requireNoSecretAccess(releaseStep, 'release reference step');

const probeSteps = requireSteps(
  probe,
  [
    'Check out trusted probe implementation',
    'Prepare optional private TURN CA',
    'Probe every public TURN transport',
    'Record pilot evidence',
  ],
  'probe job',
);
const [probeCheckout, caStep, relayStep, summaryStep] = probeSteps;
requireCheckout(probeCheckout, { 'persist-credentials': false }, 'probe checkout');

requireRunStep(
  caStep,
  ['env', 'name', 'run', 'shell'],
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
requireExactSecretAccesses(
  caStep,
  [
    {
      path: 'env.TURN_PROBE_CA_PEM',
      value: '${{ secrets.TURN_PROBE_CA_PEM }}',
    },
  ],
  'private CA step',
);

requireRunStep(relayStep, ['env', 'name', 'run', 'shell'], 'bash ops/turn/probe.sh', 'relay step');
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
requireExactSecretAccesses(
  relayStep,
  [
    {
      path: 'env.ROUND_ACCESS_USER',
      value: '${{ secrets.ROUND_ACCESS_USER }}',
    },
    {
      path: 'env.ROUND_ACCESS_PASSWORD',
      value: '${{ secrets.ROUND_ACCESS_PASSWORD }}',
    },
  ],
  'relay step',
);

requireRunStep(
  summaryStep,
  ['env', 'name', 'run', 'shell'],
  [
    '{',
    "  printf '### External TURN pilot probe\\n\\n'",
    '  printf -- \'- Operator-declared release: `%s` (`%s`)\\n\' "$RELEASE_TAG" "$RELEASE_SHA"',
    '  printf -- \'- Tag object: `%s`\\n\' "$TAG_OBJECT_SHA"',
    '  printf -- \'- Workflow commit: `%s`\\n\' "$WORKFLOW_SHA"',
    '  printf -- \'- Target: `%s` / `%s`\\n\' "$ROUND_URL" "$TURN_PROBE_HOST"',
    '  printf -- \'- Probe image: `%s`\\n\' "$TURN_PROBE_IMAGE"',
    "  printf -- '- Transports: authenticated UDP, TCP, and TLS relay\\n'",
    "  printf -- '- Result: passed from GitHub-hosted external runner\\n'",
    "  printf -- '- Scope: deployment identity was not verified automatically\\n'",
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
requireNoSecretAccess(summaryStep, 'summary step');

const probeWithoutSteps = { ...probe };
delete probeWithoutSteps.steps;
requireNoSecretAccess(probeWithoutSteps, 'probe job configuration');

parseTarget(readFileSync(targetUrl, 'utf8'));
process.stdout.write('External TURN workflow contract checks passed.\n');

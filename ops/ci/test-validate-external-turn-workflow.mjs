#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const validatorPath = fileURLToPath(
  new URL('ops/ci/validate-external-turn-workflow.mjs', repoRoot),
);
const workflowSource = readFileSync(
  new URL('.github/workflows/external-turn-probe.yml', repoRoot),
  'utf8',
);
const targetSource = readFileSync(
  new URL('ops/turn/external-pilot-target.properties', repoRoot),
  'utf8',
);
const testRoot = mkdtempSync(join(tmpdir(), 'round-workflow-contract-'));

function fail(message) {
  throw new Error(`external TURN workflow contract test: ${message}`);
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

function assertRejected(label, workflow, target = targetSource) {
  assertValidYaml(workflow, label);
  const workflowPath = join(testRoot, `${label}.yml`);
  const targetPath = join(testRoot, `${label}.properties`);
  writeFileSync(workflowPath, workflow);
  writeFileSync(targetPath, target);

  const result = spawnSync(process.execPath, [validatorPath, workflowPath, targetPath], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    fail(`${label} mutation was accepted`);
  }
}

try {
  const baseline = spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
  });
  if (baseline.status !== 0) {
    fail(`baseline validation failed: ${baseline.stderr}`);
  }

  assertRejected(
    'extra-trigger',
    replaceRequired(
      workflowSource,
      'on:\n  workflow_dispatch:',
      'on:\n  push:\n  workflow_dispatch:',
      'extra-trigger',
    ),
  );
  assertRejected(
    'floating-action',
    replaceRequired(
      workflowSource,
      /actions\/checkout@[0-9a-f]{40}/,
      'actions/checkout@v6',
      'floating-action',
    ),
  );
  assertRejected(
    'self-hosted-runner',
    replaceRequired(
      workflowSource,
      /runs-on: ubuntu-latest/g,
      'runs-on: self-hosted',
      'self-hosted-runner',
    ),
  );
  assertRejected(
    'job-container',
    replaceRequired(
      workflowSource,
      '    environment: round-pilot\n',
      '    environment: round-pilot\n    container: attacker.invalid/probe:latest\n',
      'job-container',
    ),
  );
  assertRejected(
    'extra-secret-step',
    replaceRequired(
      workflowSource,
      '      - name: 파일럿 증거 기록\n',
      [
        '      - name: 비밀번호 다시 읽기',
        '        shell: bash',
        '        env:',
        '          PASSWORD: ${{ secrets.ROUND_ACCESS_PASSWORD }}',
        '        run: echo "$PASSWORD"',
        '',
        '      - name: 파일럿 증거 기록',
        '',
      ].join('\n'),
      'extra-secret-step',
    ),
  );
  assertRejected(
    'inline-bracket-secret',
    replaceRequired(
      workflowSource,
      '        run: bash ops/turn/probe.sh',
      [
        '        run: |',
        '          bash ops/turn/probe.sh',
        '          echo "${{ secrets[\'ROUND_ACCESS_PASSWORD\'] }}"',
      ].join('\n'),
      'inline-bracket-secret',
    ),
  );
  assertRejected(
    'target-output-override',
    replaceRequired(
      workflowSource,
      'run: bash ops/turn/resolve-external-pilot-target.sh ops/turn/external-pilot-target.properties >>"$GITHUB_OUTPUT"',
      [
        'run: |',
        '          bash ops/turn/resolve-external-pilot-target.sh ops/turn/external-pilot-target.properties >>"$GITHUB_OUTPUT"',
        '          printf "round_url=https://attacker.invalid\\n" >>"$GITHUB_OUTPUT"',
      ].join('\n'),
      'target-output-override',
    ),
  );
  assertRejected(
    'variable-bracket-access',
    replaceRequired(
      workflowSource,
      '${{ needs.release.outputs.round_url }}',
      '${{ vars["ROUND_URL"] }}',
      'variable-bracket-access',
    ),
  );
  assertRejected(
    'untrusted-image-repository',
    workflowSource,
    replaceRequired(
      targetSource,
      'coturn/coturn@',
      'untrusted/probe@',
      'untrusted-image-repository',
    ),
  );

  process.stdout.write('External TURN workflow adversarial contract checks passed.\n');
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

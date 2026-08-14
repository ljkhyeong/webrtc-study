#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const workflowUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('.github/workflows/external-turn-monitor.yml', repoRoot);
const checkoutAction = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';

function fail(message) {
  throw new Error(`외부 TURN monitor 검증: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a mapping`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const result = record(value, label);
  assert.deepEqual(Object.keys(result).sort(), [...expected].sort(), `${label} keys changed`);
  return result;
}

function exactRun(step, expectedKeys, expectedRun, label) {
  exactKeys(step, expectedKeys, label);
  assert.equal(step.shell, 'bash', `${label} shell changed`);
  assert.equal(step.run.trim(), expectedRun, `${label} command changed`);
}

function secretAccesses(value, path = '', accesses = []) {
  if (typeof value === 'string') {
    if (/\bsecrets\b/.test(value)) {
      accesses.push({ path, value });
    }
    return accesses;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretAccesses(item, `${path}[${index}]`, accesses));
    return accesses;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      secretAccesses(item, path === '' ? key : `${path}.${key}`, accesses);
    }
  }
  return accesses;
}

const source = readFileSync(workflowUrl, 'utf8');
const document = parseDocument(source, {
  prettyErrors: true,
  schema: 'core',
  uniqueKeys: true,
});
if (document.errors.length > 0) {
  fail(document.errors.map((error) => error.message).join('; '));
}

const workflow = exactKeys(
  document.toJS({ maxAliasCount: 0 }),
  ['concurrency', 'jobs', 'name', 'on', 'permissions'],
  'workflow',
);
assert.equal(workflow.name, '외부 TURN 가용성 모니터');
exactKeys(workflow.permissions, [], 'top-level permissions');
assert.deepEqual(exactKeys(workflow.concurrency, ['cancel-in-progress', 'group'], 'concurrency'), {
  group: 'external-turn-monitor-${{ github.repository }}',
  'cancel-in-progress': false,
});

const triggers = exactKeys(workflow.on, ['schedule', 'workflow_dispatch'], 'on');
assert.deepEqual(triggers.schedule, [{ cron: '17 */6 * * *' }]);
exactKeys(triggers.workflow_dispatch, [], 'workflow_dispatch');

const jobs = exactKeys(workflow.jobs, ['probe'], 'jobs');
const probe = exactKeys(
  jobs.probe,
  ['environment', 'if', 'name', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
  'probe job',
);
assert.equal(probe.name, '공개 UDP, TCP 및 TLS relay 가용성 probe');
assert.equal(
  probe.if,
  "${{ vars.ROUND_EXTERNAL_TURN_MONITOR_ENABLED == 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
);
assert.equal(probe['runs-on'], 'ubuntu-latest');
assert.equal(probe['timeout-minutes'], 15);
assert.equal(probe.environment, 'round-monitor');
assert.deepEqual(exactKeys(probe.permissions, ['contents'], 'probe permissions'), {
  contents: 'read',
});

assert.ok(Array.isArray(probe.steps), 'probe steps must be a sequence');
assert.deepEqual(
  probe.steps.map((step) => record(step, 'probe step').name),
  [
    '신뢰하는 monitor 구현 checkout',
    'code review된 공개 대상 결정',
    '선택적인 비공개 TURN CA 준비',
    '알림 전 3회 연속 실패 확인',
    'monitor 범위 기록',
  ],
);
const [checkout, target, privateCa, relay, summary] = probe.steps;

assert.deepEqual(exactKeys(checkout, ['name', 'uses', 'with'], 'checkout'), {
  name: '신뢰하는 monitor 구현 checkout',
  uses: checkoutAction,
  with: { 'persist-credentials': false },
});
assert.deepEqual(exactKeys(target, ['id', 'name', 'run', 'shell'], 'target step'), {
  name: 'code review된 공개 대상 결정',
  id: 'target',
  shell: 'bash',
  run: 'bash ops/turn/resolve-external-pilot-target.sh ops/turn/external-pilot-target.properties >>"$GITHUB_OUTPUT"',
});

exactRun(
  privateCa,
  ['env', 'name', 'run', 'shell'],
  [
    'set -euo pipefail',
    'if [[ -z "$TURN_PROBE_CA_PEM" ]]; then',
    '  exit 0',
    'fi',
    'ca_file="$RUNNER_TEMP/round-turn-monitor-ca.pem"',
    'umask 077',
    'printf \'%s\\n\' "$TURN_PROBE_CA_PEM" >"$ca_file"',
    'chmod 0600 "$ca_file"',
    'printf \'TURN_PROBE_CA_FILE=%s\\n\' "$ca_file" >>"$GITHUB_ENV"',
  ].join('\n'),
  'private CA step',
);
assert.deepEqual(exactKeys(privateCa.env, ['TURN_PROBE_CA_PEM'], 'private CA env'), {
  TURN_PROBE_CA_PEM: '${{ secrets.TURN_PROBE_CA_PEM }}',
});

exactRun(
  relay,
  ['env', 'name', 'run', 'shell'],
  [
    'set -euo pipefail',
    'for attempt in 1 2 3; do',
    '  if bash ops/turn/probe.sh; then',
    '    printf \'외부 TURN monitor가 %s번째 시도에서 통과했습니다.\\n\' "$attempt"',
    '    exit 0',
    '  fi',
    '  if [[ "$attempt" -lt 3 ]]; then',
    '    delay_seconds=$((attempt * 20))',
    '    printf \'%s번째 시도 실패; %s초 후 재시도합니다.\\n\' "$attempt" "$delay_seconds" >&2',
    '    sleep "$delay_seconds"',
    '  fi',
    'done',
    "printf '외부 TURN monitor가 3회 연속 실패했습니다.\\n' >&2",
    'exit 1',
  ].join('\n'),
  'relay step',
);
assert.deepEqual(
  exactKeys(
    relay.env,
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
    ROUND_URL: '${{ steps.target.outputs.round_url }}',
    ROUND_ACCESS_USER: '${{ secrets.ROUND_ACCESS_USER }}',
    ROUND_ACCESS_PASSWORD: '${{ secrets.ROUND_ACCESS_PASSWORD }}',
    TURN_PROBE_HOST: '${{ steps.target.outputs.turn_host }}',
    TURN_PROBE_IMAGE: '${{ steps.target.outputs.probe_image }}',
    TURN_PROBE_TRANSPORTS: 'udp,tcp,tls',
  },
);
exactRun(
  summary,
  ['env', 'if', 'name', 'run', 'shell'],
  [
    '{',
    "  printf '### 외부 TURN 가용성 모니터\\n\\n'",
    '  printf -- \'- Workflow commit: `%s`\\n\' "$WORKFLOW_SHA"',
    '  printf -- \'- 대상: `%s` / `%s`\\n\' "$ROUND_URL" "$TURN_PROBE_HOST"',
    "  printf -- '- 전송 방식: 인증된 UDP, TCP 및 TLS relay\\n'",
    "  printf -- '- 알림 기준: 이번 실행에서 3회 연속 시도 실패\\n'",
    "  printf -- '- 범위: 가용성만 확인; 배포된 release identity는 검증하지 않음\\n'",
    '} >>"$GITHUB_STEP_SUMMARY"',
  ].join('\n'),
  'summary step',
);
assert.equal(summary.if, '${{ always() }}');
assert.deepEqual(
  exactKeys(summary.env, ['ROUND_URL', 'TURN_PROBE_HOST', 'WORKFLOW_SHA'], 'summary env'),
  {
    ROUND_URL: '${{ steps.target.outputs.round_url }}',
    TURN_PROBE_HOST: '${{ steps.target.outputs.turn_host }}',
    WORKFLOW_SHA: '${{ github.sha }}',
  },
);
assert.deepEqual(secretAccesses(workflow), [
  {
    path: 'jobs.probe.steps[2].env.TURN_PROBE_CA_PEM',
    value: '${{ secrets.TURN_PROBE_CA_PEM }}',
  },
  {
    path: 'jobs.probe.steps[3].env.ROUND_ACCESS_USER',
    value: '${{ secrets.ROUND_ACCESS_USER }}',
  },
  {
    path: 'jobs.probe.steps[3].env.ROUND_ACCESS_PASSWORD',
    value: '${{ secrets.ROUND_ACCESS_PASSWORD }}',
  },
]);

printf('외부 TURN monitor workflow 검증을 통과했습니다.\n');

function printf(message) {
  process.stdout.write(message);
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

export function parseWorkflow(workflowUrl, fail) {
  const document = parseDocument(readFileSync(workflowUrl, 'utf8'), {
    prettyErrors: true,
    schema: 'core',
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(document.errors.map((error) => error.message).join('; '));
  }
  return document.toJS({ maxAliasCount: 0 });
}

export function createWorkflowContract(fail) {
  function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label}: 매핑 형식이어야 합니다.`);
    }
    return value;
  }

  function exactKeys(value, expected, label) {
    const result = record(value, label);
    assert.deepEqual(
      Object.keys(result).sort(),
      [...expected].sort(),
      `${label}: 키 구성이 변경되었습니다.`,
    );
    return result;
  }

  return { exactKeys, record };
}

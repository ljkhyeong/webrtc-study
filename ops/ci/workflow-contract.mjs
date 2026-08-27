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

  function exactStructuralKeys(value, expected, label) {
    const result = record(value, label);
    const keys = Object.keys(result).filter((key) => key !== 'name' && key !== 'description');
    assert.deepEqual(keys.sort(), [...expected].sort(), `${label}: 키 구성이 변경되었습니다.`);
    return result;
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

  function runStep(step, expectedKeys, expectedRun, label) {
    exactStructuralKeys(step, expectedKeys, label);
    assert.equal(step.shell, 'bash', `${label}: shell이 변경되었습니다.`);
    assert.equal(step.run.trim(), expectedRun, `${label}: 명령이 변경되었습니다.`);
  }

  return { collectSecretAccesses, exactKeys, exactStructuralKeys, record, runStep };
}

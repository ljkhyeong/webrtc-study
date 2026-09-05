import { exactKeys, fail, record } from './validation-primitives.js';

export type StudyMode = 'focus' | 'break';
export type StudyCommand =
  | { action: 'start'; mode: StudyMode; durationSeconds: number }
  | { action: 'pause' | 'resume' | 'reset' }
  | { action: 'topic'; topic: string };
export interface StudyState {
  readonly revision: number;
  readonly topic: string;
  readonly mode: StudyMode;
  readonly durationSeconds: number;
  readonly remainingMs: number;
  readonly running: boolean;
}

function integer(value: unknown, minimum: number, maximum: number, path: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail(path, 'must be an integer within the allowed range');
}
function topic(value: unknown): void {
  if (typeof value !== 'string' || value.length > 120)
    fail('$.payload.topic', 'must contain at most 120 characters');
}
function mode(value: unknown): void {
  if (value !== 'focus' && value !== 'break') fail('$.payload.mode', 'must be focus or break');
}

export function validateStudyUpdate(input: unknown): void {
  const payload = record(input, '$.payload');
  integer(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER, '$.payload.expectedRevision');
  switch (payload.action) {
    case 'start':
      exactKeys(payload, ['action', 'expectedRevision', 'mode', 'durationSeconds'], '$.payload');
      mode(payload.mode);
      integer(payload.durationSeconds, 60, 7200, '$.payload.durationSeconds');
      return;
    case 'topic':
      exactKeys(payload, ['action', 'expectedRevision', 'topic'], '$.payload');
      topic(payload.topic);
      return;
    case 'pause':
    case 'resume':
    case 'reset':
      exactKeys(payload, ['action', 'expectedRevision'], '$.payload');
      return;
    default:
      fail('$.payload.action', 'must be a supported study action');
  }
}

export function validateStudyState(input: unknown): void {
  const payload = record(input, '$.payload');
  exactKeys(
    payload,
    ['revision', 'topic', 'mode', 'durationSeconds', 'remainingMs', 'running', 'conflict'],
    '$.payload',
  );
  integer(payload.revision, 0, Number.MAX_SAFE_INTEGER, '$.payload.revision');
  topic(payload.topic);
  mode(payload.mode);
  integer(payload.durationSeconds, 60, 7200, '$.payload.durationSeconds');
  integer(
    payload.remainingMs,
    0,
    (payload.durationSeconds as number) * 1000,
    '$.payload.remainingMs',
  );
  if (typeof payload.running !== 'boolean' || typeof payload.conflict !== 'boolean')
    fail('$.payload', 'running and conflict must be boolean');
}

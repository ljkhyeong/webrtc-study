export type UnknownRecord = Record<string, unknown>;

export class ProtocolValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ProtocolValidationError';
    this.path = path;
  }
}

export function record(input: unknown, path: string): UnknownRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(path, 'must be an object');
  }
  return input as UnknownRecord;
}

export function exactKeys(
  input: UnknownRecord,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    fail(`${path}.${unexpected}`, 'is not allowed');
  }
}

export function fail(path: string, reason: string): never {
  throw new ProtocolValidationError(path, reason);
}

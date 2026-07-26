export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 8_787;
export const DEFAULT_MAX_ROOM_SIZE = 6;
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

export interface SignalingConfig {
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  maxRoomSize: number;
}

export function readSignalingConfig(environment: NodeJS.ProcessEnv = process.env): SignalingConfig {
  return {
    host: environment.HOST?.trim() || DEFAULT_HOST,
    port: parsePositiveInteger(environment.PORT, DEFAULT_PORT, 'PORT', 65_535),
    allowedOrigins: parseAllowedOrigins(environment.ALLOWED_ORIGINS),
    maxRoomSize: parsePositiveInteger(
      environment.MAX_ROOM_SIZE,
      DEFAULT_MAX_ROOM_SIZE,
      'MAX_ROOM_SIZE',
      100,
    ),
  };
}

function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must contain at least one origin');
  }

  return origins;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

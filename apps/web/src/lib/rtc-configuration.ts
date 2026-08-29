import { loadTurnCredentials } from './turn';

export interface LoadedRtcConfiguration {
  readonly configuration: RTCConfiguration;
  readonly turnRefreshDueAtMs: number | null;
}

export async function loadRtcConfiguration(
  turnCredentialsUrl: string,
  signal?: AbortSignal,
): Promise<LoadedRtcConfiguration> {
  const stunUrls = (import.meta.env.VITE_STUN_URLS ?? 'stun:stun.cloudflare.com:3478')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  let credentials;
  try {
    credentials = await loadTurnCredentials({
      endpoint: turnCredentialsUrl,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new Error('TURN 서버 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.', {
      cause: error,
    });
  }
  if (credentials !== null) {
    iceServers.push(credentials.iceServer);
  }

  const configuredPolicy = import.meta.env.VITE_ICE_TRANSPORT_POLICY?.trim() || 'all';
  if (configuredPolicy !== 'all' && configuredPolicy !== 'relay') {
    throw new Error('ICE 전송 정책 설정이 올바르지 않습니다.');
  }

  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (credentials === null && (!localDevelopment || configuredPolicy === 'relay')) {
    throw new Error('TURN 서버 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  return {
    configuration: {
      iceServers,
      iceCandidatePoolSize: 1,
      iceTransportPolicy: configuredPolicy,
    },
    turnRefreshDueAtMs: credentials?.refreshDueAtMs ?? null,
  };
}

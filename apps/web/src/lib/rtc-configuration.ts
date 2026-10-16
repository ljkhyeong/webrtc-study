import { loadTurnCredentials, TurnCredentialRateLimitError, type TurnCredentials } from './turn';

export interface LoadedRtcConfiguration {
  readonly configuration: RTCConfiguration;
  readonly turnRefreshDueAtMs: number | null;
}

/**
 * 방 다시 입장처럼 같은 화면에서 다시 입장할 때, 아직 갱신할 때가 되지 않은 TURN 자격 증명을
 * 재사용해 발급 한도를 쓰지 않도록 보관한다. 갱신 시점은 단조 증가 시계와 기기 시각 중 먼저 오는 쪽을 따른다.
 */
export interface TurnCredentialReuse {
  last: {
    readonly url: string;
    readonly credentials: TurnCredentials;
    readonly refreshDueAtWallMs: number;
  } | null;
}

export async function loadRtcConfiguration(
  turnCredentialsUrl: string,
  signal?: AbortSignal,
  options: { readonly reuse?: TurnCredentialReuse } = {},
): Promise<LoadedRtcConfiguration> {
  const configuredPolicy = import.meta.env.VITE_ICE_TRANSPORT_POLICY?.trim() || 'all';
  if (configuredPolicy !== 'all' && configuredPolicy !== 'relay') {
    throw new Error('ICE 전송 정책 설정이 올바르지 않습니다.');
  }

  const stunUrls = (import.meta.env.VITE_STUN_URLS ?? 'stun:stun.cloudflare.com:3478')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  let credentials: TurnCredentials | null;
  const reusable = options.reuse?.last;
  if (
    reusable?.url === turnCredentialsUrl &&
    globalThis.performance.now() < reusable.credentials.refreshDueAtMs &&
    Date.now() < reusable.refreshDueAtWallMs
  ) {
    credentials = reusable.credentials;
  } else {
    try {
      credentials = await loadTurnCredentials({
        endpoint: turnCredentialsUrl,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof TurnCredentialRateLimitError) throw error;
      throw new Error('통화 중계 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.', {
        cause: error,
      });
    }
    if (options.reuse !== undefined) {
      options.reuse.last =
        credentials === null
          ? null
          : {
              url: turnCredentialsUrl,
              credentials,
              refreshDueAtWallMs:
                Date.now() + (credentials.refreshDueAtMs - globalThis.performance.now()),
            };
    }
  }
  if (credentials !== null) {
    iceServers.push(credentials.iceServer);
  }

  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (credentials === null && (!localDevelopment || configuredPolicy === 'relay')) {
    throw new Error('통화 중계 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
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

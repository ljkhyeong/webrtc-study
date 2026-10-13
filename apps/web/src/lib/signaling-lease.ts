const REQUEST_TIMEOUT_MS = 5_000;

export type SignalingLeaseRenewal = 'renewed' | 'rejected';

/**
 * 갱신한 BATON 참여권 쿠키로 현재 시그널링 연결의 만료 시각을 늦춘다.
 * 연결할 수 없는 참가자·권한은 `rejected`로 돌려주고, 다시 시도할 만한 실패는 예외로 알린다.
 */
export async function renewSignalingLease(
  signalingUrl: string,
  peerId: string,
  signal: AbortSignal,
): Promise<SignalingLeaseRenewal> {
  const url = new URL(signalingUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.searchParams.set('lease', peerId);
  const response = await fetch(url.href, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (response.status === 204) return 'renewed';
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`Signaling lease renewal failed with status ${response.status}`);
  }
  return 'rejected';
}

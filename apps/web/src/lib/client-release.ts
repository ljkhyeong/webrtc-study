import { useCallback, useEffect, useRef, useState } from 'react';
import { supportsCurrentClient } from '@round/protocol';

export type ReleaseStatus = 'current' | 'update' | 'unavailable';

export async function checkSignalingCompatibility(signalingUrl: string): Promise<void> {
  const url = new URL(signalingUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.searchParams.set('compatibility', '1');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  let supported: boolean;
  try {
    const response = await fetch(url.href, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (response.status >= 500) throw new Error('서버 응답 오류');
    supported = response.ok && supportsCurrentClient(await response.json());
  } catch {
    throw new Error(
      '시그널링 서버의 지원 기능을 확인하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.',
    );
  } finally {
    window.clearTimeout(timeout);
  }
  if (!supported)
    throw new Error(
      '시그널링 서버가 현재 화면을 지원하지 않습니다. 새로고침해 주세요. 계속되면 운영자에게 알려 주세요.',
    );
}

export function useClientRelease(enabled = true) {
  const [status, setStatus] = useState<ReleaseStatus>('current');
  const lifetime = useRef(0);
  const request = useRef<{ controller: AbortController; result: Promise<ReleaseStatus> } | null>(
    null,
  );
  const check = useCallback((): Promise<ReleaseStatus> => {
    if (request.current) return request.current.result;
    const generation = lifetime.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const result = (async (): Promise<ReleaseStatus> => {
      let next: ReleaseStatus;
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}release.json`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const value: unknown = response.ok ? await response.json() : null;
        if (
          typeof value !== 'object' ||
          value === null ||
          !('buildId' in value) ||
          typeof value.buildId !== 'string' ||
          !value.buildId ||
          value.buildId.length > 80
        ) {
          throw new Error('웹 배포 정보를 확인할 수 없습니다.');
        }
        next = value.buildId === import.meta.env.ROUND_WEB_BUILD_ID ? 'current' : 'update';
      } catch {
        next = 'unavailable';
      } finally {
        window.clearTimeout(timeout);
        if (generation === lifetime.current) request.current = null;
      }
      if (generation !== lifetime.current) return 'unavailable';
      setStatus((previous) => (next === 'unavailable' && previous === 'update' ? previous : next));
      return next;
    })();
    request.current = { controller, result };
    return result;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const checkVisible = () => {
      if (!document.hidden) void check();
    };
    checkVisible();
    const timer = window.setInterval(checkVisible, 60_000);
    document.addEventListener('visibilitychange', checkVisible);
    window.addEventListener('online', checkVisible);
    return () => {
      lifetime.current += 1;
      request.current?.controller.abort();
      request.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', checkVisible);
      window.removeEventListener('online', checkVisible);
    };
  }, [check, enabled]);
  return { status, check };
}

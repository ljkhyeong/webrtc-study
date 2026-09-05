import { useEffect, useState } from 'react';

type WakeLockStatus = 'off' | 'requesting' | 'active' | 'waiting' | 'released' | 'error';

export function useScreenWakeLock(active: boolean) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<WakeLockStatus>('off');

  useEffect(() => {
    if (!enabled || !supported) {
      setStatus('off');
      return;
    }
    if (!active) {
      setStatus('waiting');
      return;
    }
    let disposed = false;
    let requesting = false;
    let retryOnReturn = false;
    let lock: WakeLockSentinel | null = null;
    const release = () => {
      const previous = lock;
      lock = null;
      if (previous) void previous.release().catch(() => {});
    };
    const request = async () => {
      if (disposed || requesting || lock) return;
      if (document.hidden) {
        setStatus('waiting');
        return;
      }
      requesting = true;
      setStatus('requesting');
      try {
        const next = await navigator.wakeLock.request('screen');
        // 설정을 끄거나 방을 나간 뒤 도착한 승인도 즉시 해제한다.
        if (disposed || document.hidden) {
          await next.release();
          if (!disposed) setStatus('waiting');
          return;
        }
        if (next.released) {
          setStatus('released');
          return;
        }
        lock = next;
        next.addEventListener(
          'release',
          () => {
            if (disposed || lock !== next) return;
            lock = null;
            setStatus(document.hidden ? 'waiting' : 'released');
          },
          { once: true },
        );
        setStatus('active');
      } catch {
        if (!disposed) setStatus(document.hidden ? 'waiting' : 'error');
      } finally {
        requesting = false;
        if (retryOnReturn) {
          retryOnReturn = false;
          void request();
        }
      }
    };
    const visibility = () => {
      if (document.hidden) {
        release();
        setStatus('waiting');
      } else {
        retryOnReturn = requesting;
        void request();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    void request();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visibility);
      release();
    };
  }, [active, enabled, supported]);

  return { supported, enabled, status, setEnabled };
}

export type ScreenWakeLockControl = ReturnType<typeof useScreenWakeLock>;

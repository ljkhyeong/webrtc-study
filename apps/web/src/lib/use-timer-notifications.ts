import { useCallback, useEffect, useRef, useState } from 'react';

export function useTimerNotifications() {
  const supported = typeof Notification !== 'undefined';
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const notification = useRef<Notification | null>(null);
  const lifetime = useRef({ disposed: false });
  const close = useCallback(() => {
    notification.current?.close();
    notification.current = null;
  }, []);

  useEffect(() => {
    const current = { disposed: false };
    lifetime.current = current;
    const onFocus = () => {
      if (!document.hidden && document.hasFocus()) close();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      current.disposed = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      close();
    };
  }, [close]);

  const toggle = async () => {
    if (!supported || pending) return;
    setNotice('');
    if (enabled) {
      setEnabled(false);
      close();
      return;
    }
    const current = lifetime.current;
    setPending(true);
    try {
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      if (current.disposed) return;
      setEnabled(permission === 'granted');
      if (permission === 'denied') setNotice('브라우저 사이트 설정에서 알림을 허용해 주세요.');
      else if (permission !== 'granted') setNotice('알림을 허용해야 종료 알림을 받을 수 있습니다.');
    } catch {
      if (!current.disposed) setNotice('이 브라우저에서는 데스크톱 알림을 켤 수 없습니다.');
    } finally {
      if (!current.disposed) setPending(false);
    }
  };

  const notify = useCallback(
    (message: string) => {
      if (!enabled || !supported) return;
      if (Notification.permission !== 'granted') {
        setEnabled(false);
        setNotice('브라우저 사이트 설정에서 알림을 허용해 주세요.');
        return;
      }
      if (!document.hidden && document.hasFocus()) return;
      close();
      try {
        const next = new Notification('ROUND 타이머', { body: message });
        notification.current = next;
        next.onclick = () => {
          window.focus();
          close();
        };
      } catch {
        setEnabled(false);
        setNotice('데스크톱 알림을 표시하지 못했습니다. 화면에서 종료 시간을 확인해 주세요.');
      }
    },
    [enabled, supported, close],
  );

  return { supported, enabled, pending, notice, toggle, notify, close };
}

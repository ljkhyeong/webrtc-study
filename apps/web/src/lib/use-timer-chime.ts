import { useCallback, useEffect, useRef, useState } from 'react';
import { createTimerChime } from './timer-chime';

// 사용자가 켠 동안만 종료 알림음의 오디오 자원을 유지하고, 화면을 떠나면 닫는다.
export function useTimerChime() {
  const chime = useRef<ReturnType<typeof createTimerChime> | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(
    () => () => {
      chime.current?.close();
      chime.current = null;
    },
    [],
  );

  const toggle = () => {
    setNotice('');
    if (chime.current) {
      chime.current.close();
      chime.current = null;
      setEnabled(false);
      return;
    }
    try {
      const next = createTimerChime();
      chime.current = next;
      setEnabled(true);
      void next.ready.catch(() => {
        if (chime.current !== next) return;
        next.close();
        chime.current = null;
        setEnabled(false);
        setNotice('알림음을 켜지 못했습니다. 브라우저의 소리 설정을 확인해 주세요.');
      });
    } catch {
      setNotice('이 브라우저에서는 알림음을 켤 수 없습니다.');
    }
  };

  const play = useCallback(() => {
    if (!chime.current) return;
    try {
      if (!chime.current.play())
        setNotice('브라우저에서 소리가 중단되었습니다. 알림음을 다시 켜 주세요.');
    } catch {
      setNotice('알림음을 재생하지 못했습니다. 기기의 소리 설정을 확인해 주세요.');
    }
  }, []);

  return { enabled, notice, toggle, play };
}

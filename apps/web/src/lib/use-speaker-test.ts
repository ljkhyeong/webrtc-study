import { useEffect, useRef, useState } from 'react';
import { startSpeakerTest } from './speaker-test';

export function useSpeakerTest(deviceId: string) {
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const testRef = useRef<ReturnType<typeof startSpeakerTest> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      testRef.current?.stop();
    };
  }, []);

  const clear = () => {
    setNotice('');
    setError('');
  };

  const play = async () => {
    if (!mounted.current || testRef.current) return;
    setTesting(true);
    clear();
    try {
      const test = startSpeakerTest(deviceId);
      testRef.current = test;
      await test.finished;
      if (mounted.current)
        setNotice('확인음을 재생했습니다. 들리지 않으면 볼륨과 스피커 연결을 확인해 주세요.');
    } catch {
      if (mounted.current)
        setError(
          '확인음을 재생하지 못했습니다. 스피커 연결과 브라우저의 소리 권한을 확인해 주세요.',
        );
    } finally {
      testRef.current = null;
      if (mounted.current) setTesting(false);
    }
  };

  return { testing, notice, error, play, clear };
}

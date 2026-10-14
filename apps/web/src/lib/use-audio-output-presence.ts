import { useEffect, useRef, useState } from 'react';

const MISSING_OUTPUT_WARNING =
  '선택한 스피커가 연결되어 있지 않습니다. 통화 장치 설정에서 스피커를 다시 선택해 주세요.';

/**
 * 선택한 스피커가 분리되면 안내 문구를 돌려주고, 분리됐던 같은 장치가 다시 연결되면 알린다.
 * 다른 출력 장치로 자동 전환하지 않으며 시스템 기본 출력은 장치 목록을 조회하지 않는다.
 */
export function useAudioOutputPresence(deviceId: string, onReconnected: () => void): string {
  const [warning, setWarning] = useState('');
  const onReconnectedRef = useRef(onReconnected);
  useEffect(() => {
    onReconnectedRef.current = onReconnected;
  }, [onReconnected]);

  useEffect(() => {
    setWarning('');
    if (!deviceId) return;
    let disposed = false;
    let request = 0;
    let missing = false;
    const mediaDevices = navigator.mediaDevices;
    const checkOutput = async () => {
      const current = ++request;
      try {
        const devices = await mediaDevices.enumerateDevices();
        if (disposed || current !== request) return;
        const present = devices.some(
          (device) => device.kind === 'audiooutput' && device.deviceId === deviceId,
        );
        setWarning(present ? '' : MISSING_OUTPUT_WARNING);
        if (present && missing) onReconnectedRef.current();
        missing = !present;
      } catch {
        // 목록 조회 실패만으로 사용 중인 출력 장치를 바꾸지 않는다.
      }
    };
    mediaDevices.addEventListener('devicechange', checkOutput);
    void checkOutput();
    return () => {
      disposed = true;
      mediaDevices.removeEventListener('devicechange', checkOutput);
    };
  }, [deviceId]);

  return warning;
}

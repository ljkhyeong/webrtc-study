import { useEffect, useRef, useState } from 'react';
import { useSpeakerTest } from '../lib/use-speaker-test';

interface AudioOutputControlsProps {
  deviceId: string;
  devices: readonly MediaDeviceInfo[];
  onSelect: (deviceId: string) => void;
  onRefresh: () => void;
}

type OutputMediaDevices = MediaDevices & {
  selectAudioOutput?: (options: { deviceId: string }) => Promise<MediaDeviceInfo>;
};

export function AudioOutputControls({
  deviceId,
  devices,
  onSelect,
  onRefresh,
}: AudioOutputControlsProps) {
  const [selected, setSelected] = useState(deviceId);
  const [pending, setPending] = useState(false);
  const speakerTest = useSpeakerTest(deviceId);
  const { testing } = speakerTest;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const supported = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  const mediaDevices = navigator.mediaDevices as OutputMediaDevices | undefined;
  const outputs = devices.filter(
    (device) => device.kind === 'audiooutput' && device.deviceId !== 'default',
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function selectOutput(choose: boolean) {
    setPending(true);
    setNotice('');
    setError('');
    speakerTest.clear();
    try {
      const next = choose
        ? (await mediaDevices!.selectAudioOutput!({ deviceId })).deviceId
        : selected;
      if (next) await new Audio().setSinkId(next);
      if (!mounted.current) return;
      setSelected(next);
      onSelect(next);
      onRefresh();
      setNotice('스피커를 선택했습니다. ‘소리 확인’을 눌러 재생해 보세요.');
    } catch {
      if (mounted.current)
        setError('스피커 선택이 취소되었거나 장치를 사용할 수 없습니다. 기존 선택을 유지합니다.');
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  function testSpeaker() {
    setNotice('');
    setError('');
    void speakerTest.play();
  }

  return (
    <section className="audio-output-controls" aria-label="스피커 설정">
      {supported ? (
        <div className="media-device-dialog__input">
          <label>
            <span>스피커</span>
            <select
              value={selected}
              disabled={pending || testing}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">시스템 기본 스피커</option>
              {selected && !outputs.some((device) => device.deviceId === selected) ? (
                <option value={selected}>선택한 스피커 (현재 목록에 없음)</option>
              ) : null}
              {outputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `스피커 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={pending || testing}
            onClick={() => void selectOutput(false)}
          >
            스피커 적용
          </button>
        </div>
      ) : (
        <p>
          이 브라우저에서는 스피커를 선택할 수 없습니다. 운영체제의 소리 설정에서 출력 장치를 변경해
          주세요.
        </p>
      )}
      <div className="audio-output-controls__actions">
        {supported && mediaDevices?.selectAudioOutput ? (
          <button
            type="button"
            disabled={pending || testing}
            onClick={() => void selectOutput(true)}
          >
            다른 스피커 선택
          </button>
        ) : null}
        <button type="button" disabled={pending || testing} onClick={() => void testSpeaker()}>
          {testing ? '확인음 재생 중' : '소리 확인'}
        </button>
      </div>
      <p>
        선택한 스피커로 짧은 확인음을 재생합니다. 목록에 없는 장치는 운영체제의 소리 설정을 확인해
        주세요.
      </p>
      <p role="status">{pending ? '스피커를 선택하고 있습니다.' : notice || speakerTest.notice}</p>
      {error || speakerTest.error ? <p role="alert">{error || speakerTest.error}</p> : null}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { AudioOutputControls } from './AudioOutputControls';

interface MediaDeviceDialogProps {
  audioDeviceId: string;
  videoDeviceId: string;
  outputDeviceId: string;
  onSelectOutput: (deviceId: string) => void;
  screenSharing: boolean;
  active: boolean;
  onSelect: (kind: 'audio' | 'video', deviceId: string) => Promise<boolean>;
  onClose: () => void;
}

export function MediaDeviceDialog({
  audioDeviceId,
  videoDeviceId,
  outputDeviceId,
  onSelectOutput,
  screenSharing,
  active,
  onSelect,
  onClose,
}: MediaDeviceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [audio, setAudio] = useState(audioDeviceId);
  const [video, setVideo] = useState(videoDeviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [pending, setPending] = useState<'audio' | 'video' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deviceListError, setDeviceListError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => {
      mounted.current = false;
      dialog.close();
    };
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    let disposed = false;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const available = await mediaDevices.enumerateDevices();
        if (!disposed && current === request) {
          setDevices(available.filter((device) => device.deviceId !== ''));
          setDeviceListError(false);
        }
      } catch {
        if (!disposed && current === request) setDeviceListError(true);
      }
    };
    void load();
    mediaDevices?.addEventListener('devicechange', load);
    return () => {
      disposed = true;
      mediaDevices?.removeEventListener('devicechange', load);
    };
  }, [refresh]);

  const apply = async (kind: 'audio' | 'video') => {
    setPending(kind);
    setNotice('');
    setError('');
    try {
      const changed = await onSelect(kind, kind === 'audio' ? audio : video);
      if (!mounted.current) return;
      if (changed) {
        setNotice(`${kind === 'audio' ? '마이크' : '카메라'}를 변경했습니다.`);
        setRefresh((value) => value + 1);
      } else {
        setError(
          '장치를 변경하지 못했습니다. 장치 권한과 연결 상태를 확인해 주세요. 기존 통화는 유지됩니다.',
        );
      }
    } catch {
      if (mounted.current) setError('장치를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const inputOptions = (kind: MediaDeviceKind) => devices.filter((device) => device.kind === kind);

  return (
    <dialog
      ref={dialogRef}
      className="media-device-dialog"
      aria-labelledby="media-device-title"
      onCancel={onClose}
    >
      <header>
        <h2 id="media-device-title">통화 장치 설정</h2>
        <button type="button" onClick={onClose} aria-label="장치 설정 닫기">
          닫기
        </button>
      </header>
      <p>
        통화와 채팅을 유지한 채 장치를 바꿉니다. 꺼 둔 마이크와 카메라는 꺼진 상태를 유지합니다.
      </p>
      {(['audio', 'video'] as const).map((kind) => {
        const label = kind === 'audio' ? '마이크' : '카메라';
        const selected = kind === 'audio' ? audio : video;
        const options = inputOptions(kind === 'audio' ? 'audioinput' : 'videoinput');
        return (
          <div className="media-device-dialog__input" key={kind}>
            <label>
              <span>{label}</span>
              <select
                value={selected}
                disabled={pending !== null || !active || (kind === 'video' && screenSharing)}
                onChange={(event) => (kind === 'audio' ? setAudio : setVideo)(event.target.value)}
              >
                <option value="">브라우저 기본 {label}</option>
                {selected && !options.some((device) => device.deviceId === selected) ? (
                  <option value={selected}>현재 {label} (목록에서 확인되지 않음)</option>
                ) : null}
                {options.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `${label} ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={pending !== null || !active || (kind === 'video' && screenSharing)}
              onClick={() => void apply(kind)}
            >
              {label} 적용
            </button>
          </div>
        );
      })}
      {screenSharing ? <p>카메라는 화면 공유를 중지한 뒤 변경할 수 있습니다.</p> : null}
      {deviceListError ? (
        <p>
          장치 목록을 불러오지 못했습니다. 브라우저 기본 장치를 적용하거나 설정을 다시 열어 주세요.
        </p>
      ) : null}
      <p role="status">
        {pending !== null ? '장치를 변경하고 있습니다. 권한 요청이 뜨면 확인해 주세요.' : notice}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <AudioOutputControls
        deviceId={outputDeviceId}
        devices={devices}
        onSelect={onSelectOutput}
        onRefresh={() => setRefresh((value) => value + 1)}
      />
    </dialog>
  );
}

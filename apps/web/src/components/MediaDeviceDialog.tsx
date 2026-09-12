import { useEffect, useRef, useState } from 'react';
import type { VideoQualityMode, ScreenShareQuality } from '@round/rtc-core';
import { AudioOutputControls } from './AudioOutputControls';
import { MicrophoneLevel } from './MicrophoneLevel';
import type { ScreenWakeLockControl } from '../lib/use-screen-wake-lock';

interface MediaDeviceDialogProps {
  audioDeviceId: string;
  audioTrack: MediaStreamTrack | null;
  audioEnabled: boolean;
  videoDeviceId: string;
  outputDeviceId: string;
  onSelectOutput: (deviceId: string) => void;
  screenSharing: boolean;
  screenWakeLock?: ScreenWakeLockControl | undefined;
  active: boolean;
  screenShareQuality?: ScreenShareQuality | undefined;
  onSelectScreenShareQuality?: ((mode: ScreenShareQuality) => boolean) | undefined;
  videoQualityMode: VideoQualityMode;
  onSelectVideoQuality: (mode: VideoQualityMode) => Promise<boolean>;
  onSelect: (kind: 'audio' | 'video', deviceId: string) => Promise<boolean>;
  onClose: () => void;
}

export function MediaDeviceDialog({
  audioDeviceId,
  audioTrack,
  audioEnabled,
  videoDeviceId,
  outputDeviceId,
  onSelectOutput,
  screenSharing,
  screenWakeLock,
  active,
  videoQualityMode,
  screenShareQuality = 'standard',
  onSelectScreenShareQuality,
  onSelectVideoQuality,
  onSelect,
  onClose,
}: MediaDeviceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [audio, setAudio] = useState(audioDeviceId);
  const [video, setVideo] = useState(videoDeviceId);
  const [quality, setQuality] = useState(videoQualityMode);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [pending, setPending] = useState<'audio' | 'video' | 'quality' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deviceListError, setDeviceListError] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
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
      setLoadingDevices(true);
      try {
        const available = await mediaDevices.enumerateDevices();
        if (!disposed && current === request) {
          setDevices(available.filter((device) => device.deviceId !== ''));
          setDeviceListError(false);
        }
      } catch {
        if (!disposed && current === request) setDeviceListError(true);
      } finally {
        if (!disposed && current === request) setLoadingDevices(false);
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

  const applyQuality = async () => {
    setPending('quality');
    setNotice('');
    setError('');
    try {
      const applied = await onSelectVideoQuality(quality);
      if (!mounted.current) return;
      if (applied) setNotice('카메라 전송 품질을 적용했습니다.');
      else
        setError(
          '일부 참가자에게 카메라 품질을 적용하지 못했습니다. 다시 적용하거나 카메라를 꺼 주세요.',
        );
    } catch {
      if (mounted.current) setError('카메라 전송 품질을 적용하지 못했습니다. 다시 시도해 주세요.');
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
      <button
        type="button"
        disabled={loadingDevices || pending !== null}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {loadingDevices ? '목록 확인 중' : '장치 목록 새로고침'}
      </button>
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
                  <option value={selected}>현재 {label} (장치 목록에 없음)</option>
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
            {kind === 'audio' ? (
              <MicrophoneLevel track={audioTrack} enabled={active && audioEnabled} />
            ) : null}
          </div>
        );
      })}
      {screenSharing ? <p>카메라는 화면 공유를 중지한 뒤 변경할 수 있습니다.</p> : null}
      {screenWakeLock ? (
        <section className="screen-wake-setting" aria-label="화면 유지 설정">
          <label>
            <input
              type="checkbox"
              checked={screenWakeLock.enabled}
              disabled={!screenWakeLock.supported || (!active && !screenWakeLock.enabled)}
              onChange={(event) => screenWakeLock.setEnabled(event.target.checked)}
            />
            통화 중 화면 켜짐 유지
          </label>
          <p role="status">
            {!screenWakeLock.supported
              ? '이 브라우저는 화면 켜짐 유지를 지원하지 않습니다.'
              : {
                  off: '꺼짐',
                  requesting: '켜는 중',
                  active: '켜짐',
                  waiting: '대기 중 · 통화 화면으로 돌아오면 다시 켭니다.',
                  released: '화면 켜짐 유지가 해제되었습니다. 설정을 껐다 다시 켜 주세요.',
                  error:
                    '화면 켜짐 유지를 적용하지 못했습니다. 배터리 절약 또는 브라우저 설정을 확인한 뒤 다시 켜 주세요.',
                }[screenWakeLock.status]}
          </p>
          <small>
            화면을 켜 두면 배터리를 더 사용합니다. 다른 앱으로 이동했을 때 통화를 유지하는 기능은
            아닙니다.
          </small>
        </section>
      ) : null}
      <div className="media-device-dialog__input">
        <label>
          <span>카메라 전송 품질</span>
          <select
            aria-label="카메라 전송 품질"
            value={quality}
            disabled={pending !== null || !active}
            onChange={(event) => setQuality(event.target.value as VideoQualityMode)}
          >
            <option value="standard">일반</option>
            <option value="data-saver">데이터 절약</option>
          </select>
        </label>
        <button
          type="button"
          disabled={pending !== null || !active}
          onClick={() => void applyQuality()}
        >
          품질 적용
        </button>
      </div>
      <p>
        데이터 절약은 내 카메라 영상의 전송량만 줄입니다. 상대 영상과 화면 공유에는 적용되지
        않습니다.
      </p>
      {deviceListError ? (
        <p role="alert">
          장치 목록을 불러오지 못했습니다. ‘장치 목록 새로고침’을 눌러 다시 확인해 주세요.
        </p>
      ) : null}
      <p role="status">
        {pending === 'quality'
          ? '카메라 전송 품질을 적용하고 있습니다.'
          : pending !== null
            ? '장치를 변경하고 있습니다. 권한 요청이 뜨면 확인해 주세요.'
            : notice}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {onSelectScreenShareQuality ? (
        <label className="screen-quality-setting">
          화면 공유 품질
          <select
            value={screenShareQuality}
            disabled={!active || screenSharing || pending !== null}
            onChange={(event) => {
              if (!onSelectScreenShareQuality(event.target.value as ScreenShareQuality))
                setError('공유를 중지한 뒤 품질을 선택해 주세요.');
            }}
          >
            <option value="standard">일반 · 최대 720p / 15fps</option>
            <option value="text">문서·코드 · 최대 1080p / 10fps</option>
          </select>
          <small>
            공유 시작 전에 선택하세요. 문서·코드 모드는 움직임보다 글자 선명도를 우선합니다. 실제
            품질은 브라우저와 연결 상태에 따라 달라집니다.
          </small>
        </label>
      ) : null}
      <AudioOutputControls
        deviceId={outputDeviceId}
        devices={devices}
        onSelect={onSelectOutput}
        onRefresh={() => setRefresh((value) => value + 1)}
      />
      <p>
        통화 단축키: Alt+Shift+M 마이크 · Alt+Shift+C 카메라 · Alt+Shift+H 손들기. Mac에서는 Alt
        대신 Option을 사용합니다. 글을 입력하거나 설정 창이 열려 있으면 작동하지 않습니다.
      </p>
    </dialog>
  );
}

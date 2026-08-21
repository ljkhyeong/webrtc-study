import { createPrejoinMedia, type PrejoinMedia, type PrejoinMediaSnapshot } from '@round/rtc-core';
import { MAX_HOST_CAPABILITY_LENGTH, MIN_HOST_CAPABILITY_LENGTH } from '@round/protocol';
import { useEffect, useRef, useState } from 'react';
import { ArrowIcon, CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from './Icons';

interface PrejoinScreenProps {
  displayName: string;
  roomId: string;
  showHostCapabilityInput: boolean;
  authorizeBeforeEntryAction?: (() => Promise<boolean>) | undefined;
  onBack: () => void;
  onJoin: (preparedMediaStream: MediaStream | null, hostCapability?: string) => void;
}

const initialSnapshot: PrejoinMediaSnapshot = {
  status: 'idle',
  audioInputs: [],
  videoInputs: [],
  selectedAudioInputId: null,
  selectedVideoInputId: null,
  localMedia: {
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
  },
  audioIssue: null,
  videoIssue: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '장치를 확인하지 못했습니다.';
}

export function PrejoinScreen({
  displayName,
  roomId,
  showHostCapabilityInput,
  authorizeBeforeEntryAction,
  onBack,
  onJoin,
}: PrejoinScreenProps) {
  const controllerRef = useRef<PrejoinMedia | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const actionLifetimeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const [snapshot, setSnapshot] = useState<PrejoinMediaSnapshot>(initialSnapshot);
  const [actionError, setActionError] = useState('');
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [hostCapability, setHostCapability] = useState('');

  const normalizedHostCapability = hostCapability.trim() || undefined;
  const hostCapabilityInvalid =
    normalizedHostCapability !== undefined &&
    normalizedHostCapability.length < MIN_HOST_CAPABILITY_LENGTH;

  const ensureController = () => {
    const existing = controllerRef.current;
    if (existing !== null) {
      return existing;
    }

    const controller = createPrejoinMedia({
      audioConstraints: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      videoConstraints: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 15, max: 15 },
        facingMode: 'user',
      },
    });
    controllerRef.current = controller;
    unsubscribeRef.current = controller.subscribe(setSnapshot);
    return controller;
  };

  useEffect(() => {
    actionLifetimeRef.current = true;
    return () => {
      actionLifetimeRef.current = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) {
      return;
    }

    const stream = controllerRef.current?.getStream() ?? null;
    if (preview.srcObject !== stream) {
      preview.srcObject = stream;
    }
  }, [snapshot]);

  const runAuthorized = (operation: () => Promise<unknown>) => {
    if (!actionLifetimeRef.current || actionInFlightRef.current) {
      return;
    }
    actionInFlightRef.current = true;
    setActionError('');
    setAuthorizationPending(true);
    void (async () => {
      try {
        if (authorizeBeforeEntryAction !== undefined && !(await authorizeBeforeEntryAction())) {
          return;
        }
        if (!actionLifetimeRef.current) {
          return;
        }
        await operation();
      } catch (error) {
        if (actionLifetimeRef.current) {
          setActionError(errorMessage(error));
        }
      } finally {
        actionInFlightRef.current = false;
        if (actionLifetimeRef.current) {
          setAuthorizationPending(false);
        }
      }
    })();
  };

  const handleCheckDevices = () => {
    runAuthorized(async () => {
      await ensureController().checkDevices();
    });
  };

  const handleJoinWithMedia = () => {
    if (snapshot.status === 'checking') {
      return;
    }

    runAuthorized(async () => {
      const stream = controllerRef.current?.takeStream() ?? null;
      onJoin(stream, normalizedHostCapability);
      actionLifetimeRef.current = false;
    });
  };

  const handleJoinWithoutMedia = () => {
    runAuthorized(async () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      onJoin(null, normalizedHostCapability);
      actionLifetimeRef.current = false;
    });
  };

  const handleBack = () => {
    actionLifetimeRef.current = false;
    controllerRef.current?.dispose();
    controllerRef.current = null;
    onBack();
  };

  const isIdle = snapshot.status === 'idle';
  const isChecking = snapshot.status === 'checking';
  const hasAnyMedia = snapshot.localMedia.audioAvailable || snapshot.localMedia.videoAvailable;

  return (
    <div className="prejoin-shell">
      <header className="prejoin-header">
        <button className="wordmark wordmark--button" type="button" onClick={handleBack}>
          ROUND
          <span>study room</span>
        </button>
        <div className="prejoin-room-code">
          <span>ROOM</span>
          <strong>{roomId}</strong>
        </div>
      </header>

      <main className="prejoin-main">
        <section className="prejoin-preview" aria-label="내 카메라 미리보기">
          <video ref={previewRef} autoPlay muted playsInline />
          {!snapshot.localMedia.videoEnabled ? (
            <div className="prejoin-preview__placeholder">
              <CameraOffIcon />
              <strong>
                {snapshot.localMedia.videoAvailable
                  ? '카메라가 꺼져 있습니다.'
                  : isIdle
                    ? '장치를 확인하면 여기에 내 모습이 보입니다.'
                    : '사용 가능한 카메라가 없습니다.'}
              </strong>
              <span>{displayName}</span>
            </div>
          ) : null}

          {!isIdle ? (
            <div className="prejoin-preview__controls" aria-label="입장 전 미디어 제어">
              <button
                className={snapshot.localMedia.audioEnabled ? '' : 'is-off'}
                type="button"
                disabled={!snapshot.localMedia.audioAvailable || isChecking || authorizationPending}
                aria-label={
                  snapshot.localMedia.audioEnabled ? '입장 전 마이크 끄기' : '입장 전 마이크 켜기'
                }
                aria-pressed={snapshot.localMedia.audioEnabled}
                onClick={() => {
                  controllerRef.current?.toggleAudio();
                }}
              >
                {snapshot.localMedia.audioEnabled ? <MicIcon /> : <MicOffIcon />}
                <span>{snapshot.localMedia.audioEnabled ? '마이크 켜짐' : '마이크 꺼짐'}</span>
              </button>
              <button
                className={snapshot.localMedia.videoEnabled ? '' : 'is-off'}
                type="button"
                disabled={!snapshot.localMedia.videoAvailable || isChecking || authorizationPending}
                aria-label={
                  snapshot.localMedia.videoEnabled ? '입장 전 카메라 끄기' : '입장 전 카메라 켜기'
                }
                aria-pressed={snapshot.localMedia.videoEnabled}
                onClick={() => {
                  controllerRef.current?.toggleVideo();
                }}
              >
                {snapshot.localMedia.videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
                <span>{snapshot.localMedia.videoEnabled ? '카메라 켜짐' : '카메라 꺼짐'}</span>
              </button>
            </div>
          ) : null}

          {isChecking ? (
            <div className="prejoin-preview__checking" role="status" aria-live="polite">
              <span className="connecting-ring" />
              <strong>마이크와 카메라를 각각 확인하고 있습니다.</strong>
            </div>
          ) : null}
        </section>

        <section className="prejoin-settings" aria-labelledby="prejoin-title">
          <p className="eyebrow">Before you join</p>
          <h1 id="prejoin-title">입장 전에 장치를 확인해 주세요.</h1>
          <p className="prejoin-description">
            이 버튼을 누르기 전에는 카메라와 마이크 권한을 요청하지 않습니다. 확인이 끝나도 실제 방
            연결은 입장 버튼을 눌러야 시작됩니다.
          </p>

          {showHostCapabilityInput ? (
            <label className="prejoin-host-capability">
              <span>방장 키 (선택)</span>
              <input
                type="password"
                value={hostCapability}
                minLength={MIN_HOST_CAPABILITY_LENGTH}
                maxLength={MAX_HOST_CAPABILITY_LENGTH}
                autoComplete="off"
                placeholder="방장일 때만 입력"
                aria-describedby="prejoin-host-capability-help"
                aria-invalid={hostCapabilityInvalid}
                onChange={(event) => setHostCapability(event.target.value)}
              />
              <small id="prejoin-host-capability-help">
                {hostCapabilityInvalid
                  ? `방장 키는 ${MIN_HOST_CAPABILITY_LENGTH}자 이상이어야 합니다.`
                  : `일반 참가자는 비워 두세요. ${MIN_HOST_CAPABILITY_LENGTH}자 이상의 무작위 키만 사용하며 화면에 표시되지 않습니다.`}
              </small>
            </label>
          ) : null}

          {isIdle ? (
            <div className="prejoin-idle-actions">
              <button
                className="prejoin-primary-action"
                type="button"
                disabled={authorizationPending}
                onClick={handleCheckDevices}
              >
                장치 확인
                <CameraIcon />
              </button>
              <button
                className="prejoin-text-action"
                type="button"
                disabled={hostCapabilityInvalid || authorizationPending}
                onClick={handleJoinWithoutMedia}
              >
                미디어 없이 입장
              </button>
            </div>
          ) : (
            <>
              <div className="prejoin-device-fields">
                <label>
                  <span>마이크</span>
                  <select
                    value={snapshot.selectedAudioInputId ?? ''}
                    disabled={
                      isChecking || authorizationPending || snapshot.audioInputs.length === 0
                    }
                    onChange={(event) => {
                      const controller = controllerRef.current;
                      if (controller !== null) {
                        runAuthorized(() => controller.selectAudioInput(event.target.value));
                      }
                    }}
                  >
                    {snapshot.audioInputs.length === 0 ? (
                      <option value="">사용 가능한 마이크 없음</option>
                    ) : (
                      snapshot.audioInputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label>
                  <span>카메라</span>
                  <select
                    value={snapshot.selectedVideoInputId ?? ''}
                    disabled={
                      isChecking || authorizationPending || snapshot.videoInputs.length === 0
                    }
                    onChange={(event) => {
                      const controller = controllerRef.current;
                      if (controller !== null) {
                        runAuthorized(() => controller.selectVideoInput(event.target.value));
                      }
                    }}
                  >
                    {snapshot.videoInputs.length === 0 ? (
                      <option value="">사용 가능한 카메라 없음</option>
                    ) : (
                      snapshot.videoInputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>

              <div className="prejoin-issues" aria-live="polite">
                {snapshot.audioIssue ? (
                  <p role="alert">
                    <MicOffIcon />
                    <span>{snapshot.audioIssue.message}</span>
                  </p>
                ) : null}
                {snapshot.videoIssue ? (
                  <p role="alert">
                    <CameraOffIcon />
                    <span>{snapshot.videoIssue.message}</span>
                  </p>
                ) : null}
                {actionError ? <p role="alert">{actionError}</p> : null}
              </div>

              <button
                className="prejoin-retry-action"
                type="button"
                disabled={isChecking || authorizationPending}
                onClick={() => {
                  const controller = controllerRef.current;
                  if (controller !== null) {
                    runAuthorized(() => controller.retryUnavailable());
                  }
                }}
              >
                다시 시도
              </button>

              <div className="prejoin-join-actions">
                <button
                  className="prejoin-primary-action"
                  type="button"
                  disabled={isChecking || hostCapabilityInvalid || authorizationPending}
                  onClick={handleJoinWithMedia}
                >
                  {hasAnyMedia ? '이 설정으로 입장' : '미디어 없이 입장'}
                  <ArrowIcon />
                </button>
                {hasAnyMedia ? (
                  <button
                    className="prejoin-text-action"
                    type="button"
                    disabled={isChecking || hostCapabilityInvalid || authorizationPending}
                    onClick={handleJoinWithoutMedia}
                  >
                    미디어 없이 입장
                  </button>
                ) : null}
              </div>
            </>
          )}

          <button className="prejoin-back-action" type="button" onClick={handleBack}>
            이름 또는 방 다시 선택
          </button>
        </section>
      </main>
    </div>
  );
}

import { PrejoinMedia, type PrejoinMediaSnapshot, type RoomSessionOptions } from '@round/rtc-core';
import { MAX_HOST_CAPABILITY_LENGTH, MIN_HOST_CAPABILITY_LENGTH } from '@round/protocol';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_AUDIO_CONSTRAINTS, DEFAULT_VIDEO_CONSTRAINTS } from '../lib/media-constraints';
import { prejoinMediaIssueMessage } from '../lib/prejoin-presentation';
import { ArrowIcon, CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from './Icons';
import { MicrophoneLevel } from './MicrophoneLevel';
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from '../lib/room';
import { useSpeakerTest } from '../lib/use-speaker-test';

interface PrejoinScreenProps {
  initialDisplayName: string;
  roomId: string;
  backLabel: string;
  showHostCapabilityInput: boolean;
  authorizeBeforeEntryAction?: (() => Promise<boolean>) | undefined;
  beforeJoin?: (() => Promise<boolean>) | undefined;
  onBack: () => void;
  onJoin: (
    displayName: string,
    preparedMediaStream: MediaStream | null,
    hostCapability?: string,
    initialInputEnabled?: RoomSessionOptions['initialInputEnabled'],
  ) => void;
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
  initialDisplayName,
  roomId,
  backLabel,
  showHostCapabilityInput,
  authorizeBeforeEntryAction,
  beforeJoin,
  onBack,
  onJoin,
}: PrejoinScreenProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [nameError, setNameError] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<PrejoinMedia | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const actionLifetimeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const [snapshot, setSnapshot] = useState<PrejoinMediaSnapshot>(initialSnapshot);
  const [actionError, setActionError] = useState('');
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [hostCapability, setHostCapability] = useState('');
  const speakerTest = useSpeakerTest('');

  const normalizedHostCapability = hostCapability.trim() || undefined;
  const hostCapabilityInvalid =
    normalizedHostCapability !== undefined &&
    normalizedHostCapability.length < MIN_HOST_CAPABILITY_LENGTH;

  const ensureController = () => {
    const existing = controllerRef.current;
    if (existing !== null) {
      return existing;
    }

    const controller = new PrejoinMedia({
      audioConstraints: DEFAULT_AUDIO_CONSTRAINTS,
      videoConstraints: DEFAULT_VIDEO_CONSTRAINTS,
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

  const handleJoin = (withMedia: boolean) => {
    if (withMedia && snapshot.status === 'checking') {
      return;
    }
    const safeName = sanitizeDisplayName(displayName);
    if (!safeName) {
      setNameError('스터디에서 사용할 이름을 입력해 주세요.');
      nameInputRef.current?.focus();
      return;
    }

    runAuthorized(async () => {
      if (beforeJoin && !(await beforeJoin())) return;
      if (!actionLifetimeRef.current) return;
      const controller = controllerRef.current;
      if (withMedia) {
        const initialInputEnabled = controller?.getInputEnabled();
        const stream = controller?.takeStream() ?? null;
        onJoin(safeName, stream, normalizedHostCapability, initialInputEnabled);
      } else {
        controller?.dispose();
        controllerRef.current = null;
        onJoin(safeName, null, normalizedHostCapability);
      }
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
        <button
          className="wordmark wordmark--button"
          type="button"
          aria-label={backLabel}
          onClick={handleBack}
        >
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
            <div className="prejoin-preview__controls" aria-label="입장 전 마이크·카메라 설정">
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
              <strong>마이크와 카메라를 확인하고 있습니다.</strong>
            </div>
          ) : null}
        </section>

        <section className="prejoin-settings" aria-labelledby="prejoin-title">
          <h1 id="prejoin-title">입장 준비</h1>
          <p className="prejoin-description">
            이름과 장치를 확인한 뒤 입장하세요. 카메라와 마이크는 ‘장치 확인’을 눌러야 켜집니다.
          </p>

          <div className="prejoin-name">
            <label htmlFor="display-name">내 이름</label>
            <input
              ref={nameInputRef}
              id="display-name"
              autoComplete="nickname"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              placeholder="스터디에서 사용할 이름"
              value={displayName}
              disabled={authorizationPending}
              aria-invalid={Boolean(nameError)}
              aria-describedby="prejoin-name-help"
              onChange={(event) => {
                setDisplayName(event.target.value);
                setNameError('');
              }}
            />
            <small id="prejoin-name-help" {...(nameError ? { role: 'alert' } : {})}>
              {nameError || '이 방에서 다른 참가자에게 표시됩니다.'}
            </small>
          </div>

          {actionError ? <p role="alert">{actionError}</p> : null}

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
                  : '방장은 운영자에게 받은 키를 입력하세요. 일반 참가자는 비워 두세요.'}
              </small>
            </label>
          ) : null}

          <section className="prejoin-speaker-test" aria-label="입장 전 스피커 확인">
            <button
              className="prejoin-retry-action"
              type="button"
              disabled={speakerTest.testing || authorizationPending}
              onClick={() => void speakerTest.play()}
            >
              {speakerTest.testing ? '확인음 재생 중' : '스피커 소리 확인'}
            </button>
            <small>시스템 기본 스피커로 짧은 확인음을 재생합니다.</small>
            {speakerTest.notice ? <p role="status">{speakerTest.notice}</p> : null}
            {speakerTest.error ? <p role="alert">{speakerTest.error}</p> : null}
          </section>

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
                onClick={() => handleJoin(false)}
              >
                카메라·마이크 없이 입장
              </button>
            </div>
          ) : (
            <>
              <div className="prejoin-device-fields">
                {(['audio', 'video'] as const).map((kind) => {
                  const label = kind === 'audio' ? '마이크' : '카메라';
                  const inputs = snapshot[`${kind}Inputs`];
                  const available = snapshot.localMedia[`${kind}Available`];
                  const selectedInputId =
                    kind === 'audio'
                      ? snapshot.selectedAudioInputId
                      : snapshot.selectedVideoInputId;
                  return (
                    <label key={kind}>
                      <span>{label}</span>
                      <select
                        value={available ? (selectedInputId ?? '') : ''}
                        disabled={isChecking || authorizationPending || inputs.length === 0}
                        onChange={(event) => {
                          const deviceId = event.currentTarget.value;
                          const controller = controllerRef.current;
                          if (controller !== null) {
                            runAuthorized(() =>
                              kind === 'audio'
                                ? controller.selectAudioInput(deviceId)
                                : controller.selectVideoInput(deviceId),
                            );
                          }
                        }}
                      >
                        {!available && inputs.length > 0 ? (
                          <option value="">{label}를 선택해 주세요</option>
                        ) : null}
                        {inputs.length === 0 ? (
                          <option value="">사용 가능한 {label} 없음</option>
                        ) : (
                          inputs.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  );
                })}
              </div>

              <MicrophoneLevel
                track={controllerRef.current?.getStream()?.getAudioTracks()[0] ?? null}
                enabled={snapshot.localMedia.audioEnabled}
              />

              <div className="prejoin-issues" aria-live="polite">
                {snapshot.audioIssue ? (
                  <p role="alert">
                    <MicOffIcon />
                    <span>{prejoinMediaIssueMessage('audio', snapshot.audioIssue.code)}</span>
                  </p>
                ) : null}
                {snapshot.videoIssue ? (
                  <p role="alert">
                    <CameraOffIcon />
                    <span>{prejoinMediaIssueMessage('video', snapshot.videoIssue.code)}</span>
                  </p>
                ) : null}
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
                장치 다시 확인
              </button>

              <div className="prejoin-join-actions">
                <button
                  className="prejoin-primary-action"
                  type="button"
                  disabled={isChecking || hostCapabilityInvalid || authorizationPending}
                  onClick={() => handleJoin(true)}
                >
                  {hasAnyMedia ? '이 설정으로 입장' : '카메라·마이크 없이 입장'}
                  <ArrowIcon />
                </button>
                {hasAnyMedia ? (
                  <button
                    className="prejoin-text-action"
                    type="button"
                    disabled={isChecking || hostCapabilityInvalid || authorizationPending}
                    onClick={() => handleJoin(false)}
                  >
                    카메라·마이크 없이 입장
                  </button>
                ) : null}
              </div>
            </>
          )}

          <button className="prejoin-back-action" type="button" onClick={handleBack}>
            {backLabel}
          </button>
        </section>
      </main>
    </div>
  );
}

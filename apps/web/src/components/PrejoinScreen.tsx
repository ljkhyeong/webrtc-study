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
  const previewRef = useRef<HTMLVideoElement>(null);
  const actionLifetimeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const [snapshot, setSnapshot] = useState<PrejoinMediaSnapshot>(initialSnapshot);
  const [actionError, setActionError] = useState('');
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [hostCapability, setHostCapability] = useState('');
  const [hostOpen, setHostOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const speakerTest = useSpeakerTest('');

  const normalizedHostCapability = hostCapability.trim() || undefined;
  const hostCapabilityInvalid =
    normalizedHostCapability !== undefined &&
    normalizedHostCapability.length < MIN_HOST_CAPABILITY_LENGTH;
  // 잘못 입력한 방장 키는 입장을 막으므로 접지 않고 계속 보여 준다.
  const hostFieldVisible = hostOpen || hostCapabilityInvalid;

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
    controller.subscribe(setSnapshot);
    return controller;
  };

  useEffect(() => {
    actionLifetimeRef.current = true;
    return () => {
      actionLifetimeRef.current = false;
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
    runAuthorized(() => ensureController().checkDevices());
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

  const speakerTestSection = (
    <section className="prejoin-speaker-test" aria-label="입장 전 스피커 확인">
      <button
        className="prejoin-link-action"
        type="button"
        disabled={speakerTest.testing || authorizationPending}
        onClick={() => void speakerTest.play()}
      >
        {speakerTest.testing ? '확인음 재생 중' : '스피커 소리 확인'}
      </button>
      {speakerTest.notice ? <p role="status">{speakerTest.notice}</p> : null}
      {speakerTest.error ? <p role="alert">{speakerTest.error}</p> : null}
    </section>
  );
  const hasMediaIssue = snapshot.audioIssue !== null || snapshot.videoIssue !== null;

  return (
    <div className="prejoin-shell">
      <main className="prejoin-main">
        <header className="prejoin-masthead">
          <span className="wordmark">ROUND</span>
          <h1 id="prejoin-title">스터디룸 입장</h1>
          <p className="prejoin-room-code">
            방 코드 <span>{roomId}</span>
          </p>
        </header>

        <div className="prejoin-stage">
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
              </div>
            ) : null}

            {!isIdle ? (
              <div className="prejoin-preview__controls" aria-label="입장 전 마이크·카메라 설정">
                <button
                  className={snapshot.localMedia.audioEnabled ? '' : 'is-off'}
                  type="button"
                  disabled={
                    !snapshot.localMedia.audioAvailable || isChecking || authorizationPending
                  }
                  aria-label={
                    snapshot.localMedia.audioEnabled ? '입장 전 마이크 끄기' : '입장 전 마이크 켜기'
                  }
                  aria-pressed={snapshot.localMedia.audioEnabled}
                  onClick={() => {
                    controllerRef.current?.toggle('audio');
                  }}
                >
                  {snapshot.localMedia.audioEnabled ? <MicIcon /> : <MicOffIcon />}
                  <span>{snapshot.localMedia.audioEnabled ? '마이크 켜짐' : '마이크 꺼짐'}</span>
                </button>
                <button
                  className={snapshot.localMedia.videoEnabled ? '' : 'is-off'}
                  type="button"
                  disabled={
                    !snapshot.localMedia.videoAvailable || isChecking || authorizationPending
                  }
                  aria-label={
                    snapshot.localMedia.videoEnabled ? '입장 전 카메라 끄기' : '입장 전 카메라 켜기'
                  }
                  aria-pressed={snapshot.localMedia.videoEnabled}
                  onClick={() => {
                    controllerRef.current?.toggle('video');
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

          <section className="prejoin-devices" aria-label="마이크·카메라·스피커 확인">
            {isIdle ? (
              speakerTestSection
            ) : (
              <>
                <div className="prejoin-devices__bar">
                  <MicrophoneLevel
                    track={controllerRef.current?.getStream()?.getAudioTracks()[0] ?? null}
                    enabled={snapshot.localMedia.audioEnabled}
                  />
                  <button
                    className="prejoin-link-action"
                    type="button"
                    aria-expanded={devicesOpen}
                    aria-controls="prejoin-device-panel"
                    onClick={() => setDevicesOpen((open) => !open)}
                  >
                    {devicesOpen ? '장치 설정 닫기' : '장치 바꾸기'}
                  </button>
                </div>

                <div className="prejoin-issues" aria-live="polite">
                  {snapshot.audioIssue ? (
                    <p role="alert">
                      <MicOffIcon />
                      <span>{prejoinMediaIssueMessage('audio', snapshot.audioIssue)}</span>
                    </p>
                  ) : null}
                  {snapshot.videoIssue ? (
                    <p role="alert">
                      <CameraOffIcon />
                      <span>{prejoinMediaIssueMessage('video', snapshot.videoIssue)}</span>
                    </p>
                  ) : null}
                  {hasMediaIssue ? (
                    <button
                      className="prejoin-link-action"
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
                  ) : null}
                </div>

                <div
                  id="prejoin-device-panel"
                  className="prejoin-device-panel"
                  hidden={!devicesOpen}
                >
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
                              runAuthorized(() => controller.selectInput(kind, deviceId));
                            }
                          }}
                        >
                          {!available ? (
                            <option value="">
                              {inputs.length > 0
                                ? `${label}를 선택해 주세요`
                                : `사용 가능한 ${label} 없음`}
                            </option>
                          ) : !inputs.some((device) => device.deviceId === selectedInputId) ? (
                            <option value={selectedInputId ?? ''}>
                              현재 {label} (목록에 없음)
                            </option>
                          ) : null}
                          {inputs.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                  {speakerTestSection}
                </div>
              </>
            )}
          </section>
        </div>

        <section className="prejoin-settings" aria-labelledby="prejoin-title">
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
              {nameError || '다른 참여자에게 보이는 이름입니다.'}
            </small>
          </div>

          {actionError ? <p role="alert">{actionError}</p> : null}

          <div className="prejoin-actions">
            {isIdle ? (
              <button
                className="prejoin-primary-action"
                type="button"
                disabled={authorizationPending}
                onClick={handleCheckDevices}
              >
                카메라·마이크 켜기
                <ArrowIcon />
              </button>
            ) : (
              <button
                className="prejoin-primary-action"
                type="button"
                disabled={isChecking || hostCapabilityInvalid || authorizationPending}
                onClick={() => handleJoin(true)}
              >
                {hasAnyMedia ? '입장하기' : '카메라·마이크 없이 입장'}
                <ArrowIcon />
              </button>
            )}
            {isIdle || hasAnyMedia ? (
              <button
                className="prejoin-text-action"
                type="button"
                disabled={(!isIdle && isChecking) || hostCapabilityInvalid || authorizationPending}
                onClick={() => handleJoin(false)}
              >
                카메라·마이크 없이 입장
              </button>
            ) : null}
          </div>

          {showHostCapabilityInput ? (
            <div className="prejoin-host">
              <button
                className="prejoin-host__toggle"
                type="button"
                aria-expanded={hostFieldVisible}
                aria-controls="prejoin-host-field"
                disabled={hostCapabilityInvalid}
                onClick={() => setHostOpen((open) => !open)}
              >
                방장이신가요?
              </button>
              <label
                id="prejoin-host-field"
                className="prejoin-host-capability"
                hidden={!hostFieldVisible}
              >
                <span>방장 키</span>
                <input
                  type="password"
                  value={hostCapability}
                  minLength={MIN_HOST_CAPABILITY_LENGTH}
                  maxLength={MAX_HOST_CAPABILITY_LENGTH}
                  autoComplete="off"
                  aria-describedby="prejoin-host-capability-help"
                  aria-invalid={hostCapabilityInvalid}
                  onChange={(event) => setHostCapability(event.target.value)}
                />
                <small id="prejoin-host-capability-help">
                  {hostCapabilityInvalid
                    ? `방장 키는 ${MIN_HOST_CAPABILITY_LENGTH}자 이상이어야 합니다.`
                    : '운영자에게 받은 키를 입력하면 타이머와 참여자 관리를 쓸 수 있습니다.'}
                </small>
              </label>
            </div>
          ) : null}

          <button className="prejoin-back-action" type="button" onClick={handleBack}>
            {backLabel}
          </button>
        </section>
      </main>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { RoomStudySnapshot, StudyCommand, StudyMode } from '@round/rtc-core';
import { setDocumentTitleNotice } from '../lib/document-title';
import { useTimerChime } from '../lib/use-timer-chime';
import { useTimerNotifications } from '../lib/use-timer-notifications';
import { TimerChangeDialog } from './TimerChangeDialog';

// 방장이 자주 쓰는 길이는 고르기만 하면 되고, 그 밖의 길이는 직접 입력한다.
const TIMER_PRESETS = [
  { id: 'focus-25', mode: 'focus', minutes: '25', title: '집중 25분' },
  { id: 'focus-50', mode: 'focus', minutes: '50', title: '집중 50분' },
  { id: 'break-5', mode: 'break', minutes: '5', title: '휴식 5분' },
] as const satisfies readonly { id: string; mode: StudyMode; minutes: string; title: string }[];
type TimerPreset = (typeof TIMER_PRESETS)[number]['id'] | 'custom';

interface RoomStudyPanelProps {
  state: RoomStudySnapshot | null;
  canControl: boolean;
  hostPresent: boolean;
  active: boolean;
  pending: boolean;
  notice: string | null;
  onCommand: (command: StudyCommand, expectedRevision?: number) => boolean;
  onSync: () => void;
}

export function RoomStudyPanel({
  state,
  canControl,
  hostPresent,
  active,
  pending,
  notice,
  onCommand,
  onSync,
}: RoomStudyPanelProps) {
  const [now, setNow] = useState(() => performance.now());
  const [topic, setTopic] = useState('');
  const [preset, setPreset] = useState<TimerPreset>('focus-25');
  const [mode, setMode] = useState<StudyMode>('focus');
  const [minutes, setMinutes] = useState('25');
  const [error, setError] = useState('');
  const [completion, setCompletion] = useState('');
  // 휴식이 끝나면 방에서 마지막으로 진행한 집중 시간을 다시 제안한다.
  const [lastFocusSeconds, setLastFocusSeconds] = useState(25 * 60);
  useEffect(() => {
    if (state?.mode === 'focus') setLastFocusSeconds(state.durationSeconds);
  }, [state?.mode, state?.durationSeconds]);
  const chime = useTimerChime();
  const { play: playChime } = chime;
  const desktopNotification = useTimerNotifications();
  const { notify, close: closeNotification } = desktopNotification;
  useEffect(() => {
    if (!completion || !active) closeNotification();
  }, [completion, active, closeNotification]);
  const [pendingChange, setPendingChange] = useState<{
    command: StudyCommand;
    revision: number;
    description: string;
  } | null>(null);
  const changeConfirmed = useRef(false);
  const regionRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // 더보기 메뉴처럼 바깥을 누르면 설정 창을 닫는다. 변경 확인창과 종료 안내는 같은 영역에 있다.
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel?.open && event.target instanceof Node && !regionRef.current?.contains(event.target))
        panel.open = false;
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);
  useEffect(() => {
    if (!pendingChange) return;
    if (!active || !canControl || pending || state?.revision !== pendingChange.revision) {
      setPendingChange(null);
      setError('타이머 상태가 변경되었습니다. 최신 시간을 확인한 뒤 다시 선택해 주세요.');
    }
  }, [active, canControl, pending, state?.revision, pendingChange]);
  const armed = useRef(false);
  const completedRevision = useRef<number | null>(null);
  const confirmationRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!completion) return;
    setDocumentTitleNotice(completion);
    return () => setDocumentTitleNotice(null);
  }, [completion]);
  useEffect(() => {
    setTopic(state?.topic ?? '');
  }, [state?.topic]);
  useEffect(() => {
    setNow(performance.now());
    if (!state?.running) return;
    const tick = () => {
      const current = performance.now();
      if (!document.hidden || current >= state.sampledAt + state.remainingMs) setNow(current);
      if (current >= state.sampledAt + state.remainingMs) clearInterval(timer);
    };
    const timer = setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [state?.running, state?.sampledAt]);
  const remaining = state
    ? Math.max(0, state.remainingMs - (state.running ? Math.max(0, now - state.sampledAt) : 0))
    : 0;
  const seconds = Math.ceil(remaining / 1000);
  const progress =
    state && state.durationSeconds > 0
      ? Math.min(100, Math.max(0, 100 - remaining / (state.durationSeconds * 10)))
      : 0;
  useEffect(() => {
    if (!state) {
      armed.current = false;
      completedRevision.current = null;
      confirmationRevision.current = null;
      setCompletion('');
      return;
    }
    if (!active) {
      armed.current = false;
      return;
    }
    if (remaining > 0) confirmationRevision.current = null;
    if (
      remaining > 0 &&
      completedRevision.current !== null &&
      state.revision > completedRevision.current
    ) {
      completedRevision.current = null;
      setCompletion('');
    }
    if (state.running && remaining > 0 && completedRevision.current === null) armed.current = true;
    if (remaining === 0 && armed.current && completedRevision.current === null) {
      // 화면에 0초가 표시되면 서버에 다시 조회하고, 완료 응답을 받은 뒤 종료를 알린다.
      if (state.running) {
        if (confirmationRevision.current !== state.revision) {
          confirmationRevision.current = state.revision;
          onSync();
        }
        return;
      }
      armed.current = false;
      completedRevision.current = state.revision;
      const message = `${state.mode === 'break' ? '휴식' : '집중'} 시간이 끝났습니다`;
      setCompletion(message);
      notify(message);
      playChime();
    }
  }, [state, active, remaining, onSync, notify, playChime]);
  const label = !state
    ? '불러오는 중'
    : remaining === 0
      ? state.running
        ? '종료 확인 중'
        : '완료'
      : state.running
        ? '진행 중'
        : '정지';
  const disabled = !active || pending || !state;
  // 명령 응답까지 조작을 잠가 누른 버튼에서 초점이 빠질 수 있다(Chromium). 응답 뒤 초점이 사라졌으면
  // 누른 조작으로 돌려주고, 누른 버튼이 사라지는 경우에는 타이머 요약으로 돌려준다.
  const commandFocus = useRef<HTMLElement | null>(null);
  const rememberCommandFocus = (target?: HTMLElement | null) => {
    const focused = document.activeElement;
    commandFocus.current =
      focused instanceof HTMLElement && regionRef.current?.contains(focused)
        ? (target ?? focused)
        : null;
  };
  useEffect(() => {
    if (pending) return;
    const target = commandFocus.current;
    commandFocus.current = null;
    const focused = document.activeElement;
    if (target?.isConnected && (focused === null || focused === document.body)) target.focus();
  }, [pending]);
  const command = (value: StudyCommand, expectedRevision?: number) => {
    const sent = onCommand(value, expectedRevision);
    if (!sent) commandFocus.current = null;
    setError(
      sent ? '' : '타이머나 주제를 변경하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.',
    );
  };
  const requestTimerChange = (value: StudyCommand) => {
    if (disabled || !canControl || !state) return;
    rememberCommandFocus();
    setError('');
    const hasProgress =
      state.running || (remaining > 0 && remaining < state.durationSeconds * 1000);
    if (!hasProgress) {
      command(value);
      return;
    }
    changeConfirmed.current = false;
    setPendingChange({
      command: value,
      revision: state.revision,
      description:
        value.action === 'start'
          ? `${value.mode === 'focus' ? '집중' : '휴식'} ${value.durationSeconds / 60}분 타이머를 새로 시작합니다.`
          : `현재 타이머를 ${state.durationSeconds / 60}분으로 되돌리고 정지합니다.`,
    });
  };
  // 서버가 종료를 확인한 타이머는 진행 시간이 없으므로 확인 없이 다음 집중·휴식을 시작한다.
  const nextTimer: Extract<StudyCommand, { action: 'start' }> | null =
    state === null
      ? null
      : state.mode === 'focus'
        ? { action: 'start', mode: 'break', durationSeconds: 5 * 60 }
        : { action: 'start', mode: 'focus', durationSeconds: lastFocusSeconds };
  const startNextTimer = () => {
    if (nextTimer === null || disabled || !canControl) return;
    rememberCommandFocus(panelRef.current?.querySelector('summary'));
    if (onCommand(nextTimer)) {
      setError('');
      setCompletion('');
    } else {
      commandFocus.current = null;
      setError('타이머나 주제를 변경하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
    }
  };
  const confirmTimerChange = () => {
    if (!pendingChange || changeConfirmed.current) return;
    changeConfirmed.current = true;
    setPendingChange(null);
    if (disabled || !canControl || state?.revision !== pendingChange.revision) {
      setError('타이머 상태가 변경되었습니다. 최신 시간을 확인한 뒤 다시 선택해 주세요.');
      return;
    }
    command(pendingChange.command, pendingChange.revision);
  };
  return (
    <div className="room-study-region" ref={regionRef}>
      <details
        ref={panelRef}
        className="room-study"
        data-mode={state?.mode ?? 'focus'}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || !event.currentTarget.open)
            return;
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }}
      >
        <summary>
          <span className="room-study__mode">
            {state?.mode === 'break' ? '휴식' : '집중'}
            <span className="sr-only"> 타이머</span>
            {/* 진행 중일 때는 숫자가 줄어드는 것으로 충분하므로 상태 글자는 화면 낭독기에만 읽힌다. */}
            <span className={label === '진행 중' ? 'sr-only' : 'room-study__state'}>
              {' '}
              · {label}
            </span>
          </span>
          <time>
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:
            {String(seconds % 60).padStart(2, '0')}
          </time>
          {state?.topic ? <strong>{state.topic}</strong> : null}
          {active && !hostPresent ? (
            <span className="room-study__host-absent">방장 없음</span>
          ) : null}
          <span className="room-study__open" aria-hidden="true">
            {canControl ? '타이머 설정' : '알림 설정'}
          </span>
          <span className="room-study__progress" aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </span>
        </summary>
        <div className="room-study__body">
          {active && !hostPresent ? (
            <p className="room-study__host-notice" role="status">
              현재 방장이 없어 타이머와 주제를 변경할 수 없습니다. 진행 중인 타이머는 계속됩니다.
            </p>
          ) : null}
          <div className="room-study__status">
            <p role="status">
              {active
                ? `${state?.mode === 'break' ? '휴식' : '집중'} ${label}`
                : '다시 연결되면 타이머와 주제를 불러옵니다.'}
            </p>
            <p className="room-study__topic">
              현재 주제: {state?.topic || '설정된 주제가 없습니다.'}
            </p>
          </div>
          {canControl ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  rememberCommandFocus();
                  command({ action: 'topic', topic: topic.trim() });
                }}
              >
                <label>
                  현재 주제
                  <input
                    value={topic}
                    maxLength={120}
                    disabled={disabled}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="예: 3장 코드 리뷰"
                  />
                </label>
                <button disabled={disabled || topic.trim() === state?.topic}>주제 저장</button>
              </form>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const duration = Number(minutes);
                  if (Number.isInteger(duration) && duration >= 1 && duration <= 120)
                    requestTimerChange({ action: 'start', mode, durationSeconds: duration * 60 });
                }}
              >
                <fieldset className="room-study__presets" disabled={disabled}>
                  <legend>시간</legend>
                  {[...TIMER_PRESETS, { id: 'custom' as const, title: '직접 입력' }].map(
                    (option) => (
                      <label key={option.id}>
                        <input
                          type="radio"
                          name="room-study-preset"
                          checked={preset === option.id}
                          onChange={() => {
                            setPreset(option.id);
                            if (option.id === 'custom') return;
                            setMode(option.mode);
                            setMinutes(option.minutes);
                          }}
                        />
                        {option.title}
                      </label>
                    ),
                  )}
                </fieldset>
                {preset === 'custom' ? (
                  <div className="room-study__custom">
                    <label>
                      타이머 종류
                      <select
                        value={mode}
                        disabled={disabled}
                        onChange={(event) => {
                          const next = event.target.value as StudyMode;
                          setMode(next);
                          setMinutes(next === 'focus' ? '25' : '5');
                        }}
                      >
                        <option value="focus">집중</option>
                        <option value="break">휴식</option>
                      </select>
                    </label>
                    <label>
                      시간(분)
                      <input
                        type="number"
                        min={1}
                        max={120}
                        step={1}
                        required
                        value={minutes}
                        disabled={disabled}
                        onChange={(event) => setMinutes(event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
                <button className="room-study__primary" disabled={disabled}>
                  {state?.running
                    ? '새 타이머 시작'
                    : `${mode === 'focus' ? '집중' : '휴식'} ${minutes}분 시작`}
                </button>
              </form>
              <div className="room-study__actions">
                <button
                  disabled={disabled || remaining === 0}
                  onClick={() => {
                    rememberCommandFocus();
                    command({ action: state?.running ? 'pause' : 'resume' });
                  }}
                >
                  {state?.running ? '일시정지' : '이어서 시작'}
                </button>
                <button disabled={disabled} onClick={() => requestTimerChange({ action: 'reset' })}>
                  초기화
                </button>
              </div>
            </>
          ) : (
            <p>타이머와 주제는 방장이 변경할 수 있습니다.</p>
          )}
          <fieldset className="room-study__alerts">
            <legend>내 종료 알림</legend>
            <label className="room-study__sound">
              <input type="checkbox" checked={chime.enabled} onChange={chime.toggle} />
              종료 알림음 · 기기 기본 스피커
            </label>
            {chime.notice ? <p role="status">{chime.notice}</p> : null}
            {desktopNotification.supported ? (
              <label className="room-study__sound">
                <input
                  type="checkbox"
                  checked={desktopNotification.enabled}
                  disabled={desktopNotification.pending}
                  onChange={() => void desktopNotification.toggle()}
                />
                종료 데스크톱 알림 · 다른 창 사용 중
              </label>
            ) : null}
            {desktopNotification.notice ? <p role="status">{desktopNotification.notice}</p> : null}
          </fieldset>
          <div className="room-study__footer">
            <button className="room-study__sync" type="button" disabled={!active} onClick={onSync}>
              타이머·주제 다시 불러오기
            </button>
            <small>
              방장이 나가도 계속 진행됩니다. 모두 퇴장하거나 서버가 재시작되면 초기화됩니다.
            </small>
          </div>
          {notice || error ? <p role="alert">{notice || error}</p> : null}
        </div>
      </details>
      {pendingChange ? (
        <TimerChangeDialog
          remainingSeconds={seconds}
          description={pendingChange.description}
          onCancel={() => setPendingChange(null)}
          onConfirm={confirmTimerChange}
        />
      ) : null}
      {completion ? (
        <aside className="room-study-completion" aria-label="타이머 종료 알림">
          <p role="status">{completion}.</p>
          {canControl && error ? <p role="alert">{error}</p> : null}
          <div className="room-study-completion__actions">
            {canControl && nextTimer !== null ? (
              <button
                className="room-study-completion__next"
                type="button"
                disabled={disabled}
                onClick={startNextTimer}
              >
                {`${nextTimer.mode === 'focus' ? '집중' : '휴식'} ${nextTimer.durationSeconds / 60}분 시작`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={(event) => {
                // 안내를 닫으면 누른 버튼이 사라지므로 키보드 초점을 타이머 요약으로 옮긴다.
                const returnFocus = document.activeElement === event.currentTarget;
                setCompletion('');
                if (returnFocus) panelRef.current?.querySelector('summary')?.focus();
              }}
            >
              확인
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

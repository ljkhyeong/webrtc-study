import { useEffect, useRef, useState } from 'react';
import type { RoomStudySnapshot, StudyCommand, StudyMode } from '@round/rtc-core';
import { createTimerChime } from '../lib/timer-chime';
import { useTimerNotifications } from '../lib/use-timer-notifications';
import { TimerChangeDialog } from './TimerChangeDialog';

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
  const [mode, setMode] = useState<StudyMode>('focus');
  const [minutes, setMinutes] = useState('25');
  const [error, setError] = useState('');
  const [completion, setCompletion] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundNotice, setSoundNotice] = useState('');
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
  useEffect(() => {
    if (!pendingChange) return;
    if (!active || !canControl || pending || state?.revision !== pendingChange.revision) {
      setPendingChange(null);
      setError('타이머 상태가 변경되었습니다. 최신 시간을 확인한 뒤 다시 선택해 주세요.');
    }
  }, [active, canControl, pending, state?.revision, pendingChange]);
  const chime = useRef<ReturnType<typeof createTimerChime> | null>(null);
  const armed = useRef(false);
  const completedRevision = useRef<number | null>(null);
  const confirmationRevision = useRef<number | null>(null);
  useEffect(
    () => () => {
      chime.current?.close();
      chime.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!completion) return;
    const previous = document.title;
    const title = `${completion} · ROUND`;
    document.title = title;
    return () => {
      if (document.title === title) document.title = previous;
    };
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
      if (chime.current) {
        try {
          if (!chime.current.play())
            setSoundNotice('브라우저에서 소리가 중단되었습니다. 알림음을 다시 켜 주세요.');
        } catch {
          setSoundNotice('알림음을 재생하지 못했습니다. 기기의 소리 설정을 확인해 주세요.');
        }
      }
    }
  }, [state, active, remaining, onSync, notify]);
  const toggleSound = () => {
    setSoundNotice('');
    if (chime.current) {
      chime.current.close();
      chime.current = null;
      setSoundEnabled(false);
      return;
    }
    try {
      const next = createTimerChime();
      chime.current = next;
      setSoundEnabled(true);
      void next.ready.catch(() => {
        if (chime.current !== next) return;
        next.close();
        chime.current = null;
        setSoundEnabled(false);
        setSoundNotice('알림음을 켜지 못했습니다. 브라우저의 소리 설정을 확인해 주세요.');
      });
    } catch {
      setSoundNotice('이 브라우저에서는 알림음을 켤 수 없습니다.');
    }
  };
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
  const command = (value: StudyCommand, expectedRevision?: number) => {
    setError(
      onCommand(value, expectedRevision)
        ? ''
        : '타이머나 주제를 변경하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.',
    );
  };
  const requestTimerChange = (value: StudyCommand) => {
    if (disabled || !canControl || !state) return;
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
    <div className="room-study-region">
      <details className="room-study">
        <summary>
          <span>{state?.mode === 'break' ? '휴식' : '집중'} 타이머</span>
          <time>
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:
            {String(seconds % 60).padStart(2, '0')}
          </time>
          <span>{label}</span>
          {active && !hostPresent ? (
            <span className="room-study__host-absent">방장 없음</span>
          ) : null}
          <strong>{state?.topic || '주제 없음'}</strong>
        </summary>
        <div className="room-study__body">
          {active && !hostPresent ? (
            <p className="room-study__host-notice" role="status">
              현재 방장이 없어 타이머와 주제를 변경할 수 없습니다. 진행 중인 타이머는 계속됩니다.
            </p>
          ) : null}
          <p className="room-study__topic">
            현재 주제: {state?.topic || '설정된 주제가 없습니다.'}
          </p>
          <label className="room-study__sound">
            <input type="checkbox" checked={soundEnabled} onChange={toggleSound} />
            종료 알림음 · 기기 기본 스피커
          </label>
          {soundNotice ? <p role="status">{soundNotice}</p> : null}
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
          <p role="status">
            {active
              ? `${state?.mode === 'break' ? '휴식' : '집중'} ${label}`
              : '다시 연결되면 타이머와 주제를 불러옵니다.'}
          </p>
          {canControl ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
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
                <button disabled={disabled}>{state?.running ? '새 타이머 시작' : '시작'}</button>
              </form>
              <div className="room-study__actions">
                <button
                  disabled={disabled || remaining === 0}
                  onClick={() => command({ action: state?.running ? 'pause' : 'resume' })}
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
          <button type="button" disabled={!active} onClick={onSync}>
            타이머·주제 다시 불러오기
          </button>
          <small>
            방장이 나가도 계속 진행됩니다. 모두 퇴장하거나 서버가 재시작되면 초기화됩니다.
          </small>
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
          <button type="button" onClick={() => setCompletion('')}>
            확인
          </button>
        </aside>
      ) : null}
    </div>
  );
}

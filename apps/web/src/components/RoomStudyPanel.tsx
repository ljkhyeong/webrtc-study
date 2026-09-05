import { useEffect, useState } from 'react';
import type { RoomStudySnapshot, StudyCommand, StudyMode } from '@round/rtc-core';

interface RoomStudyPanelProps {
  state: RoomStudySnapshot | null;
  canControl: boolean;
  active: boolean;
  pending: boolean;
  notice: string | null;
  onCommand: (command: StudyCommand) => boolean;
  onSync: () => void;
}

export function RoomStudyPanel({
  state,
  canControl,
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
  useEffect(() => {
    setTopic(state?.topic ?? '');
  }, [state?.topic]);
  useEffect(() => {
    setNow(performance.now());
    if (!state?.running) return;
    const tick = () => {
      if (!document.hidden) setNow(performance.now());
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
  const label = !state
    ? '불러오는 중'
    : remaining === 0
      ? '완료'
      : state.running
        ? '진행 중'
        : '대기·일시정지';
  const disabled = !active || pending || !state;
  const command = (value: StudyCommand) => {
    setError(onCommand(value) ? '' : '요청을 보내지 못했습니다. 방 연결 상태를 확인해 주세요.');
  };
  return (
    <details className="room-study">
      <summary>
        <span>{state?.mode === 'break' ? '휴식' : '집중'} 타이머</span>
        <time>
          {String(Math.floor(seconds / 60)).padStart(2, '0')}:
          {String(seconds % 60).padStart(2, '0')}
        </time>
        <span>{label}</span>
        <strong>{state?.topic || '현재 주제를 설정해 보세요'}</strong>
      </summary>
      <div className="room-study__body">
        <p className="room-study__topic">현재 주제: {state?.topic || '설정된 주제가 없습니다.'}</p>
        <p role="status">
          {active
            ? `${state?.mode === 'break' ? '휴식' : '집중'} ${label}`
            : '서버 연결 복구 후 최신 진행 상태를 확인합니다.'}
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
                  command({ action: 'start', mode, durationSeconds: duration * 60 });
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
              <button disabled={disabled} onClick={() => command({ action: 'reset' })}>
                초기화
              </button>
            </div>
          </>
        ) : (
          <p>타이머와 주제는 방장이 변경할 수 있습니다.</p>
        )}
        <button type="button" disabled={!active} onClick={onSync}>
          진행 상태 새로고침
        </button>
        <small>
          방장이 나가도 계속 진행됩니다. 모두 퇴장하거나 서버가 재시작되면 초기화됩니다.
        </small>
        {notice || error ? <p role="alert">{notice || error}</p> : null}
      </div>
    </details>
  );
}

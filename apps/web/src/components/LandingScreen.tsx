import { useState, type FormEvent } from 'react';
import { ArrowIcon, CameraIcon, MessageIcon, MicIcon } from './Icons';
import {
  createRoomId,
  DISPLAY_NAME_MAX_LENGTH,
  isValidRoomId,
  normalizeRoomId,
  sanitizeDisplayName,
} from '../lib/room';

interface LandingScreenProps {
  initialDisplayName: string;
  onEnter: (displayName: string, roomId: string) => void;
  onGoHome?: () => void;
}

export function LandingScreen({ initialDisplayName, onEnter, onGoHome }: LandingScreenProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState('');

  const enterRoom = (targetRoomId: string) => {
    const safeName = sanitizeDisplayName(displayName);
    if (!safeName) {
      setError('스터디에서 사용할 이름을 입력해 주세요.');
      return;
    }

    if (!isValidRoomId(targetRoomId)) {
      setError('초대 코드 12자리를 확인해 주세요.');
      return;
    }

    setError('');
    onEnter(safeName, targetRoomId);
  };

  const handleCreate = () => {
    enterRoom(createRoomId());
  };

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    enterRoom(roomId);
  };

  return (
    <div className="landing-shell">
      <header className="landing-header">
        <button className="wordmark wordmark--button" type="button" onClick={onGoHome}>
          ROUND
          <span>study room</span>
        </button>
        <p className="landing-header__note">
          <span className="status-dot" />
          직접 연결 · 최대 6명
        </p>
      </header>

      <main className="landing-main">
        <section className="landing-copy" aria-labelledby="landing-title">
          <p className="eyebrow">Private study room</p>
          <h1 id="landing-title">
            <span>
              같이 공부할
              <br className="mobile-break" /> 사람만,
            </span>
            <br />
            <em>시간 제한 없이.</em>
          </h1>
          <p className="landing-description">
            설치 없이 링크 하나로 만나세요. 영상과 음성은 참가자끼리 직접 연결됩니다.
          </p>

          <form className="entry-form" onSubmit={handleJoin}>
            <label className="field-label" htmlFor="display-name">
              내 이름
            </label>
            <input
              id="display-name"
              autoComplete="name"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              placeholder="예: 림"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />

            <button className="primary-action" type="button" onClick={handleCreate}>
              새 스터디룸 만들기
              <ArrowIcon />
            </button>

            <div className="join-divider">
              <span>또는 초대 코드로 참가</span>
            </div>

            <div className="join-row">
              <input
                aria-label="초대 코드"
                inputMode="text"
                placeholder="abcd-efgh-jkmp"
                value={roomId}
                onChange={(event) => setRoomId(normalizeRoomId(event.target.value))}
              />
              <button type="submit" disabled={!isValidRoomId(roomId)}>
                입장 준비
              </button>
            </div>

            <p className="form-error" role="alert" aria-live="polite">
              {error}
            </p>
          </form>
        </section>

        <section className="landing-visual" aria-label="ROUND 기능 미리보기">
          <div className="orbit orbit--outer" />
          <div className="orbit orbit--inner" />
          <div className="study-table">
            <span>ROUND</span>
            <strong>집중할 준비가 되면 시작하세요</strong>
          </div>
          <div className="feature-marker feature-marker--video">
            <CameraIcon />
            <span>video</span>
          </div>
          <div className="feature-marker feature-marker--audio">
            <MicIcon />
            <span>voice</span>
          </div>
          <div className="feature-marker feature-marker--chat">
            <MessageIcon />
            <span>chat</span>
          </div>
          <div className="presence presence--one">
            <span>나</span>
          </div>
          <div className="presence presence--two">
            <span>스터디원</span>
          </div>
          <div className="presence presence--three">
            <span>스터디원</span>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <p>카메라와 마이크 권한은 ‘장치 확인’을 누를 때만 요청합니다.</p>
        <p>01 — create · 02 — share · 03 — study</p>
      </footer>
    </div>
  );
}

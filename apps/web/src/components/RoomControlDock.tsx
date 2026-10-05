import type { RefObject } from 'react';
import {
  CameraIcon,
  CameraOffIcon,
  HandIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
} from './Icons';

interface RoomControlDockProps {
  readonly active: boolean;
  readonly audioAvailable: boolean;
  readonly audioEnabled: boolean;
  readonly videoAvailable: boolean;
  readonly videoEnabled: boolean;
  readonly screenShareAvailable: boolean;
  readonly screenSharing: boolean;
  readonly screenSharePending: 'starting' | 'stopping' | null;
  readonly handRaised: boolean;
  readonly handCount: number;
  readonly chatOpen: boolean;
  readonly unreadMessageCount: number;
  readonly unseenDeliveryIssueCount: number;
  readonly chatButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onToggleAudio: () => void;
  readonly onToggleVideo: () => void;
  readonly onToggleScreenShare: () => void;
  readonly onSetHandRaised: (raised: boolean) => void;
  readonly onSelectDevices: () => void;
  readonly onToggleChat: () => void;
  readonly onLeave: () => void;
}

// 작은 배지는 두 글자까지만 보여 주므로 10 이상은 9+로 줄인다.
export const badgeCount = (count: number) => (count > 9 ? '9+' : String(count));

// 하단 조작부. 버튼 이름은 화면 낭독기용 aria-label과 설명 풍선으로 제공하고 상태에 따라 바꾼다.
export function RoomControlDock({
  active,
  audioAvailable,
  audioEnabled,
  videoAvailable,
  videoEnabled,
  screenShareAvailable,
  screenSharing,
  screenSharePending,
  handRaised,
  handCount,
  chatOpen,
  unreadMessageCount,
  unseenDeliveryIssueCount,
  chatButtonRef,
  onToggleAudio,
  onToggleVideo,
  onToggleScreenShare,
  onSetHandRaised,
  onSelectDevices,
  onToggleChat,
  onLeave,
}: RoomControlDockProps) {
  const chatNotificationCount = unreadMessageCount + unseenDeliveryIssueCount;
  const chatButtonLabel = chatOpen
    ? '채팅 닫기'
    : `채팅 열기${unreadMessageCount > 0 ? `, 새 메시지 ${unreadMessageCount}개` : ''}${
        unseenDeliveryIssueCount > 0 ? `, 수신 미확인 메시지 ${unseenDeliveryIssueCount}개` : ''
      }`;
  return (
    <footer className="control-dock" aria-label="통화 제어">
      <button
        className={`control-button${audioEnabled ? '' : ' control-button--off'}`}
        type="button"
        disabled={!audioAvailable && !active}
        aria-label={
          !audioAvailable
            ? active
              ? '마이크 장치 다시 선택'
              : '사용 가능한 마이크 없음'
            : audioEnabled
              ? '마이크 끄기'
              : '마이크 켜기'
        }
        onClick={audioAvailable ? onToggleAudio : onSelectDevices}
        aria-keyshortcuts="Alt+Shift+M"
        title="마이크 전환: Alt+Shift+M"
      >
        {audioEnabled ? <MicIcon /> : <MicOffIcon />}
        <span>{!audioAvailable ? '마이크 연결' : audioEnabled ? '마이크' : '음소거'}</span>
      </button>
      <button
        className={`control-button${videoEnabled ? '' : ' control-button--off'}`}
        type="button"
        disabled={screenSharePending !== null || screenSharing || (!videoAvailable && !active)}
        aria-label={
          screenSharePending === 'starting'
            ? '화면 공유를 준비하는 동안 카메라를 변경할 수 없습니다.'
            : screenSharePending === 'stopping'
              ? '화면 공유를 중지하는 동안 카메라를 변경할 수 없습니다.'
              : screenSharing
                ? '화면 공유 중에는 카메라를 변경할 수 없습니다.'
                : !videoAvailable
                  ? active
                    ? '카메라 장치 다시 선택'
                    : '사용 가능한 카메라 없음'
                  : videoEnabled
                    ? '카메라 끄기'
                    : '카메라 켜기'
        }
        onClick={videoAvailable ? onToggleVideo : onSelectDevices}
        aria-keyshortcuts="Alt+Shift+C"
        title="카메라 전환: Alt+Shift+C"
      >
        {videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
        <span>{!videoAvailable ? '카메라 선택' : videoEnabled ? '카메라' : '카메라 꺼짐'}</span>
      </button>
      <button
        className={`control-button${screenSharing ? ' control-button--active' : ''}`}
        type="button"
        disabled={screenSharePending !== null || !screenShareAvailable || !active}
        aria-label={
          screenSharePending === 'starting'
            ? '화면 공유 준비 중'
            : screenSharePending === 'stopping'
              ? '화면 공유 중지 중'
              : !screenShareAvailable
                ? '이 브라우저는 화면 공유를 지원하지 않습니다.'
                : screenSharing
                  ? '화면 공유 중지'
                  : '화면 공유 시작'
        }
        aria-pressed={screenSharing}
        onClick={onToggleScreenShare}
        title={screenSharing ? '화면 공유 중지' : '화면 공유'}
      >
        <ScreenShareIcon />
        <span>
          {screenSharePending === 'starting'
            ? '준비 중'
            : screenSharePending === 'stopping'
              ? '중지 중'
              : screenSharing
                ? '공유 중지'
                : '화면 공유'}
        </span>
      </button>
      <button
        className={`control-button${handRaised ? ' control-button--active' : ''}`}
        type="button"
        disabled={!active}
        aria-label={handRaised ? '손 내리기' : '손들기'}
        aria-pressed={handRaised}
        onClick={() => onSetHandRaised(!handRaised)}
        aria-keyshortcuts="Alt+Shift+H"
        title="손들기 전환: Alt+Shift+H"
      >
        <HandIcon />
        <span>{handRaised ? '손 내리기' : '손들기'}</span>
        {handCount > 0 ? <b>{badgeCount(handCount)}</b> : null}
      </button>
      <button
        ref={chatButtonRef}
        className={`control-button${chatOpen ? ' control-button--active' : ''}`}
        type="button"
        aria-label={chatButtonLabel}
        aria-expanded={chatOpen}
        onClick={onToggleChat}
        title="채팅"
      >
        <MessageIcon />
        <span>채팅</span>
        {chatNotificationCount > 0 ? <b>{badgeCount(chatNotificationCount)}</b> : null}
      </button>
      <button
        className="control-button control-button--leave"
        type="button"
        onClick={onLeave}
        title="나가기"
      >
        <PhoneOffIcon />
        <span>나가기</span>
      </button>
    </footer>
  );
}

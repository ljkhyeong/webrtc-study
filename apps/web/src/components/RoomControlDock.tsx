import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { RoomConnectionDiagnostics } from '@round/rtc-core';
import { ConnectionDiagnosticsPanel } from './ConnectionDiagnosticsPanel';
import {
  CameraIcon,
  CameraOffIcon,
  HandIcon,
  LeaveIcon,
  LinkIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  ScreenShareIcon,
  SlidersIcon,
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
  readonly onInvite: () => void;
  readonly onLeave: () => void;
  readonly diagnostics: {
    readonly connectionContextKey: string;
    readonly qualityVisible: boolean;
    readonly onSetQualityVisible?: ((visible: boolean) => void) | undefined;
    readonly onCollect: () => Promise<RoomConnectionDiagnostics>;
  };
}

// 작은 배지는 두 글자까지만 보여 주므로 10 이상은 9+로 줄인다.
export const badgeCount = (count: number) => (count > 9 ? '9+' : String(count));

// 하단 조작부. 버튼은 아이콘과 이름을 함께 보여 주고, 화면 낭독기용 이름(aria-label)은 상태에 따라 바꾼다.
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
  onInvite,
  onLeave,
  diagnostics,
}: RoomControlDockProps) {
  const screenShareLabel =
    screenSharePending === 'starting'
      ? '화면 공유 준비 중'
      : screenSharePending === 'stopping'
        ? '화면 공유 중지 중'
        : !screenShareAvailable
          ? '이 브라우저는 화면 공유를 지원하지 않습니다.'
          : screenSharing
            ? '화면 공유 중지'
            : '화면 공유 시작';
  const screenShareText =
    screenSharePending === 'starting'
      ? '준비 중'
      : screenSharePending === 'stopping'
        ? '중지 중'
        : screenSharing
          ? '공유 중지'
          : '화면 공유';
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
        <span>{!audioAvailable ? '마이크 연결' : audioEnabled ? '마이크' : '마이크 꺼짐'}</span>
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
        className={`control-button${handRaised ? ' control-button--active control-button--hand' : ''}`}
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
      {screenSharing || screenSharePending !== null ? (
        <button
          className="control-button control-button--active"
          type="button"
          disabled={screenSharePending !== null}
          aria-label={screenShareLabel}
          aria-pressed={screenSharing}
          onClick={onToggleScreenShare}
        >
          <ScreenShareIcon />
          <span>{screenShareText}</span>
        </button>
      ) : null}
      <RoomMoreMenu>
        {(close) => (
          <>
            <button
              className="more-menu__item"
              type="button"
              aria-label="초대 링크 보내기"
              onClick={() => {
                close();
                onInvite();
              }}
            >
              <LinkIcon />
              <span>
                <strong>초대 링크 보내기</strong>
                <small>링크나 QR 코드로 초대합니다.</small>
              </span>
            </button>
            <button
              className="more-menu__item"
              type="button"
              disabled={!active}
              aria-label="마이크·카메라 바꾸기"
              onClick={() => {
                close();
                onSelectDevices();
              }}
            >
              <SlidersIcon />
              <span>
                <strong>마이크·카메라 바꾸기</strong>
                <small>다른 장치로 바꾸거나 화질을 고릅니다.</small>
              </span>
            </button>
            <button
              className="more-menu__item"
              type="button"
              disabled={screenSharePending !== null || !screenShareAvailable || !active}
              aria-label={screenShareLabel}
              aria-pressed={screenSharing}
              onClick={() => {
                close();
                onToggleScreenShare();
              }}
            >
              <ScreenShareIcon />
              <span>
                <strong>{screenShareText}</strong>
                <small>
                  {screenShareAvailable
                    ? '내 화면을 함께 봅니다.'
                    : '이 브라우저에서는 화면 공유를 쓸 수 없습니다.'}
                </small>
              </span>
            </button>
            <ConnectionDiagnosticsPanel
              connectionContextKey={diagnostics.connectionContextKey}
              onCollect={diagnostics.onCollect}
              qualityVisible={diagnostics.qualityVisible}
              onSetQualityVisible={diagnostics.onSetQualityVisible}
            />
          </>
        )}
      </RoomMoreMenu>
      <button
        className="control-button control-button--leave"
        type="button"
        onClick={onLeave}
        title="나가기"
      >
        <LeaveIcon />
        <span>나가기</span>
      </button>
    </footer>
  );
}

// 자주 쓰지 않는 기능을 모은 메뉴. 바깥을 누르거나 Esc를 누르면 닫는다.
function RoomMoreMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (menuRef.current) menuRef.current.open = false;
  };
  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const menu = menuRef.current;
      // 모바일에서 메뉴 뒤에 깔리는 어두운 바탕(details 자신)을 눌러도 닫는다.
      if (
        menu?.open &&
        event.target instanceof Node &&
        (event.target === menu || !menu.contains(event.target))
      ) {
        menu.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);
  return (
    <details
      ref={menuRef}
      className="more-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menuRef.current?.open) return;
        event.stopPropagation();
        menuRef.current.open = false;
        menuRef.current.querySelector('summary')?.focus();
      }}
    >
      <summary className="control-button" aria-label="더보기: 초대, 장치, 화면 공유, 연결 진단">
        <MoreIcon />
        <span>더보기</span>
      </summary>
      <div className="more-menu__panel">
        {children(close)}
        <button
          className="more-menu__close"
          type="button"
          onClick={() => {
            close();
            menuRef.current?.querySelector('summary')?.focus();
          }}
        >
          닫기
        </button>
      </div>
    </details>
  );
}

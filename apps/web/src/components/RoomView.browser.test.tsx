// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomView } from './RoomView';
import type { LeaveGuard } from '../lib/use-room-navigation';
import { useRoomNavigation } from '../lib/use-room-navigation';

function roomViewProps(): Parameters<typeof RoomView>[0] {
  return {
    roomId: 'abcd-efgh-jkmp',
    status: 'active',
    statusLabel: '통화 연결됨',
    participants: [],
    messages: [],
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
    screenShareAvailable: false,
    screenSharing: false,
    canModerateMedia: false,
    onToggleAudio: vi.fn(),
    onToggleVideo: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onSetHandRaised: vi.fn(),
    onDisableParticipantAudio: vi.fn(),
    onDisableParticipantVideo: vi.fn(),
    onSendMessage: vi.fn(() => true),
    onCollectConnectionDiagnostics: vi.fn(async () => ({
      status: 'active' as const,
      connections: [],
    })),
    onSelectDevices: vi.fn(),
    onReconnect: vi.fn(),
    onLeave: vi.fn(),
  };
}

describe('RoomView 브라우저 동작', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    window.history.replaceState({}, '', '/room/abcd-efgh-jkmp?source=invite#chat');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });

  it('작성 중인 채팅의 퇴장을 확인하고 취소하면 입력을 유지하며 보낸 뒤에는 바로 나간다', () => {
    const props = roomViewProps();
    act(() => root.render(<RoomView {...props} />));
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '아직 작성 중인 질문',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('.control-button--leave')!.click());
    expect(props.onLeave).not.toHaveBeenCalled();
    const cancel = container.querySelector<HTMLButtonElement>('dialog button')!;
    act(() => cancel.click());
    expect(container.querySelector('dialog')).toBeNull();
    expect(textarea.value).toBe('아직 작성 중인 질문');
    act(() =>
      textarea.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('.control-button--leave')!.click());
    expect(props.onLeave).toHaveBeenCalledOnce();
  });

  it('뒤로가기 확인 결과를 이동 처리에 넘기고 확인 중 방이 닫히면 이동도 취소한다', async () => {
    const props = roomViewProps();
    let guard: LeaveGuard | null = null;
    const registerLeaveGuard = (next: LeaveGuard | null) => {
      guard = next;
    };
    act(() =>
      root.render(<RoomView {...props} screenSharing registerLeaveGuard={registerLeaveGuard} />),
    );
    let decision: boolean | Promise<boolean> = false;
    act(() => {
      decision = guard!();
    });
    expect(container.querySelector('dialog')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('dialog button')!.click());
    await expect(decision).resolves.toBe(false);
    act(() => {
      decision = guard!();
    });
    act(() => container.querySelector<HTMLButtonElement>('dialog button:last-child')!.click());
    await expect(decision).resolves.toBe(true);
    expect(props.onLeave).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <RoomView key="다른 방" {...props} screenSharing registerLeaveGuard={registerLeaveGuard} />,
      ),
    );
    act(() => {
      decision = guard!();
    });
    act(() => root.render(null));
    await expect(decision).resolves.toBe(false);
    expect(guard).toBeNull();
  });

  it('실제 경로 처리와 연결해 뒤로가기를 취소하면 같은 채팅 입력과 방 화면을 유지한다', async () => {
    const props = roomViewProps();
    window.history.replaceState({}, '', '/');
    function RoutedRoom() {
      const navigation = useRoomNavigation();
      return navigation.pathname === '/' ? (
        <button onClick={() => navigation.navigate('/room/abcd-efgh-jkmp')}>입장</button>
      ) : (
        <RoomView {...props} registerLeaveGuard={navigation.registerLeaveGuard} />
      );
    }
    act(() =>
      root.render(
        <StrictMode>
          <RoutedRoom />
        </StrictMode>,
      ),
    );
    act(() => container.querySelector('button')!.click());
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '뒤로가기 보호',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      window.history.back();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('dialog')).not.toBeNull();
        expect(window.location.pathname).toBe('/room/abcd-efgh-jkmp');
      });
    });
    act(() => container.querySelector<HTMLButtonElement>('dialog button')!.click());
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('뒤로가기 보호');
    expect(props.onLeave).not.toHaveBeenCalled();
  });

  it('화면 공유 중 확인한 뒤에만 나가며 서버의 손들기 순서를 목록과 배지에 표시한다', () => {
    const props = roomViewProps();
    const participants = ['a', 'b'].map((peerId) => ({
      peerId,
      displayName: peerId === 'a' ? '가온' : '나래',
      role: 'participant' as const,
      isLocal: peerId === 'a',
      connectionState: 'connected' as const,
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera' as const,
      handRaised: true,
    }));
    act(() =>
      root.render(
        <RoomView
          {...props}
          screenSharing
          participants={participants}
          handQueue={{ revision: 2, peerIds: ['b', 'a'], supportedPeerIds: ['a', 'b'] }}
        />,
      ),
    );
    expect(
      [...container.querySelectorAll('.room-hand-queue li')].map((el) => el.textContent),
    ).toEqual(['나래', '가온 (나)']);
    expect(container.querySelector('[aria-label="나래 손들기"]')?.textContent).toContain('1번');
    act(() => container.querySelector<HTMLButtonElement>('.control-button--leave')!.click());
    expect(props.onLeave).not.toHaveBeenCalled();
    expect(container.querySelector('dialog')?.textContent).toContain('화면 공유와 통화가 종료');
    act(() => container.querySelector<HTMLButtonElement>('dialog button:last-child')!.click());
    expect(props.onLeave).toHaveBeenCalledOnce();
  });

  it('손들기 버튼과 참가자 배지를 갱신하고 재연결 중에는 조작을 막는다', () => {
    const props = roomViewProps();
    const participant = {
      peerId: 'self',
      displayName: '가온',
      role: 'participant' as const,
      isLocal: true,
      connectionState: 'connected' as const,
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera' as const,
      handRaised: false,
    };
    act(() => root.render(<RoomView {...props} participants={[participant]} />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="손들기"]')!.click());
    expect(props.onSetHandRaised).toHaveBeenLastCalledWith(true);
    act(() =>
      root.render(<RoomView {...props} participants={[{ ...participant, handRaised: true }]} />),
    );
    expect(container.querySelector('[aria-label="가온 손들기"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="손 내리기"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="손 내리기"]')!.click(),
    );
    expect(props.onSetHandRaised).toHaveBeenLastCalledWith(false);
    act(() =>
      root.render(<RoomView {...props} participants={[participant]} status="reconnecting" />),
    );
    expect(container.querySelector('[aria-label="가온 손들기"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="손들기"]')!.disabled,
    ).toBe(true);
  });

  it.each(['공유 종료', '퇴장'] as const)(
    '%s 시 고정을 해제하고 영상 요소는 고정 중에도 유지한다',
    async (change) => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const props = roomViewProps();
      const participant = {
        peerId: 'presenter',
        displayName: '발표자',
        role: 'participant' as const,
        isLocal: false,
        handRaised: false,
        connectionState: 'connected' as const,
        audioEnabled: true,
        videoEnabled: true,
        videoSource: 'screen' as const,
        stream: {} as MediaStream,
      };
      await act(async () => root.render(<RoomView {...props} participants={[participant]} />));
      const video = container.querySelector('video');
      const stage = container.querySelector<HTMLElement>('.video-stage')!;
      stage.scrollTop = 300;
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="발표자의 화면 공유 크게 고정"]')!
          .click(),
      );
      expect(stage.classList.contains('video-stage--pinned')).toBe(true);
      expect(stage.scrollTop).toBe(0);
      expect(container.querySelector('video')).toBe(video);
      expect(video?.srcObject).toBe(participant.stream);
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="채팅 열기"]')!.click());
      expect(container.querySelector('.chat-panel')?.getAttribute('aria-hidden')).toBe('false');
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="발표자의 화면 공유 고정 해제"]')!
          .click(),
      );
      expect(stage.classList.contains('video-stage--pinned')).toBe(false);
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="발표자의 화면 공유 크게 고정"]')!
          .click(),
      );
      await act(async () =>
        root.render(
          <RoomView
            {...props}
            participants={change === '퇴장' ? [] : [{ ...participant, videoSource: 'camera' }]}
          />,
        ),
      );
      expect(stage.classList.contains('video-stage--pinned')).toBe(false);
      await act(async () => root.render(<RoomView {...props} participants={[participant]} />));
      expect(
        container.querySelector(
          '[aria-pressed="false"][aria-label="발표자의 화면 공유 크게 고정"]',
        ),
      ).not.toBeNull();
    },
  );

  it('초대 링크 복사 실패 시 정규 주소를 직접 복사할 수 있게 표시한다', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('거부됨')) },
    });
    act(() => root.render(<RoomView {...roomViewProps()} />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.room-code')?.click();
    });

    const recovery = container.querySelector<HTMLElement>('.room-copy-recovery');
    const manualCopy = container.querySelector<HTMLInputElement>(
      'input[aria-label="초대 링크 수동 복사"]',
    );
    expect(recovery?.getAttribute('role')).toBe('alert');
    expect(manualCopy?.value).toBe(`${window.location.origin}/room/abcd-efgh-jkmp`);
  });

  it('채팅 패널을 닫으면 하단 채팅 버튼으로 포커스를 복원한다', async () => {
    act(() => root.render(<RoomView {...roomViewProps()} />));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]');
    expect(toggle).not.toBeNull();

    await act(async () => toggle?.click());
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="채팅 닫기"]');
    close?.focus();
    expect(document.activeElement).toBe(close);

    await act(async () => close?.click());
    expect(document.activeElement).toBe(toggle);
  });

  it('이전 대화를 읽을 때 위치를 유지하고 최신 대화로 이동한 뒤에만 새 메시지를 따라간다', () => {
    const props = roomViewProps();
    const message = {
      id: 'first',
      senderId: 'peer',
      senderName: '참가자',
      text: '첫 메시지',
      sentAt: 1,
      isLocal: false,
      deliveryState: 'received' as const,
    };
    act(() => root.render(<RoomView {...props} messages={[message]} />));
    const list = container.querySelector<HTMLDivElement>('.chat-messages')!;
    let height = 1000;
    Object.defineProperties(list, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 200 },
    });
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]')!.click(),
    );
    expect(list.scrollTop).toBe(1000);

    act(() => {
      list.scrollTop = 100;
      list.dispatchEvent(new Event('scroll'));
    });
    const messages = [message, { ...message, id: 'second' }];
    height = 1200;
    act(() => root.render(<RoomView {...props} messages={messages} />));
    expect(list.scrollTop).toBe(100);
    expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');

    act(() => root.render(<RoomView {...props} messages={[...messages]} />));
    expect(list.scrollTop).toBe(100);
    expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');

    act(() => container.querySelector<HTMLButtonElement>('.chat-latest')!.click());
    expect(list.scrollTop).toBe(1200);
    expect(container.querySelector('.chat-latest')).toBeNull();

    height = 1400;
    act(() =>
      root.render(<RoomView {...props} messages={[...messages, { ...message, id: 'third' }]} />),
    );
    expect(list.scrollTop).toBe(1400);
  });

  it('수신 확인 상태만 바뀌면 채팅 스크롤을 움직이지 않는다', () => {
    const props = roomViewProps();
    const message = {
      id: 'local',
      senderId: 'me',
      senderName: '나',
      text: '보낸 메시지',
      sentAt: 1,
      isLocal: true,
      deliveryState: 'pending' as const,
    };
    act(() => root.render(<RoomView {...props} messages={[message]} />));
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]')!.click(),
    );
    const list = container.querySelector<HTMLDivElement>('.chat-messages')!;
    const setScrollTop = vi.fn();
    Object.defineProperty(list, 'scrollTop', { set: setScrollTop });
    act(() =>
      root.render(<RoomView {...props} messages={[{ ...message, deliveryState: 'sent' }]} />),
    );
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it.each(['성공', '실패'] as const)(
    '진단 수집 중에는 중복 요청을 막고 %s 후 새로고침을 다시 허용한다',
    async (outcome) => {
      const diagnostic = { status: 'active' as const, connections: [] };
      let finish!: () => void;
      const pending = new Promise<typeof diagnostic>((resolve, reject) => {
        finish = () =>
          outcome === '성공' ? resolve(diagnostic) : reject(new Error('진단 수집 실패'));
      });
      const onCollectConnectionDiagnostics = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(diagnostic);
      act(() =>
        root.render(<RoomView {...roomViewProps()} {...{ onCollectConnectionDiagnostics }} />),
      );
      const details = container.querySelector<HTMLDetailsElement>('.connection-diagnostics')!;
      const refresh = details.querySelector<HTMLButtonElement>('header button')!;

      await act(async () => {
        details.open = true;
        details.dispatchEvent(new Event('toggle', { bubbles: true }));
      });
      expect(refresh.disabled).toBe(true);
      act(() => refresh.click());
      expect(onCollectConnectionDiagnostics).toHaveBeenCalledTimes(1);

      await act(async () => finish());
      expect(refresh.disabled).toBe(false);
      await act(async () => refresh.click());
      expect(onCollectConnectionDiagnostics).toHaveBeenCalledTimes(2);
    },
  );

  it('개인정보가 없는 연결 진단을 요청 시 수집하고 복사한다', async () => {
    const onCollectConnectionDiagnostics = vi.fn(async () => ({
      status: 'active' as const,
      connections: [
        {
          connectionNumber: 1,
          connectionState: 'connected' as const,
          localCandidateType: 'relay' as const,
          remoteCandidateType: 'srflx' as const,
          roundTripTimeMs: 34,
          packetLossPercent: 2,
          jitterMs: 18,
        },
      ],
    }));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    act(() =>
      root.render(<RoomView {...roomViewProps()} {...{ onCollectConnectionDiagnostics }} />),
    );
    const details = container.querySelector<HTMLDetailsElement>('.connection-diagnostics');

    await act(async () => {
      if (details !== null) {
        details.open = true;
        details.dispatchEvent(new Event('toggle', { bubbles: true }));
      }
    });

    expect(onCollectConnectionDiagnostics).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('TURN 중계');
    expect(container.textContent).toContain('34ms');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.connection-diagnostics__copy')?.click();
    });

    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('peerId'));
    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('roomId'));
  });
});

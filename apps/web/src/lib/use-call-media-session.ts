import { useEffect, useLayoutEffect, useRef } from 'react';

type CaptureAction = 'togglemicrophone' | 'togglecamera';
// lib.dom에 아직 없는 통화 액션만 이 연결부에서 보완한다.
type CallMediaSession = MediaSession & {
  setActionHandler(
    action: CaptureAction,
    handler: ((details: { isActivating?: boolean }) => void) | null,
  ): void;
};

function useCaptureAction(
  action: CaptureAction,
  available: boolean,
  enabled: boolean,
  onToggle: () => void,
) {
  const latest = useRef({ enabled, onToggle });
  useLayoutEffect(() => {
    latest.current = { enabled, onToggle };
  }, [enabled, onToggle]);

  const setter = action === 'togglemicrophone' ? 'setMicrophoneActive' : 'setCameraActive';
  useEffect(() => {
    const session = navigator.mediaSession as CallMediaSession | undefined;
    if (!session || !available) return;
    let disposed = false;
    try {
      session.setActionHandler(action, ({ isActivating }) => {
        if (disposed || isActivating === latest.current.enabled) return;
        latest.current.onToggle();
      });
    } catch {
      /* 통화 액션을 지원하지 않는 브라우저도 상태는 해제한다. */
    }
    return () => {
      disposed = true;
      try {
        session.setActionHandler(action, null);
      } catch {
        /* 브라우저가 지원하는 액션만 해제한다. */
      }
      void updateCaptureState(session, setter, false);
    };
  }, [action, available, setter]);

  useEffect(() => {
    const session = navigator.mediaSession as CallMediaSession | undefined;
    if (session && available) void updateCaptureState(session, setter, enabled);
  }, [available, enabled, setter]);
}

async function updateCaptureState(
  session: CallMediaSession,
  setter: 'setMicrophoneActive' | 'setCameraActive',
  enabled: boolean,
) {
  try {
    await session[setter]?.(enabled);
  } catch {
    /* 미지원·권한 거부 시 기존 통화 버튼을 사용한다. */
  }
}

export function useCallMediaSession({
  active,
  audioAvailable,
  audioEnabled,
  cameraAvailable,
  cameraEnabled,
  onToggleAudio,
  onToggleVideo,
}: {
  active: boolean;
  audioAvailable: boolean;
  audioEnabled: boolean;
  cameraAvailable: boolean;
  cameraEnabled: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
}) {
  useCaptureAction('togglemicrophone', active && audioAvailable, audioEnabled, onToggleAudio);
  useCaptureAction('togglecamera', active && cameraAvailable, cameraEnabled, onToggleVideo);
}

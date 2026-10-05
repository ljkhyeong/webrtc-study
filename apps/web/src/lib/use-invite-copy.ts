import { useEffect, useRef, useState } from 'react';
import { canonicalRoomUrl } from './room';

type InviteCopyState =
  | { readonly status: 'idle' | 'copying' | 'success' }
  | { readonly status: 'error'; readonly inviteUrl: string };

// 상단 방 코드와 초대 창이 같은 복사 상태를 쓰고, 중복 복사와 화면을 닫은 뒤의 늦은 결과를 막는다.
export function useInviteCopy(roomId: string): {
  readonly state: InviteCopyState;
  readonly copy: () => Promise<void>;
} {
  const [state, setState] = useState<InviteCopyState>({ status: 'idle' });
  const resetTimer = useRef<number | null>(null);
  const request = useRef<{ active: boolean } | null>(null);

  useEffect(
    () => () => {
      if (request.current) {
        request.current.active = false;
        request.current = null;
      }
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copy = async () => {
    if (request.current) return;
    const current = { active: true };
    request.current = current;
    setState({ status: 'copying' });
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    const inviteUrl = canonicalRoomUrl(roomId, window.location.href);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      if (!current.active) return;
      setState({ status: 'success' });
      resetTimer.current = window.setTimeout(() => {
        setState({ status: 'idle' });
        resetTimer.current = null;
      }, 1800);
    } catch {
      if (current.active) setState({ status: 'error', inviteUrl });
    } finally {
      if (request.current === current) request.current = null;
    }
  };

  return { state, copy };
}

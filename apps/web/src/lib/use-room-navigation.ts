import { useCallback, useEffect, useRef, useState } from 'react';

export type LeaveGuard = () => boolean | Promise<boolean>;
export type RegisterLeaveGuard = (guard: LeaveGuard | null) => void;
const HISTORY_KEY = 'roundNavigation';

export function useRoomNavigation() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [documentId] = useState(() => crypto.randomUUID());
  const currentIndex = useRef(0);
  const currentPath = useRef(pathname);
  const guard = useRef<LeaveGuard | null>(null);
  const cancelTraversal = useRef(() => {});
  const registerLeaveGuard = useCallback<RegisterLeaveGuard>((next) => {
    guard.current = next;
  }, []);

  useEffect(() => {
    const stamp = (index: number) => ({
      ...window.history.state,
      [HISTORY_KEY]: { documentId, index },
    });
    window.history.replaceState(stamp(currentIndex.current), '');
    let pending: { target: number; restored: boolean; accepted: boolean | null } | null = null;
    let approvedTarget: number | null = null;
    const finish = () => {
      if (!pending?.restored || pending.accepted === null) return;
      const { target, accepted } = pending;
      pending = null;
      if (accepted) {
        approvedTarget = target;
        window.history.go(target - currentIndex.current);
      }
    };
    cancelTraversal.current = () => {
      pending = null;
      approvedTarget = null;
    };
    const onPopState = (event: PopStateEvent) => {
      const entry = event.state?.[HISTORY_KEY];
      const target = entry?.documentId === documentId ? (entry.index as number) : null;
      const accept = () => {
        if (target !== null) currentIndex.current = target;
        currentPath.current = window.location.pathname;
        setPathname(currentPath.current);
      };
      // 확인 중에도 방 화면을 유지하고, 반복한 뒤로가기·앞으로가기는 원래 위치로 돌린다.
      if (pending && target !== null) {
        pending.restored = target === currentIndex.current;
        if (pending.restored) finish();
        else window.history.go(currentIndex.current - target);
        return;
      }
      if (approvedTarget === target && approvedTarget !== null) {
        approvedTarget = null;
        accept();
        return;
      }
      approvedTarget = null;
      if (
        target === null ||
        target === currentIndex.current ||
        window.location.pathname === currentPath.current
      ) {
        accept();
        return;
      }
      const decision = guard.current?.() ?? true;
      if (decision === true) {
        accept();
        return;
      }
      const traversal = { target, restored: false, accepted: null as boolean | null };
      pending = traversal;
      // popstate는 이동 뒤에 발생한다. 먼저 주소를 복구하고 승인한 경우에만 다시 이동한다.
      window.history.go(currentIndex.current - target);
      void Promise.resolve(decision).then(
        (accepted) => {
          if (pending !== traversal) return;
          traversal.accepted = accepted;
          finish();
        },
        () => {
          if (pending !== traversal) return;
          traversal.accepted = false;
          finish();
        },
      );
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      cancelTraversal.current();
      window.removeEventListener('popstate', onPopState);
    };
  }, [documentId]);

  const navigate = useCallback(
    (path: string, replace = false) => {
      cancelTraversal.current();
      if (!replace) currentIndex.current += 1;
      const state = {
        ...window.history.state,
        [HISTORY_KEY]: { documentId, index: currentIndex.current },
      };
      if (replace) window.history.replaceState(state, '', path);
      else window.history.pushState(state, '', path);
      currentPath.current = window.location.pathname;
      setPathname(currentPath.current);
    },
    [documentId],
  );

  return { pathname, navigate, registerLeaveGuard };
}

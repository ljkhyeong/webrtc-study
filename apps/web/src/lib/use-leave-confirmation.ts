import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RegisterLeaveGuard } from './use-room-navigation';

type ExitAction = 'leave' | 'reconnect';

// 작성 중인 채팅이나 화면 공유가 있으면 나가기·방 다시 입장·뒤로가기·페이지 종료 전에 확인한다.
// 확인한 뒤에는 퇴장을 한 번만 실행하고, 확인 중 방이 닫히면 대기 중인 이동도 취소한다.
export function useLeaveConfirmation({
  needsConfirmation,
  registerLeaveGuard,
  onLeave,
  onReconnect,
}: {
  needsConfirmation: boolean;
  registerLeaveGuard?: RegisterLeaveGuard | undefined;
  onLeave: () => void;
  onReconnect: () => void;
}) {
  const [confirmAction, setConfirmAction] = useState<ExitAction | null>(null);
  const leaveConfirmed = useRef(false);
  const navigationDecision = useRef<((accepted: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    registerLeaveGuard?.(() => {
      if (!needsConfirmation || leaveConfirmed.current) return true;
      if (navigationDecision.current || confirmAction) return false;
      return new Promise<boolean>((resolve) => {
        navigationDecision.current = resolve;
        setConfirmAction('leave');
      });
    });
    return () => registerLeaveGuard?.(null);
  }, [registerLeaveGuard, needsConfirmation, confirmAction]);
  useEffect(() => () => navigationDecision.current?.(false), []);
  const cancelExit = () => {
    setConfirmAction(null);
    navigationDecision.current?.(false);
    navigationDecision.current = null;
  };
  useEffect(() => {
    if (!needsConfirmation) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leaveConfirmed.current) return;
      event.preventDefault();
      event.returnValue = 'true';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [needsConfirmation]);
  const requestExit = (action: ExitAction) => {
    if (leaveConfirmed.current || confirmAction || navigationDecision.current) return;
    if (needsConfirmation) setConfirmAction(action);
    else {
      leaveConfirmed.current = true;
      if (action === 'reconnect') onReconnect();
      else onLeave();
    }
  };
  const confirmExit = () => {
    if (leaveConfirmed.current || !confirmAction) return;
    leaveConfirmed.current = true;
    const navigate = navigationDecision.current;
    navigationDecision.current = null;
    setConfirmAction(null);
    if (navigate) {
      navigate(true);
    } else if (confirmAction === 'reconnect') onReconnect();
    else onLeave();
  };
  return { confirmAction, requestExit, cancelExit, confirmExit };
}

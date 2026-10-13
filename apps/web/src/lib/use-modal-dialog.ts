import { useEffect, useInsertionEffect, useRef, type RefObject } from 'react';

/**
 * 대화상자를 모달로 열고, 닫거나 화면에서 없앨 때 연 요소로 초점을 돌려준다.
 * React가 대화상자를 문서에서 먼저 떼어 내면 브라우저가 초점을 돌려주지 못하므로 직접 처리한다.
 */
export function useModalDialog(dialogRef: RefObject<HTMLDialogElement | null>, open = true): void {
  const openerRef = useRef<Element | null>(null);
  // 삽입 효과는 대화상자 안 autoFocus보다 먼저 실행되므로 이때 연 요소를 기억한다.
  useInsertionEffect(() => {
    if (open) openerRef.current = document.activeElement;
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) return;
    const opener = openerRef.current;
    dialog.showModal();
    return () => {
      dialog.close();
      const focused = document.activeElement;
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (focused === null || focused === document.body || dialog.contains(focused))
      ) {
        opener.focus();
      }
    };
  }, [dialogRef, open]);
}

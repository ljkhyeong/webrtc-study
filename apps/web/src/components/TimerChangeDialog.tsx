import { useEffect, useRef } from 'react';

export function TimerChangeDialog({
  remainingSeconds,
  description,
  onCancel,
  onConfirm,
}: {
  remainingSeconds: number;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="media-device-dialog"
      aria-labelledby="timer-change-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="timer-change-title">공용 타이머를 변경할까요?</h2>
      <p>
        현재 남은 시간은 {Math.floor(remainingSeconds / 60)}분 {remainingSeconds % 60}초입니다.
      </p>
      <p>{description} 모든 참가자의 타이머가 바뀌며 지금까지 진행한 시간은 초기화됩니다.</p>
      <div className="leave-room-dialog__actions">
        <button type="button" autoFocus onClick={onCancel}>
          기존 타이머 유지
        </button>
        <button type="button" onClick={onConfirm}>
          타이머 변경
        </button>
      </div>
    </dialog>
  );
}

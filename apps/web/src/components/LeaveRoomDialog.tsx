import { useEffect, useRef } from 'react';

export function LeaveRoomDialog({
  action,
  hasDraft,
  screenSharing,
  onCancel,
  onConfirm,
}: {
  action: 'leave' | 'reconnect';
  hasDraft: boolean;
  screenSharing: boolean;
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
      className="media-device-dialog leave-room-dialog"
      aria-labelledby="leave-room-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="leave-room-title">
        {action === 'reconnect' ? '방에 다시 입장할까요?' : '스터디룸에서 나갈까요?'}
      </h2>
      {action === 'reconnect' ? (
        <p>현재 방 연결을 종료하고 입장 준비 화면으로 돌아갑니다.</p>
      ) : null}
      {hasDraft ? (
        <p>아직 보내지 않은 메시지가 있습니다. 나가면 작성 중인 내용이 사라집니다.</p>
      ) : null}
      {screenSharing ? (
        <p>내 화면을 공유하고 있습니다. 나가면 화면 공유와 통화가 종료됩니다.</p>
      ) : null}
      <p>이 방의 대화 기록은 나간 뒤 다시 볼 수 없습니다.</p>
      <div className="leave-room-dialog__actions">
        <button type="button" autoFocus onClick={onCancel}>
          {action === 'reconnect' ? '취소' : '계속 참여하기'}
        </button>
        <button type="button" onClick={onConfirm}>
          {action === 'reconnect' ? '방 다시 입장' : '방에서 나가기'}
        </button>
      </div>
    </dialog>
  );
}

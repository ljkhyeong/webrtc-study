import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from './Icons';

export function InviteDialog({
  inviteUrl,
  copyStatus,
  onCopy,
  onClose,
}: {
  inviteUrl: string;
  copyStatus: 'idle' | 'success' | 'error';
  onCopy: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [qrCode, setQrCode] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'success' | 'error'>('idle');

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    let active = true;
    import('qrcode')
      .then((qr) => qr.toString(inviteUrl, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }))
      .then(
        (svg) => {
          if (active) setQrCode(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        },
        () => {
          if (active) setQrFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [inviteUrl]);

  const handleShare = async () => {
    setShareState('sharing');
    try {
      await navigator.share({ title: 'ROUND 스터디룸', url: inviteUrl });
      setShareState('success');
    } catch (error) {
      setShareState(
        error instanceof DOMException && error.name === 'AbortError' ? 'idle' : 'error',
      );
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="media-device-dialog invite-dialog"
      aria-labelledby="invite-dialog-title"
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <header>
        <h2 id="invite-dialog-title">스터디원 초대</h2>
        <button
          type="button"
          aria-label="초대 닫기"
          autoFocus
          onClick={() => dialogRef.current?.close()}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="invite-dialog__qr">
        {qrCode ? (
          <img src={qrCode} alt="스터디룸 초대 QR 코드" width="256" height="256" />
        ) : (
          <p role="status">
            {qrFailed ? 'QR 코드를 만들지 못했습니다. 링크를 공유해 주세요.' : 'QR 코드 준비 중…'}
          </p>
        )}
      </div>
      <p>QR 코드를 스캔하거나 링크로 입장하세요.</p>
      <input
        aria-label="초대 링크"
        readOnly
        value={inviteUrl}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="invite-dialog__actions">
        <button
          type="button"
          onClick={() => {
            setShareState('idle');
            onCopy();
          }}
        >
          {copyStatus === 'success' ? '링크 복사됨' : '링크 복사'}
        </button>
        {typeof navigator.share === 'function' ? (
          <button type="button" disabled={shareState === 'sharing'} onClick={handleShare}>
            {shareState === 'sharing'
              ? '공유 중'
              : shareState === 'success'
                ? '공유됨'
                : '공유하기'}
          </button>
        ) : null}
      </div>
      {copyStatus === 'success' ? <p role="status">초대 링크를 복사했습니다.</p> : null}
      {copyStatus === 'error' ? (
        <p role="alert">복사하지 못했습니다. 위 주소를 직접 선택해 복사해 주세요.</p>
      ) : null}
      {shareState === 'success' ? <p role="status">초대 링크를 공유했습니다.</p> : null}
      {shareState === 'error' ? (
        <p role="alert">공유 메뉴를 열지 못했습니다. 링크를 복사해 주세요.</p>
      ) : null}
    </dialog>
  );
}

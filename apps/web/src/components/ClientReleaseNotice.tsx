import type { ReleaseStatus } from '../lib/client-release';
import { useEffect, useState } from 'react';

export const RELEASE_UPDATE_BEFORE_JOIN_MESSAGE = '새 버전이 있습니다. 새로고침 후 입장해 주세요.';
export const RELEASE_CHECK_FAILED_MESSAGE =
  '업데이트를 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.';

export function ClientReleaseNotice({
  status,
  inRoom,
  callEnded = false,
  onRetry,
}: {
  status: ReleaseStatus;
  inRoom: boolean;
  /** 방 화면이지만 통화가 오류로 끝났으면 새 버전을 입장 전처럼 바로 새로고침하도록 안내한다. */
  callEnded?: boolean;
  onRetry: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const inCall = inRoom && !callEnded;
  useEffect(() => {
    if (!inCall || status === 'current') setDismissed(false);
  }, [inCall, status]);
  if (inCall && dismissed) return null;
  if (status === 'current' || (status === 'unavailable' && inRoom)) return null;
  return (
    <aside className="client-release-notice" aria-label="버전 안내">
      <p role="status">
        {status === 'update'
          ? inCall
            ? '새 버전이 있습니다. 통화를 마친 뒤 새로고침해 주세요.'
            : RELEASE_UPDATE_BEFORE_JOIN_MESSAGE
          : RELEASE_CHECK_FAILED_MESSAGE}
      </p>
      {status === 'update' && inCall ? (
        <button type="button" onClick={() => setDismissed(true)}>
          나중에
        </button>
      ) : (
        <button
          type="button"
          onClick={status === 'update' ? () => window.location.reload() : onRetry}
        >
          {status === 'update' ? '새로고침' : '다시 확인'}
        </button>
      )}
    </aside>
  );
}

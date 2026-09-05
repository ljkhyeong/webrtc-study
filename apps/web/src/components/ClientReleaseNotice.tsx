import type { ReleaseStatus } from '../lib/client-release';
import { useEffect, useState } from 'react';

export function ClientReleaseNotice({
  status,
  inRoom,
  onRetry,
}: {
  status: ReleaseStatus;
  inRoom: boolean;
  onRetry: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!inRoom || status === 'current') setDismissed(false);
  }, [inRoom, status]);
  if (inRoom && dismissed) return null;
  if (status === 'current' || (status === 'unavailable' && inRoom)) return null;
  return (
    <aside className="client-release-notice" aria-label="버전 안내">
      <p role="status">
        {status === 'update'
          ? inRoom
            ? '새 버전이 있습니다. 통화를 마친 뒤 새로고침해 주세요.'
            : '새 버전이 있습니다. 새로고침 후 입장해 주세요.'
          : '웹 버전을 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.'}
      </p>
      {status === 'update' && inRoom ? (
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

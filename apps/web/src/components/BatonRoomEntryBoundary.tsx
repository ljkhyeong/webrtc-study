import { useEffect, useState, type ReactNode } from 'react';
import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from '../lib/participation-grant';
import { pathForRoom } from '../lib/room';
import { resolveNormalizedRoomEndpoints } from '../lib/room-endpoints';

interface BatonRoomEntryBoundaryProps {
  readonly roomId: string;
  readonly children: (
    manager: ParticipationGrantLeaseManager,
    authorizeBeforeEntryAction: () => Promise<boolean>,
    onAccessFailure: (error: ParticipationGrantAccessError) => void,
  ) => ReactNode;
}

type BatonRoomEntryState =
  | { readonly status: 'checking' }
  | {
      readonly status: 'ready';
      readonly manager: ParticipationGrantLeaseManager;
      readonly authorizeBeforeEntryAction: () => Promise<boolean>;
      readonly onAccessFailure: (error: ParticipationGrantAccessError) => void;
    }
  | { readonly status: 'unauthenticated' | 'forbidden' | 'not-found' | 'unavailable' };

export function BatonRoomEntryBoundary({ roomId, children }: BatonRoomEntryBoundaryProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BatonRoomEntryState>({ status: 'checking' });

  useEffect(() => {
    let active = true;
    let manager: ParticipationGrantLeaseManager | null = null;
    setState({ status: 'checking' });

    try {
      const endpoints = resolveNormalizedRoomEndpoints({
        roomId,
        authMode: 'baton',
        location: window.location,
        signalingUrl: import.meta.env.VITE_SIGNALING_URL,
        turnCredentialsUrl: import.meta.env.VITE_TURN_CREDENTIALS_URL,
      });
      if (endpoints.participationGrantRefreshUrl === null) {
        throw new Error('BATON participation-grant endpoint is unavailable');
      }
      manager = new ParticipationGrantLeaseManager({
        endpoint: endpoints.participationGrantRefreshUrl,
        roomId,
      });
    } catch {
      setState({ status: 'unavailable' });
      return undefined;
    }

    const activeManager = manager;
    const onAccessFailure = (error: ParticipationGrantAccessError) => {
      activeManager.close();
      if (active) {
        setState({ status: error.failure });
      }
    };
    const authorize = async () => {
      try {
        await activeManager.ensureFresh();
        return true;
      } catch (error) {
        if (error instanceof ParticipationGrantAccessError) {
          onAccessFailure(error);
        } else {
          activeManager.close();
          if (active) {
            setState({ status: 'unavailable' });
          }
        }
        return false;
      }
    };
    void authorize().then((authorized) => {
      if (active && authorized) {
        setState({
          status: 'ready',
          manager: activeManager,
          authorizeBeforeEntryAction: authorize,
          onAccessFailure,
        });
      }
    });

    return () => {
      active = false;
      activeManager.close();
    };
  }, [attempt, roomId]);

  if (state.status === 'ready') {
    return children(state.manager, state.authorizeBeforeEntryAction, state.onAccessFailure);
  }

  if (state.status === 'checking') {
    return (
      <BatonEntryPanel
        eyebrow="BATON · ROUND"
        title="스터디 참여 권한을 확인하고 있습니다."
        description="확인이 끝날 때까지 카메라와 마이크에 접근하지 않습니다."
        status
      />
    );
  }

  if (state.status === 'unauthenticated') {
    const returnTo = pathForRoom(roomId);
    const loginPath = `/login?${new URLSearchParams({ returnTo })}`;
    return (
      <BatonEntryPanel
        eyebrow="로그인 필요"
        title="BATON 로그인이 필요합니다."
        description="로그인하면 이 방으로 돌아옵니다."
        primaryAction={{ href: loginPath, label: 'BATON 로그인' }}
        secondaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
      />
    );
  }

  if (state.status === 'forbidden') {
    return (
      <BatonEntryPanel
        title="이 스터디룸의 참여 권한이 없습니다."
        primaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
      />
    );
  }

  if (state.status === 'not-found') {
    return (
      <BatonEntryPanel
        eyebrow="방을 찾을 수 없음"
        title="이 스터디룸을 찾을 수 없습니다."
        description="BATON에서 스터디룸을 다시 확인해 주세요."
        primaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
      />
    );
  }

  return (
    <BatonEntryPanel
      eyebrow="연결 확인 실패"
      title="스터디 참여 권한을 확인하지 못했습니다."
      description="네트워크 또는 BATON 연결을 확인한 뒤 다시 시도해 주세요."
      primaryAction={{ label: '다시 확인', onClick: () => setAttempt((value) => value + 1) }}
      secondaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
    />
  );
}

export function BatonRuntimeRoot() {
  return (
    <BatonEntryPanel
      eyebrow="BATON · ROUND"
      title="BATON에서 스터디룸을 열어 주세요."
      description="BATON에서 통화 참여를 누르거나 공유받은 스터디룸 링크를 열어 주세요."
      primaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
    />
  );
}

export function RoundRuntimeConfigurationError() {
  return (
    <BatonEntryPanel
      eyebrow="ROUND 설정 오류"
      title="서비스 설정 오류로 입장할 수 없습니다."
      description="운영자에게 문의해 주세요."
      status
    />
  );
}

interface BatonEntryAction {
  readonly href?: string;
  readonly label: string;
  readonly onClick?: () => void;
}

interface BatonEntryPanelProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly primaryAction?: BatonEntryAction;
  readonly secondaryAction?: BatonEntryAction;
  readonly status?: boolean;
}

function BatonEntryPanel({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  status = false,
}: BatonEntryPanelProps) {
  return (
    <div className="baton-entry-shell">
      <header className="baton-entry-header">
        <a className="wordmark" href="/">
          ROUND
          <span>by BATON</span>
        </a>
      </header>
      <main className="baton-entry-main" aria-live="polite" {...(status ? { role: 'status' } : {})}>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {status ? <span className="connecting-ring" aria-hidden="true" /> : null}
        {primaryAction || secondaryAction ? (
          <div className="baton-entry-actions">
            {primaryAction ? <BatonEntryActionLink action={primaryAction} primary /> : null}
            {secondaryAction ? <BatonEntryActionLink action={secondaryAction} /> : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function BatonEntryActionLink({
  action,
  primary = false,
}: {
  readonly action: BatonEntryAction;
  readonly primary?: boolean;
}) {
  const className = primary
    ? 'baton-entry-action baton-entry-action--primary'
    : 'baton-entry-action';
  if (action.href !== undefined) {
    return (
      <a className={className} href={action.href}>
        {action.label}
      </a>
    );
  }
  return (
    <button className={className} type="button" onClick={action.onClick}>
      {action.label}
    </button>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from '../lib/participation-grant';
import { pathForRoom } from '../lib/room';
import { resolveRoomEndpoints } from '../lib/room-endpoints';

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
      const endpoints = resolveRoomEndpoints({
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
        activeManager.close();
        if (!active) {
          return false;
        }
        if (error instanceof ParticipationGrantAccessError) {
          onAccessFailure(error);
        } else {
          setState({ status: 'unavailable' });
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
        description="로그인한 뒤 이 스터디룸으로 안전하게 돌아옵니다."
        primaryAction={{ href: loginPath, label: '로그인하고 돌아오기' }}
        secondaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
      />
    );
  }

  if (state.status === 'forbidden') {
    return (
      <BatonEntryPanel
        eyebrow="참여 권한 없음"
        title="이 스터디룸에 참여할 수 없습니다."
        description="로그인은 확인됐지만 현재 스터디 멤버십 또는 방 참여 권한이 없습니다."
        primaryAction={{ href: '/', label: 'BATON에서 권한 확인하기' }}
      />
    );
  }

  if (state.status === 'not-found') {
    return (
      <BatonEntryPanel
        eyebrow="종료된 스터디룸"
        title="이 스터디룸을 더 이상 찾을 수 없습니다."
        description="방이 종료되었거나 BATON에서 새 스터디룸으로 교체되었습니다."
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
      description="이 ROUND 번들은 독립 방 생성이나 초대 코드 입장을 제공하지 않습니다."
      primaryAction={{ href: '/', label: 'BATON으로 돌아가기' }}
    />
  );
}

export function RoundRuntimeConfigurationError() {
  return (
    <BatonEntryPanel
      eyebrow="ROUND 설정 오류"
      title="스터디룸을 안전하게 시작할 수 없습니다."
      description="브라우저 인증 모드 설정을 확인한 뒤 ROUND를 다시 배포해 주세요."
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
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
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
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
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

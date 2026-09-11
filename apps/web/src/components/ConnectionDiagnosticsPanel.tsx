import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import type {
  PeerConnectionDiagnostics,
  PeerConnectionStatus,
  RoomConnectionDiagnostics,
} from '@round/rtc-core';

type ConnectionDiagnosticsState =
  | { readonly status: 'idle' | 'stale' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly value: RoomConnectionDiagnostics };

interface ConnectionDiagnosticsPanelProps {
  readonly connectionContextKey?: string;
  readonly qualityVisible?: boolean;
  readonly onSetQualityVisible?: ((visible: boolean) => void) | undefined;
  readonly onCollect: () => Promise<RoomConnectionDiagnostics>;
}

const connectionStateLabels: Record<PeerConnectionStatus, string> = {
  new: '연결 준비',
  connecting: '연결 중',
  connected: '연결됨',
  disconnected: '연결 끊김',
  failed: '연결 실패',
  closed: '연결 종료',
  negotiating: '연결 설정 중',
};

const candidateTypeLabels: Record<RTCIceCandidateType, string> = {
  host: '직접 경로',
  srflx: '공인 주소 경로',
  prflx: '상대가 확인한 경로',
  relay: 'TURN 중계',
};

function diagnosticValue(value: number | null, unit: string) {
  return value === null ? '측정값 없음' : `${value}${unit}`;
}

export function connectionDiagnosticAdvice(diagnostic: PeerConnectionDiagnostics): string {
  if (diagnostic.connectionState !== 'connected') {
    return '연결 복구 중에는 품질을 판단하기 어렵습니다. 연결된 뒤 다시 측정해 주세요.';
  }
  if (diagnostic.packetLossPercent === null) {
    return '측정 데이터가 부족합니다. 상대의 음성·영상이 들어올 때 다시 측정해 주세요.';
  }
  if (diagnostic.packetLossPercent >= 3 || (diagnostic.jitterMs ?? 0) >= 30) {
    return '최근 수신이 불안정합니다. Wi-Fi 상태를 확인하고 상대방에게 데이터 절약 모드나 카메라 끄기를 요청해 보세요.';
  }
  if ((diagnostic.roundTripTimeMs ?? 0) >= 300) {
    return '왕복 지연이 큽니다. 다운로드를 멈추거나 유선망·다른 Wi-Fi에서 다시 측정해 보세요.';
  }
  return '이번 측정에서 큰 수신 손실은 보이지 않습니다. 끊김이 반복되면 문제가 발생할 때 다시 측정해 주세요.';
}

function candidateTypeLabel(type: RTCIceCandidateType | null) {
  return type === null ? '정보 없음' : candidateTypeLabels[type];
}

function shareableDiagnostics(value: RoomConnectionDiagnostics): RoomConnectionDiagnostics {
  return {
    status: value.status,
    connections: value.connections.map(
      ({ participantName: _participantName, ...connection }) => connection,
    ),
  };
}

function ConnectionDiagnosticItem({
  diagnostic,
}: {
  readonly diagnostic: PeerConnectionDiagnostics;
}) {
  return (
    <article className="connection-diagnostics__item">
      <strong>
        {diagnostic.participantName
          ? `${diagnostic.participantName} · 연결 ${diagnostic.connectionNumber}`
          : `연결 ${diagnostic.connectionNumber}`}
      </strong>
      <dl>
        <div>
          <dt>상태</dt>
          <dd>{connectionStateLabels[diagnostic.connectionState]}</dd>
        </div>
        <div>
          <dt>경로</dt>
          <dd>
            {candidateTypeLabel(diagnostic.localCandidateType)} →{' '}
            {candidateTypeLabel(diagnostic.remoteCandidateType)}
          </dd>
        </div>
        <div>
          <dt>왕복 지연</dt>
          <dd>{diagnosticValue(diagnostic.roundTripTimeMs, 'ms')}</dd>
        </div>
        <div>
          <dt>최근 수신 손실</dt>
          <dd>{diagnosticValue(diagnostic.packetLossPercent, '%')}</dd>
        </div>
        <div>
          <dt>최대 지연 변동</dt>
          <dd>{diagnosticValue(diagnostic.jitterMs, 'ms')}</dd>
        </div>
      </dl>
      <p>{connectionDiagnosticAdvice(diagnostic)}</p>
    </article>
  );
}

export function ConnectionDiagnosticsPanel({
  connectionContextKey = '',
  onCollect,
  qualityVisible = false,
  onSetQualityVisible,
}: ConnectionDiagnosticsPanelProps) {
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnosticsState>({ status: 'idle' });
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  const collectionGeneration = useRef(0);
  const previousContextKey = useRef(connectionContextKey);

  useLayoutEffect(() => {
    if (previousContextKey.current === connectionContextKey) return;
    previousContextKey.current = connectionContextKey;
    collectionGeneration.current += 1;
    setDiagnostics({ status: 'stale' });
    setCopyState('idle');
  }, [connectionContextKey]);

  useEffect(
    () => () => {
      collectionGeneration.current += 1;
    },
    [],
  );

  const collect = async () => {
    const generation = collectionGeneration.current + 1;
    collectionGeneration.current = generation;
    setDiagnostics({ status: 'loading' });
    setCopyState('idle');
    try {
      const value = await onCollect();
      if (collectionGeneration.current === generation) {
        setDiagnostics({ status: 'ready', value });
      }
    } catch {
      if (collectionGeneration.current === generation) {
        setDiagnostics({ status: 'error' });
      }
    }
  };

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (
      event.currentTarget.open &&
      (diagnostics.status === 'idle' || diagnostics.status === 'stale')
    ) {
      void collect();
    }
  };

  const copy = async () => {
    if (diagnostics.status !== 'ready') return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            measurement: '약 3초 동안 측정한 수신 손실과 마지막 지연·지연 변동',
            ...shareableDiagnostics(diagnostics.value),
          },
          null,
          2,
        ),
      );
      setCopyState('success');
    } catch {
      setCopyState('error');
    }
  };

  const ready = diagnostics.status === 'ready' ? diagnostics.value : null;
  return (
    <details className="connection-diagnostics" onToggle={handleToggle}>
      <summary>진단</summary>
      <section className="connection-diagnostics__panel" aria-label="연결 진단">
        <header>
          <strong>연결 진단</strong>
          <button
            type="button"
            disabled={diagnostics.status === 'loading'}
            onClick={() => void collect()}
          >
            다시 측정
          </button>
        </header>
        {onSetQualityVisible ? (
          <button
            className="quality-toggle"
            type="button"
            aria-pressed={qualityVisible}
            onClick={() => onSetQualityVisible(!qualityVisible)}
          >
            참가자별 수신 품질 {qualityVisible ? '표시 끄기' : '표시 켜기'}
          </button>
        ) : null}
        <p className="connection-diagnostics__privacy">
          약 3초 동안 수신 손실을 측정하고 마지막 지연과 지연 변동을 표시합니다. 참가자 이름은 현재
          화면에서만 표시하며 복사하지 않습니다. IP 주소와 참가자 식별자는 수집하거나 서버로 보내지
          않습니다.
        </p>
        {diagnostics.status === 'error' ? (
          <p role="alert">연결 상태를 측정하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
        ) : diagnostics.status === 'idle' ? (
          <p>연결 진단을 열면 약 3초 동안 측정합니다.</p>
        ) : diagnostics.status === 'stale' ? (
          <p role="status">참가자 연결이 바뀌었습니다. 다시 측정해 주세요.</p>
        ) : ready === null ? (
          <p role="status">최근 수신 상태를 약 3초 동안 측정하고 있습니다.</p>
        ) : (
          <>
            {ready.connections.length === 0 ? (
              <p>진단할 참가자 연결이 없습니다.</p>
            ) : (
              <div className="connection-diagnostics__list">
                {ready.connections.map((diagnostic) => (
                  <ConnectionDiagnosticItem
                    key={diagnostic.connectionNumber}
                    diagnostic={diagnostic}
                  />
                ))}
              </div>
            )}
            <button
              className="connection-diagnostics__copy"
              type="button"
              onClick={() => void copy()}
            >
              {copyState === 'success' ? '진단 정보 복사됨' : '진단 정보 복사'}
            </button>
            {copyState === 'error' ? <p role="alert">클립보드에 복사하지 못했습니다.</p> : null}
            <pre tabIndex={0}>{JSON.stringify(shareableDiagnostics(ready), null, 2)}</pre>
          </>
        )}
      </section>
    </details>
  );
}

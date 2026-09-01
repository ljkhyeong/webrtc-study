export interface PeerConnectionDiagnostics {
  readonly connectionNumber: number;
  readonly connectionState: RTCPeerConnectionState | 'negotiating';
  readonly localCandidateType: RTCIceCandidateType | null;
  readonly remoteCandidateType: RTCIceCandidateType | null;
  readonly roundTripTimeMs: number | null;
  readonly packetLossPercent: number | null;
  readonly jitterMs: number | null;
}

export interface ConnectionDiagnosticTarget {
  readonly connection: RTCPeerConnection;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export async function measurePeerConnections(
  targets: readonly ConnectionDiagnosticTarget[],
  sampleDurationMs = 3_000,
): Promise<readonly PeerConnectionDiagnostics[]> {
  const connections = await Promise.all(
    targets.map(async (target, index): Promise<PeerConnectionDiagnostics | null> => {
      const before = await target.connection.getStats();
      if (target.signal.aborted) return null;
      await waitForSample(target.signal, sampleDurationMs);
      if (!target.isCurrent()) return null;
      const report = await target.connection.getStats();
      if (!target.isCurrent()) return null;
      return summarizeConnection(index + 1, target.connection.connectionState, before, report);
    }),
  );
  return connections.filter((connection) => connection !== null);
}

function waitForSample(signal: AbortSignal, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, durationMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function summarizeConnection(
  connectionNumber: number,
  connectionState: RTCPeerConnectionState,
  before: RTCStatsReport,
  report: RTCStatsReport,
): PeerConnectionDiagnostics {
  const entries = [...report.values()];
  const transport = entries.find((stats): stats is RTCTransportStats => stats.type === 'transport');
  const selectedCandidatePair =
    (transport?.selectedCandidatePairId === undefined
      ? undefined
      : report.get(transport.selectedCandidatePairId)) ??
    entries.find(
      (stats) =>
        stats.type === 'candidate-pair' &&
        (stats as RTCIceCandidatePairStats).state === 'succeeded' &&
        (stats as RTCIceCandidatePairStats).nominated === true,
    );
  const candidatePair =
    selectedCandidatePair?.type === 'candidate-pair'
      ? (selectedCandidatePair as RTCIceCandidatePairStats)
      : undefined;
  const localCandidate =
    candidatePair === undefined
      ? undefined
      : (report.get(candidatePair.localCandidateId) as
          (RTCStats & { readonly candidateType?: RTCIceCandidateType }) | undefined);
  const remoteCandidate =
    candidatePair === undefined
      ? undefined
      : (report.get(candidatePair.remoteCandidateId) as
          (RTCStats & { readonly candidateType?: RTCIceCandidateType }) | undefined);

  let packetsReceived = 0;
  let packetsLost = 0;
  let maximumJitterSeconds: number | null = null;
  for (const stats of entries) {
    if (stats.type !== 'inbound-rtp') continue;
    const inbound = stats as RTCInboundRtpStreamStats;
    const previous = before.get(inbound.id) as RTCInboundRtpStreamStats | undefined;
    if (
      previous?.type === 'inbound-rtp' &&
      previous.ssrc === inbound.ssrc &&
      inbound.timestamp > previous.timestamp &&
      inbound.packetsReceived !== undefined &&
      previous.packetsReceived !== undefined &&
      inbound.packetsLost !== undefined &&
      previous.packetsLost !== undefined &&
      inbound.packetsReceived >= previous.packetsReceived
    ) {
      packetsReceived += inbound.packetsReceived - previous.packetsReceived;
      // 늦게 도착한 패킷으로 누적 손실이 감소해도 음수 손실률을 표시하지 않는다.
      packetsLost += Math.max(0, inbound.packetsLost - previous.packetsLost);
    }
    if (
      inbound.jitter !== undefined &&
      (maximumJitterSeconds === null || inbound.jitter > maximumJitterSeconds)
    ) {
      maximumJitterSeconds = inbound.jitter;
    }
  }
  const totalPackets = packetsReceived + packetsLost;

  return {
    connectionNumber,
    connectionState,
    localCandidateType: localCandidate?.candidateType ?? null,
    remoteCandidateType: remoteCandidate?.candidateType ?? null,
    roundTripTimeMs:
      candidatePair?.currentRoundTripTime === undefined
        ? null
        : Math.round(candidatePair.currentRoundTripTime * 1_000),
    packetLossPercent:
      totalPackets <= 0 ? null : Math.round((packetsLost / totalPackets) * 1_000) / 10,
    jitterMs: maximumJitterSeconds === null ? null : Math.round(maximumJitterSeconds * 1_000),
  };
}

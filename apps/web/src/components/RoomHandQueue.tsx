import type { HandQueueState } from '@round/rtc-core';
import type { ParticipantView } from './VideoTile';

export function RoomHandQueue({
  state,
  participants,
  active,
}: {
  state: HandQueueState | null;
  participants: readonly ParticipantView[];
  active: boolean;
}) {
  const queue =
    state?.peerIds.flatMap((id) => participants.filter((peer) => peer.peerId === id)) ?? [];
  const unsupported = state
    ? participants.filter(
        (peer) => peer.handRaised && !state.supportedPeerIds.includes(peer.peerId),
      )
    : [];
  return (
    <details className="room-hand-queue">
      <summary>손들기 · {state && active ? `대기 ${queue.length}명` : '순서 확인 중'}</summary>
      <div className="room-hand-queue__body">
        {!active ? <p role="status">연결 복구 후 대기 순서를 확인합니다.</p> : null}
        <ol aria-label="손들기 대기 순서" aria-live="polite" aria-relevant="all">
          {queue.map((peer) => (
            <li key={peer.peerId}>
              {peer.displayName}
              {peer.isLocal ? ' (나)' : ''}
            </li>
          ))}
        </ol>
        {active && state && !queue.length ? <p>대기 중인 참가자가 없습니다.</p> : null}
        {unsupported.length ? (
          <p>
            순서 미지원: {unsupported.map((peer) => peer.displayName).join(', ')}. 최신 웹으로 다시
            입장하면 대기 목록에 참여할 수 있습니다.
          </p>
        ) : null}
        <small>서버에 도착한 순서입니다. 손을 내렸다 다시 들면 맨 뒤로 이동합니다.</small>
      </div>
    </details>
  );
}

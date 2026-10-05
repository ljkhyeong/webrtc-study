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
  return (
    <div className="room-hand-queue">
      {!active ? <p role="status">다시 연결되면 대기 순서를 불러옵니다.</p> : null}
      <ol aria-label="손들기 대기 순서" aria-live="polite" aria-relevant="all">
        {queue.map((peer) => (
          <li key={peer.peerId}>
            {peer.displayName}
            {peer.isLocal ? ' (나)' : ''}
          </li>
        ))}
      </ol>
      {active && state && !queue.length ? <p>대기 중인 참가자가 없습니다.</p> : null}
      <small>서버에 도착한 순서입니다. 손을 내렸다 다시 들면 맨 뒤로 이동합니다.</small>
    </div>
  );
}

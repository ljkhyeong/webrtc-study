import type { HandQueueState } from '@round/rtc-core';
import { CameraOffIcon, MicIcon, MicOffIcon } from './Icons';
import { connectionLabel, type ParticipantView } from './VideoTile';

export function RoomParticipantList({
  participants,
  handQueue,
}: {
  participants: readonly ParticipantView[];
  handQueue: HandQueueState | null;
}) {
  return (
    <ul className="participant-list">
      {participants.map((participant) => {
        const handPosition = handQueue?.peerIds.indexOf(participant.peerId) ?? -1;
        const details = [
          participant.role === 'host' ? '방장' : null,
          !participant.isLocal && participant.connectionState !== 'connected'
            ? connectionLabel(participant.connectionState)
            : null,
          handPosition >= 0 ? `손들기 ${handPosition + 1}번째` : null,
          participant.audioEnabled ? null : '마이크 꺼짐',
          participant.videoEnabled ? null : '카메라 꺼짐',
        ].filter((detail) => detail !== null);
        return (
          <li key={participant.peerId}>
            <span className="participant-list__avatar" aria-hidden="true">
              {Array.from(participant.displayName.trim())[0] ?? '?'}
            </span>
            <span className="participant-list__text">
              <strong>
                {participant.displayName}
                {participant.isLocal ? ' (나)' : ''}
              </strong>
              {details.length > 0 ? <small>{details.join(' · ')}</small> : null}
            </span>
            <span className="participant-list__media">
              {participant.audioEnabled ? <MicIcon /> : <MicOffIcon />}
              {participant.videoEnabled ? null : <CameraOffIcon />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

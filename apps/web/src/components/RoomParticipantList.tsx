import type { HandQueueState } from '@round/rtc-core';
import { CameraOffIcon, MicIcon, MicOffIcon } from './Icons';
import { connectionLabel, type ParticipantView } from './VideoTile';

export function RoomParticipantList({
  participants,
  handQueue,
  canModerateMedia = false,
  onDisableAudio,
  onDisableVideo,
}: {
  participants: readonly ParticipantView[];
  handQueue: HandQueueState | null;
  canModerateMedia?: boolean;
  onDisableAudio?: ((peerId: string) => void) | undefined;
  onDisableVideo?: ((peerId: string) => void) | undefined;
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
        const moderated =
          canModerateMedia && !participant.isLocal && participant.role === 'participant';
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
              {moderated ? (
                <span className="participant-list__actions">
                  <button
                    type="button"
                    disabled={!participant.audioEnabled}
                    aria-label={`${participant.displayName} 마이크 끄기`}
                    onClick={() => onDisableAudio?.(participant.peerId)}
                  >
                    마이크 끄기
                  </button>
                  <button
                    type="button"
                    disabled={!participant.videoEnabled}
                    aria-label={`${participant.displayName} 영상 끄기`}
                    onClick={() => onDisableVideo?.(participant.peerId)}
                  >
                    영상 끄기
                  </button>
                </span>
              ) : null}
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

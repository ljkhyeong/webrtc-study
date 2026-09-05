import type { StudyCommand, StudyState } from './study.js';
export const PROTOCOL_VERSION = 3 as const;

export const SIGNALING_ERROR_CODES = [
  'INVALID_MESSAGE',
  'ALREADY_JOINED',
  'ROOM_FULL',
  'NOT_IN_ROOM',
  'ROOM_MISMATCH',
  'TARGET_NOT_FOUND',
  'TARGET_SELF',
  'FORBIDDEN',
  'INTERNAL_ERROR',
] as const;

type ProtocolVersion = typeof PROTOCOL_VERSION;
export type SignalingErrorCode = (typeof SIGNALING_ERROR_CODES)[number];
export type ParticipantRole = 'host' | 'participant';
export type ModeratedMediaKind = 'audio' | 'video';

export interface Participant {
  peerId: string;
  displayName: string;
  role: ParticipantRole;
}

export interface OfferDescription {
  type: 'offer';
  sdp?: string;
}

export interface AnswerDescription {
  type: 'answer';
  sdp?: string;
}

/**
 * `RTCIceCandidate#toJSON`이 반환하는 JSON 안전 부분집합이다.
 *
 * `candidate`가 `null`이면 후보 수집 종료를 뜻한다. 브라우저는 해당 SDP 값을
 * 사용할 수 없을 때 `null`을 사용하므로 nullable 필드를 유지한다.
 */
export interface SerializedIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface ClientMessageBase {
  v: ProtocolVersion;
  roomId: string;
  requestId?: string;
}

interface RoomJoinClientMessage extends ClientMessageBase {
  type: 'room.join';
  payload: {
    displayName: string;
    hostCapability?: string;
  };
}

interface RtcOfferClientMessage extends ClientMessageBase {
  type: 'rtc.offer';
  to: string;
  payload: {
    description: OfferDescription;
    negotiationId?: string;
  };
}

interface RtcAnswerClientMessage extends ClientMessageBase {
  type: 'rtc.answer';
  to: string;
  payload: {
    description: AnswerDescription;
    negotiationId?: string;
  };
}

interface RtcIceClientMessage extends ClientMessageBase {
  type: 'rtc.ice';
  to: string;
  payload: {
    candidate: SerializedIceCandidate | null;
    negotiationId?: string;
  };
}

interface ModerationMediaDisableClientMessage extends ClientMessageBase {
  type: 'moderation.media.disable';
  to: string;
  payload: {
    kind: ModeratedMediaKind;
  };
}

interface RoomLeaveClientMessage extends ClientMessageBase {
  type: 'room.leave';
}

interface PeerReconnectClientMessage extends ClientMessageBase {
  type: 'peer.reconnect';
  to: string;
}

interface StudySyncClientMessage extends ClientMessageBase {
  type: 'room.study.sync';
}
interface StudyUpdateClientMessage extends ClientMessageBase {
  type: 'room.study.update';
  payload: StudyCommand & { expectedRevision: number };
}

export type ClientMessage =
  | StudySyncClientMessage
  | StudyUpdateClientMessage
  | PeerReconnectClientMessage
  | RoomJoinClientMessage
  | RtcOfferClientMessage
  | RtcAnswerClientMessage
  | RtcIceClientMessage
  | ModerationMediaDisableClientMessage
  | RoomLeaveClientMessage;

interface ServerMessageBase {
  v: ProtocolVersion;
  roomId: string;
}

interface RoomJoinedServerMessage extends ServerMessageBase {
  type: 'room.joined';
  requestId?: string;
  payload: {
    peerId: string;
    selfRole: ParticipantRole;
    capabilities: {
      canModerateMedia: boolean;
    };
    participants: Participant[];
  };
}

interface PeerJoinedServerMessage extends ServerMessageBase {
  type: 'peer.joined';
  payload: {
    participant: Participant;
  };
}

interface RtcOfferServerMessage extends ServerMessageBase {
  type: 'rtc.offer';
  from: string;
  payload: {
    description: OfferDescription;
    negotiationId?: string;
  };
}

interface RtcAnswerServerMessage extends ServerMessageBase {
  type: 'rtc.answer';
  from: string;
  payload: {
    description: AnswerDescription;
    negotiationId?: string;
  };
}

interface RtcIceServerMessage extends ServerMessageBase {
  type: 'rtc.ice';
  from: string;
  payload: {
    candidate: SerializedIceCandidate | null;
    negotiationId?: string;
  };
}

interface ModerationMediaDisabledServerMessage extends ServerMessageBase {
  type: 'moderation.media.disabled';
  from: string;
  requestId?: string;
  payload: {
    targetPeerId: string;
    kind: ModeratedMediaKind;
  };
}

interface PeerLeftServerMessage extends ServerMessageBase {
  type: 'peer.left';
  payload: {
    peerId: string;
  };
}

interface ErrorServerMessage {
  v: ProtocolVersion;
  type: 'error';
  roomId?: string;
  requestId?: string;
  payload: {
    code: SignalingErrorCode;
    message: string;
  };
}

interface PeerReconnectServerMessage extends ServerMessageBase {
  type: 'peer.reconnect';
  payload: { peerId: string; connectionId: string; initiator: boolean };
}

interface StudyStateServerMessage extends ServerMessageBase {
  type: 'room.study.state';
  requestId?: string;
  payload: StudyState & { conflict: boolean };
}

export type ServerMessage =
  | StudyStateServerMessage
  | PeerReconnectServerMessage
  | RoomJoinedServerMessage
  | PeerJoinedServerMessage
  | RtcOfferServerMessage
  | RtcAnswerServerMessage
  | RtcIceServerMessage
  | ModerationMediaDisabledServerMessage
  | PeerLeftServerMessage
  | ErrorServerMessage;

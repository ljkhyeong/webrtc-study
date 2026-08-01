export const PROTOCOL_VERSION = 3 as const;

export const CLIENT_MESSAGE_TYPES = [
  'room.join',
  'rtc.offer',
  'rtc.answer',
  'rtc.ice',
  'moderation.media.disable',
  'room.leave',
] as const;

export const SERVER_MESSAGE_TYPES = [
  'room.joined',
  'peer.joined',
  'rtc.offer',
  'rtc.answer',
  'rtc.ice',
  'moderation.media.disabled',
  'peer.left',
  'error',
] as const;

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

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];
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
 * The JSON-safe subset returned by `RTCIceCandidate#toJSON`.
 *
 * A null candidate marks end-of-candidates. Nullable fields are retained because
 * browsers use null when the corresponding SDP value is unavailable.
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

export interface RoomJoinClientMessage extends ClientMessageBase {
  type: 'room.join';
  payload: {
    displayName: string;
    hostCapability?: string;
  };
}

export interface RtcOfferClientMessage extends ClientMessageBase {
  type: 'rtc.offer';
  to: string;
  payload: {
    description: OfferDescription;
    negotiationId?: string;
  };
}

export interface RtcAnswerClientMessage extends ClientMessageBase {
  type: 'rtc.answer';
  to: string;
  payload: {
    description: AnswerDescription;
    negotiationId?: string;
  };
}

export interface RtcIceClientMessage extends ClientMessageBase {
  type: 'rtc.ice';
  to: string;
  payload: {
    candidate: SerializedIceCandidate | null;
    negotiationId?: string;
  };
}

export interface ModerationMediaDisableClientMessage extends ClientMessageBase {
  type: 'moderation.media.disable';
  to: string;
  payload: {
    kind: ModeratedMediaKind;
  };
}

export interface RoomLeaveClientMessage extends ClientMessageBase {
  type: 'room.leave';
}

export type ClientMessage =
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

export interface RoomJoinedServerMessage extends ServerMessageBase {
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

export interface PeerJoinedServerMessage extends ServerMessageBase {
  type: 'peer.joined';
  payload: {
    participant: Participant;
  };
}

export interface RtcOfferServerMessage extends ServerMessageBase {
  type: 'rtc.offer';
  from: string;
  payload: {
    description: OfferDescription;
    negotiationId?: string;
  };
}

export interface RtcAnswerServerMessage extends ServerMessageBase {
  type: 'rtc.answer';
  from: string;
  payload: {
    description: AnswerDescription;
    negotiationId?: string;
  };
}

export interface RtcIceServerMessage extends ServerMessageBase {
  type: 'rtc.ice';
  from: string;
  payload: {
    candidate: SerializedIceCandidate | null;
    negotiationId?: string;
  };
}

export interface ModerationMediaDisabledServerMessage extends ServerMessageBase {
  type: 'moderation.media.disabled';
  from: string;
  requestId?: string;
  payload: {
    targetPeerId: string;
    kind: ModeratedMediaKind;
  };
}

export interface PeerLeftServerMessage extends ServerMessageBase {
  type: 'peer.left';
  payload: {
    peerId: string;
  };
}

export interface ErrorServerMessage {
  v: ProtocolVersion;
  type: 'error';
  roomId?: string;
  requestId?: string;
  payload: {
    code: SignalingErrorCode;
    message: string;
  };
}

export type ServerMessage =
  | RoomJoinedServerMessage
  | PeerJoinedServerMessage
  | RtcOfferServerMessage
  | RtcAnswerServerMessage
  | RtcIceServerMessage
  | ModerationMediaDisabledServerMessage
  | PeerLeftServerMessage
  | ErrorServerMessage;

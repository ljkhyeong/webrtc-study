package com.personal.round.protocol;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import com.personal.round.auth.ParticipationGrant;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/** 서버가 보내는 메시지를 record로 만들어 JSON으로 직렬화한다. record의 모든 구성요소가 전송되므로 내부용 값을 넣지 않는다. */
@Component
public final class ServerMessageEncoder {

	private final ObjectMapper objectMapper;

	public ServerMessageEncoder(ObjectMapper objectMapper) {
		this.objectMapper = objectMapper;
	}

	public TextMessage roomJoined(
			String roomId,
			String requestId,
			String peerId,
			ParticipationGrant.Role selfRole,
			List<Participant> participants) {
		return frame("room.joined", roomId, null, requestId, new RoomJoined(
				peerId,
				selfRole,
				new Capabilities(selfRole == ParticipationGrant.Role.HOST),
				participants));
	}

	public TextMessage peerJoined(String roomId, Participant participant) {
		return frame("peer.joined", roomId, null, null, new PeerJoined(participant));
	}

	public TextMessage relay(String type, String roomId, String from, ObjectNode payload) {
		return frame(type, roomId, from, null, payload);
	}

	public TextMessage moderationMediaDisabled(
			String roomId,
			String requestId,
			String from,
			String targetPeerId,
			ClientMessage.MediaKind kind) {
		return frame("moderation.media.disabled", roomId, from, requestId, new MediaDisabled(targetPeerId, kind));
	}

	public TextMessage studyState(String roomId, String requestId, StudyState state, boolean conflict) {
		ObjectNode payload = objectMapper.valueToTree(state);
		payload.put("conflict", conflict);
		return frame("room.study.state", roomId, null, requestId, payload);
	}

	public TextMessage handState(String roomId, String requestId, HandQueueState state) {
		return frame("room.hand.state", roomId, null, requestId, state);
	}

	public TextMessage peerReconnect(String roomId, String peerId, String connectionId, boolean initiator) {
		return frame("peer.reconnect", roomId, null, null, new PeerReconnect(peerId, connectionId, initiator));
	}

	public TextMessage peerLeft(String roomId, String peerId) {
		return frame("peer.left", roomId, null, null, new PeerLeft(peerId));
	}

	public TextMessage error(
			SignalingErrorCode code,
			String detail,
			String roomId,
			String requestId) {
		return frame("error", roomId, null, requestId, new ErrorPayload(code, detail));
	}

	private TextMessage frame(String type, String roomId, String from, String requestId, Object payload) {
		return new TextMessage(objectMapper.writeValueAsString(
				new Frame(ProtocolParser.PROTOCOL_VERSION, type, roomId, from, requestId, payload)));
	}

	public record Participant(
			String peerId,
			String displayName,
			ParticipationGrant.Role role) {
	}

	@JsonInclude(JsonInclude.Include.NON_NULL)
	@JsonPropertyOrder({"v", "type", "roomId", "from", "requestId", "payload"})
	record Frame(int v, String type, String roomId, String from, String requestId, Object payload) {
	}

	record RoomJoined(
			String peerId,
			ParticipationGrant.Role selfRole,
			Capabilities capabilities,
			List<Participant> participants) {
	}

	record Capabilities(boolean canModerateMedia) {
	}

	record PeerJoined(Participant participant) {
	}

	record MediaDisabled(String targetPeerId, ClientMessage.MediaKind kind) {
	}

	record PeerReconnect(String peerId, String connectionId, boolean initiator) {
	}

	record PeerLeft(String peerId) {
	}

	record ErrorPayload(SignalingErrorCode code, String message) {
	}
}

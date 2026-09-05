package com.personal.round.protocol;

import com.personal.round.auth.ParticipationGrant;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

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
		ObjectNode message = base("room.joined", roomId);
		if (requestId != null) {
			message.put("requestId", requestId);
		}
		ObjectNode payload = message.putObject("payload");
		payload.put("peerId", peerId);
		payload.put("selfRole", roleValue(selfRole));
		payload.putObject("capabilities")
				.put("canModerateMedia", selfRole == ParticipationGrant.Role.HOST);
		ArrayNode participantNodes = payload.putArray("participants");
		for (Participant participant : participants) {
			participantNodes.add(participantNode(participant));
		}
		return textMessage(message);
	}

	public TextMessage peerJoined(String roomId, Participant participant) {
		ObjectNode message = base("peer.joined", roomId);
		message.putObject("payload")
				.set("participant", participantNode(participant));
		return textMessage(message);
	}

	public TextMessage relay(String type, String roomId, String from, ObjectNode payload) {
		ObjectNode message = base(type, roomId);
		message.put("from", from);
		message.set("payload", payload);
		return textMessage(message);
	}

	public TextMessage moderationMediaDisabled(
			String roomId,
			String requestId,
			String from,
			String targetPeerId,
			ClientMessage.MediaKind kind) {
		ObjectNode message = base("moderation.media.disabled", roomId);
		message.put("from", from);
		if (requestId != null) {
			message.put("requestId", requestId);
		}
		message.putObject("payload")
				.put("targetPeerId", targetPeerId)
				.put("kind", kind.wireValue());
		return textMessage(message);
	}

	public TextMessage studyState(String roomId, String requestId, StudyState state, boolean conflict) {
		ObjectNode message = base("room.study.state", roomId);
		if (requestId != null) message.put("requestId", requestId);
		ObjectNode payload = objectMapper.valueToTree(state);
		payload.put("conflict", conflict);
		message.set("payload", payload);
		return textMessage(message);
	}

	public TextMessage handState(String roomId, String requestId, HandQueueState state) {
		ObjectNode message = base("room.hand.state", roomId);
		if (requestId != null) message.put("requestId", requestId);
		message.set("payload", objectMapper.valueToTree(state));
		return textMessage(message);
	}

	public TextMessage peerReconnect(String roomId, String peerId, String connectionId, boolean initiator) {
		ObjectNode message = base("peer.reconnect", roomId);
		message.putObject("payload")
				.put("peerId", peerId)
				.put("connectionId", connectionId)
				.put("initiator", initiator);
		return textMessage(message);
	}

	public TextMessage peerLeft(String roomId, String peerId) {
		ObjectNode message = base("peer.left", roomId);
		message.putObject("payload").put("peerId", peerId);
		return textMessage(message);
	}

	public TextMessage error(
			SignalingErrorCode code,
			String detail,
			String roomId,
			String requestId) {
		ObjectNode message = objectMapper.createObjectNode();
		message.put("v", ProtocolParser.PROTOCOL_VERSION);
		message.put("type", "error");
		if (roomId != null) {
			message.put("roomId", roomId);
		}
		if (requestId != null) {
			message.put("requestId", requestId);
		}
		ObjectNode payload = message.putObject("payload");
		payload.put("code", code.name());
		payload.put("message", detail);
		return textMessage(message);
	}

	private ObjectNode base(String type, String roomId) {
		ObjectNode message = objectMapper.createObjectNode();
		message.put("v", ProtocolParser.PROTOCOL_VERSION);
		message.put("type", type);
		message.put("roomId", roomId);
		return message;
	}

	private ObjectNode participantNode(Participant participant) {
		ObjectNode node = objectMapper.createObjectNode();
		node.put("peerId", participant.peerId());
		node.put("displayName", participant.displayName());
		node.put("role", roleValue(participant.role()));
		return node;
	}

	private static String roleValue(ParticipationGrant.Role role) {
		return role.name().toLowerCase(java.util.Locale.ROOT);
	}

	private static TextMessage textMessage(ObjectNode message) {
		return new TextMessage(message.toString());
	}

	public record Participant(
			String peerId,
			String displayName,
			ParticipationGrant.Role role) {
	}
}

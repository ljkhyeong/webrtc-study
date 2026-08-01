package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.protocol.ServerMessageEncoder.Participant;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

class ServerMessageEncoderTest {

	private static final String ROOM_ID = "abcd-efgh-jkmp";

	private ObjectMapper objectMapper;
	private ServerMessageEncoder encoder;

	@BeforeEach
	void setUp() {
		objectMapper = new ObjectMapper();
		encoder = new ServerMessageEncoder(objectMapper);
	}

	@Test
	void encodesRoomJoinedWithParticipantOrderAndOptionalRequestId() {
		assertThat(encoder.roomJoined(
				ROOM_ID,
				"join-42",
				"peer-self",
				ParticipationGrant.Role.HOST,
				List.of(
						new Participant("peer-ada", "Ada", ParticipationGrant.Role.HOST),
						new Participant("peer-grace", "Grace", ParticipationGrant.Role.PARTICIPANT)))
				.getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"room.joined\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"requestId\":\"join-42\",\"payload\":{\"peerId\":\"peer-self\","
								+ "\"selfRole\":\"host\",\"capabilities\":{\"canModerateMedia\":true},"
								+ "\"participants\":[{\"peerId\":\"peer-ada\",\"displayName\":\"Ada\",\"role\":\"host\"},"
								+ "{\"peerId\":\"peer-grace\",\"displayName\":\"Grace\",\"role\":\"participant\"}]}}");
	}

	@Test
	void encodesPeerJoined() {
		assertThat(encoder.peerJoined(
				ROOM_ID,
				new Participant("peer-grace", "Grace", ParticipationGrant.Role.PARTICIPANT))
				.getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"peer.joined\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"payload\":{\"participant\":{\"peerId\":\"peer-grace\","
								+ "\"displayName\":\"Grace\",\"role\":\"participant\"}}}");
	}

	@Test
	void encodesRelayWithServerOwnedFromAndPayloadPropertyOrder() throws Exception {
		ObjectNode payload = (ObjectNode) objectMapper.readTree(
				"{\"negotiationId\":\"negotiation-42\","
						+ "\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}");

		assertThat(encoder.relay("rtc.offer", ROOM_ID, "peer-grace", payload).getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"rtc.offer\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"from\":\"peer-grace\",\"payload\":{\"negotiationId\":\"negotiation-42\","
								+ "\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}}");
	}

	@Test
	void encodesPeerLeft() {
		assertThat(encoder.peerLeft(ROOM_ID, "peer-grace").getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"peer.left\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"payload\":{\"peerId\":\"peer-grace\"}}");
	}

	@Test
	void encodesErrorWithOptionalEnvelopeFields() {
		assertThat(encoder.error(
				SignalingErrorCode.TARGET_NOT_FOUND,
				"The target peer is not in this room.",
				ROOM_ID,
				"relay-42")
				.getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"error\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"requestId\":\"relay-42\",\"payload\":{\"code\":\"TARGET_NOT_FOUND\","
								+ "\"message\":\"The target peer is not in this room.\"}}");

		assertThat(encoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"Malformed JSON.",
				null,
				null)
				.getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"error\",\"payload\":{\"code\":\"INVALID_MESSAGE\","
								+ "\"message\":\"Malformed JSON.\"}}");
	}

	@Test
	void encodesServerOwnedModerationCommandForActorAndTarget() {
		assertThat(encoder.moderationMediaDisabled(
				ROOM_ID,
				"moderate-1",
				"peer-host",
				"peer-member",
				ClientMessage.MediaKind.VIDEO).getPayload())
				.isEqualTo(
						"{\"v\":3,\"type\":\"moderation.media.disabled\","
								+ "\"roomId\":\"abcd-efgh-jkmp\",\"from\":\"peer-host\","
								+ "\"requestId\":\"moderate-1\",\"payload\":{"
								+ "\"targetPeerId\":\"peer-member\",\"kind\":\"video\"}}");
	}

	@Test
	void errorCodesMatchTheSharedProtocolContractInOrder() {
		assertThat(Arrays.stream(SignalingErrorCode.values()).map(Enum::name))
				.containsExactly(
						"INVALID_MESSAGE",
						"ALREADY_JOINED",
						"ROOM_FULL",
						"NOT_IN_ROOM",
						"ROOM_MISMATCH",
						"TARGET_NOT_FOUND",
						"TARGET_SELF",
						"FORBIDDEN",
						"INTERNAL_ERROR");
	}
}

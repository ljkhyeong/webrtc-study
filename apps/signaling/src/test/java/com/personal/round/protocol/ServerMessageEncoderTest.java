package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;

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
				List.of(
						new Participant("peer-ada", "Ada"),
						new Participant("peer-grace", "Grace")))
				.getPayload())
				.isEqualTo(
						"{\"v\":2,\"type\":\"room.joined\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"requestId\":\"join-42\",\"payload\":{\"peerId\":\"peer-self\","
								+ "\"participants\":[{\"peerId\":\"peer-ada\",\"displayName\":\"Ada\"},"
								+ "{\"peerId\":\"peer-grace\",\"displayName\":\"Grace\"}]}}");
	}

	@Test
	void encodesPeerJoined() {
		assertThat(encoder.peerJoined(
				ROOM_ID,
				new Participant("peer-grace", "Grace"))
				.getPayload())
				.isEqualTo(
						"{\"v\":2,\"type\":\"peer.joined\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"payload\":{\"participant\":{\"peerId\":\"peer-grace\","
								+ "\"displayName\":\"Grace\"}}}");
	}

	@Test
	void encodesRelayWithServerOwnedFromAndPayloadPropertyOrder() throws Exception {
		ObjectNode payload = (ObjectNode) objectMapper.readTree(
				"{\"negotiationId\":\"negotiation-42\","
						+ "\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}");

		assertThat(encoder.relay("rtc.offer", ROOM_ID, "peer-grace", payload).getPayload())
				.isEqualTo(
						"{\"v\":2,\"type\":\"rtc.offer\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"from\":\"peer-grace\",\"payload\":{\"negotiationId\":\"negotiation-42\","
								+ "\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}}");
	}

	@Test
	void encodesPeerLeft() {
		assertThat(encoder.peerLeft(ROOM_ID, "peer-grace").getPayload())
				.isEqualTo(
						"{\"v\":2,\"type\":\"peer.left\",\"roomId\":\"abcd-efgh-jkmp\","
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
						"{\"v\":2,\"type\":\"error\",\"roomId\":\"abcd-efgh-jkmp\","
								+ "\"requestId\":\"relay-42\",\"payload\":{\"code\":\"TARGET_NOT_FOUND\","
								+ "\"message\":\"The target peer is not in this room.\"}}");

		assertThat(encoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"Malformed JSON.",
				null,
				null)
				.getPayload())
				.isEqualTo(
						"{\"v\":2,\"type\":\"error\",\"payload\":{\"code\":\"INVALID_MESSAGE\","
								+ "\"message\":\"Malformed JSON.\"}}");
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
						"INTERNAL_ERROR");
	}
}

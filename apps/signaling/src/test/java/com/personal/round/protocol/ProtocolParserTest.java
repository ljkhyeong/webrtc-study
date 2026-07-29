package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.node.ObjectNode;

class ProtocolParserTest {

	private ObjectMapper objectMapper;
	private ProtocolParser parser;

	@BeforeEach
	void setUp() {
		objectMapper = new ObjectMapper();
		parser = new ProtocolParser(objectMapper);
	}

	@Test
	void parsesEveryClientMessageShape() {
		assertThat(parser.parse("""
				{"v":2,"type":"room.join","roomId":"abcd-efgh-jkmp","requestId":"join-1",
				 "payload":{"displayName":"Ada"}}
				"""))
				.isEqualTo(new ClientMessage.Join("abcd-efgh-jkmp", "join-1", "Ada"));

		assertThat(parser.parse("""
				{"v":2,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
				"""))
				.isEqualTo(new ClientMessage.Leave("abcd-efgh-jkmp", null));

		ClientMessage.Relay offer = (ClientMessage.Relay) parser.parse("""
				{"v":2,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"description":{"type":"offer","sdp":"v=0"}}}
				""");
		assertThat(offer.type()).isEqualTo("rtc.offer");
		assertThat(offer.payload().at("/description/sdp").asString()).isEqualTo("v=0");

		ClientMessage.Relay answer = (ClientMessage.Relay) parser.parse("""
				{"v":2.0,"type":"rtc.answer","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"description":{"type":"answer"}}}
				""");
		assertThat(answer.type()).isEqualTo("rtc.answer");

		ClientMessage.Relay ice = (ClientMessage.Relay) parser.parse("""
				{"v":2,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"candidate":{"candidate":"","sdpMid":null,
				 "sdpMLineIndex":0.0,"usernameFragment":"ufrag"}}}
				""");
		assertThat(ice.payload().at("/candidate/sdpMid").isNull()).isTrue();

		ClientMessage.Relay endOfCandidates = (ClientMessage.Relay) parser.parse("""
				{"v":2,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"candidate":null}}
				""");
		assertThat(endOfCandidates.payload().get("candidate").isNull()).isTrue();
	}

	@Test
	void acceptsAndPreservesNegotiationIdsForEveryRelayPayload() {
		String negotiationId = "n".repeat(ProtocolParser.MAX_NEGOTIATION_ID_LENGTH);

		for (String type : new String[] {"rtc.offer", "rtc.answer", "rtc.ice"}) {
			ClientMessage.Relay relay = (ClientMessage.Relay) parser.parse(
					relayJson(type, negotiationId));

			assertThat(relay.type()).isEqualTo(type);
			assertThat(relay.payload().get("negotiationId").asString()).isEqualTo(negotiationId);
		}
	}

	@Test
	void rejectsBlankAndOversizedNegotiationIdsForEveryRelayPayload() {
		String[] invalidNegotiationIds = {
				"",
				" ",
				"n".repeat(ProtocolParser.MAX_NEGOTIATION_ID_LENGTH + 1)
		};

		for (String type : new String[] {"rtc.offer", "rtc.answer", "rtc.ice"}) {
			for (String negotiationId : invalidNegotiationIds) {
				assertInvalid(relayJson(type, negotiationId), "$.payload.negotiationId");
			}
		}
	}

	@Test
	void rejectsUnknownAndClientOwnedSenderFieldsAtEveryLevel() {
		assertInvalid("""
				{"v":2,"type":"room.join","roomId":"abcd-efgh-jkmp","from":"spoofed",
				 "payload":{"displayName":"Ada"}}
				""", "$");
		assertInvalid("""
				{"v":2,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":"v=0","extra":true}}}
				""", "$.payload.description");
		assertInvalid("""
				{"v":2,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","networkCost":10}}}
				""", "$.payload.candidate");
	}

	@Test
	void doesNotExposeAnOversizedUnexpectedPropertyNameInThePublicErrorMessage() {
		String unexpectedProperty = "x".repeat(ProtocolValidationException.MAX_PUBLIC_MESSAGE_LENGTH + 1);
		String message = """
				{"v":2,"type":"room.join","roomId":"abcd-efgh-jkmp","%s":true,
				 "payload":{"displayName":"Ada"}}
				""".formatted(unexpectedProperty);

		ProtocolValidationException exception = catchThrowableOfType(
				ProtocolValidationException.class,
				() -> parser.parse(message));

		assertThat(exception.getPath()).isEqualTo("$");
		assertThat(exception.getMessage())
				.isEqualTo("$: contains an unsupported property")
				.hasSizeLessThanOrEqualTo(ProtocolValidationException.MAX_PUBLIC_MESSAGE_LENGTH)
				.doesNotContain(unexpectedProperty);
	}

	@Test
	void capsEveryPublicValidationMessageAtTheProtocolLimit() {
		ProtocolValidationException exception = new ProtocolValidationException(
				"$." + "x".repeat(ProtocolValidationException.MAX_PUBLIC_MESSAGE_LENGTH),
				"is not allowed");

		assertThat(exception.getMessage())
				.hasSize(ProtocolValidationException.MAX_PUBLIC_MESSAGE_LENGTH)
				.endsWith("…");
	}

	@Test
	void rejectsNullOptionalFieldsExceptIceNullableFields() {
		assertInvalid("""
				{"v":2,"type":"room.join","roomId":"abcd-efgh-jkmp","requestId":null,
				 "payload":{"displayName":"Ada"}}
				""", "$.requestId");
		assertInvalid("""
				{"v":2,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":null}}}
				""", "$.payload.description.sdp");
		assertInvalid("""
				{"v":2,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":null,
				 "payload":{"description":{"type":"offer"}}}
				""", "$.to");
	}

	@Test
	void enforcesNormalizedNamesAndAllLengthAndNumberBounds() {
		assertInvalid("""
				{"v":2,"type":"room.join","roomId":" abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada"}}
				""", "$.roomId");
		assertInvalid("""
				{"v":2,"type":"room.join","roomId":"abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada "}}
				""", "$.payload.displayName");
		assertInvalid("""
				{"v":2,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","sdpMLineIndex":65536}}}
				""", "$.payload.candidate.sdpMLineIndex");
		assertInvalid("""
				{"v":1,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
				""", "$.v");
	}

	@Test
	void acceptsMaximumAsciiAndMultibyteSdpWithinTheTransportFrameBudget() {
		String[] maximumSdpValues = {
				"x".repeat(ProtocolParser.MAX_SDP_BYTES),
				"가".repeat(ProtocolParser.MAX_SDP_BYTES / 3)
		};

		for (String sdp : maximumSdpValues) {
			String json = offerJson(
					sdp,
					"p".repeat(ProtocolParser.MAX_PEER_ID_LENGTH),
					"r".repeat(ProtocolParser.MAX_REQUEST_ID_LENGTH));

			assertThat(ProtocolParser.utf8ByteLength(sdp))
					.isEqualTo(ProtocolParser.MAX_SDP_BYTES);
			assertThat(ProtocolParser.utf8ByteLength(json))
					.isLessThanOrEqualTo(ProtocolParser.MAX_SIGNALING_FRAME_BYTES);
			assertThat(parser.parse(json)).isInstanceOf(ClientMessage.Relay.class);
		}
	}

	@Test
	void rejectsAsciiAndMultibyteSdpOverTheUtf8ByteBudget() {
		assertInvalid(
				offerJson("x".repeat(ProtocolParser.MAX_SDP_BYTES + 1), "peer-b", null),
				"$.payload.description.sdp");
		assertInvalid(
				offerJson("가".repeat(ProtocolParser.MAX_SDP_BYTES / 3 + 1), "peer-b", null),
				"$.payload.description.sdp");
	}

	@Test
	void rejectsAnEscapeHeavySdpWhoseSerializedFrameExceeds64KiB() {
		String sdp = "\n".repeat(ProtocolParser.MAX_SDP_BYTES);
		String json = offerJson(sdp, "peer-b", null);

		assertThat(ProtocolParser.utf8ByteLength(sdp))
				.isEqualTo(ProtocolParser.MAX_SDP_BYTES);
		assertThat(ProtocolParser.utf8ByteLength(json))
				.isGreaterThan(ProtocolParser.MAX_SIGNALING_FRAME_BYTES);
		assertInvalid(json, "$");
	}

	@Test
	void rejectsNonCanonicalRoomIdsAndEcmaScriptWhitespaceNames() {
		assertInvalid(
				"{\"v\":2,\"type\":\"room.join\",\"roomId\":\"abcd-efgh-jkmp\","
						+ "\"payload\":{\"displayName\":\"\\u00a0Ada\"}}",
				"$.payload.displayName");
		assertInvalid(
				"{\"v\":2,\"type\":\"room.join\",\"roomId\":\"abcd-efgh-jkmp\","
						+ "\"payload\":{\"displayName\":\"\\ufeff\"}}",
				"$.payload.displayName");
		assertInvalid(
				"{\"v\":2,\"type\":\"room.join\",\"roomId\":\"abcd-efgi-jkmp\","
						+ "\"payload\":{\"displayName\":\"Ada\"}}",
				"$.roomId");
		assertInvalid(
				"{\"v\":2,\"type\":\"room.join\",\"roomId\":\"ABCD-efgh-jkmp\","
						+ "\"payload\":{\"displayName\":\"Ada\"}}",
				"$.roomId");
	}

	@Test
	void rejectsMalformedJsonAndNonObjects() {
		assertThatThrownBy(() -> parser.parse(null))
				.isInstanceOf(MalformedJsonException.class);
		assertThatThrownBy(() -> parser.parse("{"))
				.isInstanceOf(MalformedJsonException.class);
		assertInvalid("[]", "$");
		assertInvalid("null", "$");
		assertThatThrownBy(() -> parser.parse(
						"{\"v\":2,\"type\":\"room.leave\",\"roomId\":\"abcd-efgh-jkmp\"} true"))
				.isInstanceOf(MalformedJsonException.class);
	}

	@Test
	void doesNotHideUnexpectedRuntimeExceptionsFromJackson() {
		ObjectMapper failingMapper = mock(ObjectMapper.class);
		ObjectReader failingReader = mock(ObjectReader.class);
		IllegalStateException failure = new IllegalStateException("reader failed unexpectedly");
		when(failingMapper.reader(DeserializationFeature.FAIL_ON_TRAILING_TOKENS))
				.thenReturn(failingReader);
		when(failingReader.readTree(anyString())).thenThrow(failure);
		ProtocolParser failingParser = new ProtocolParser(failingMapper);

		assertThatThrownBy(() -> failingParser.parse("{}"))
				.isSameAs(failure);
	}

	private void assertInvalid(String json, String expectedPath) {
		assertThatThrownBy(() -> parser.parse(json))
				.isInstanceOf(ProtocolValidationException.class)
				.hasMessageContaining(expectedPath);
	}

	private String offerJson(String sdp, String to, String requestId) {
		ObjectNode message = objectMapper.createObjectNode();
		message.put("v", ProtocolParser.PROTOCOL_VERSION);
		message.put("type", "rtc.offer");
		message.put("roomId", "abcd-efgh-jkmp");
		if (requestId != null) {
			message.put("requestId", requestId);
		}
		message.put("to", to);
		ObjectNode description = message.putObject("payload").putObject("description");
		description.put("type", "offer");
		description.put("sdp", sdp);
		return message.toString();
	}

	private String relayJson(String type, String negotiationId) {
		ObjectNode message = objectMapper.createObjectNode();
		message.put("v", ProtocolParser.PROTOCOL_VERSION);
		message.put("type", type);
		message.put("roomId", "abcd-efgh-jkmp");
		message.put("to", "peer-b");
		ObjectNode payload = message.putObject("payload");
		payload.put("negotiationId", negotiationId);
		if ("rtc.ice".equals(type)) {
			payload.putNull("candidate");
		}
		else {
			ObjectNode description = payload.putObject("description");
			description.put("type", type.substring("rtc.".length()));
			description.put("sdp", "v=0");
		}
		return message.toString();
	}
}

package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
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
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp","requestId":"join-1",
				 "payload":{"displayName":"Ada","hostCapability":"host-capability-0123456789abcdef"}}
				"""))
				.isEqualTo(new ClientMessage.Join(
						"abcd-efgh-jkmp", "join-1", "Ada", "host-capability-0123456789abcdef"));

		assertThat(parser.parse("""
				{"v":3,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
				"""))
				.isEqualTo(new ClientMessage.Leave("abcd-efgh-jkmp", null));

		ClientMessage.Relay offer = (ClientMessage.Relay) parser.parse("""
				{"v":3,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"description":{"type":"offer","sdp":"v=0"}}}
				""");
		assertThat(offer.type()).isEqualTo("rtc.offer");
		assertThat(offer.payload().at("/description/sdp").asString()).isEqualTo("v=0");

		ClientMessage.Relay answer = (ClientMessage.Relay) parser.parse("""
				{"v":3.0,"type":"rtc.answer","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"description":{"type":"answer"}}}
				""");
		assertThat(answer.type()).isEqualTo("rtc.answer");

		ClientMessage.Relay ice = (ClientMessage.Relay) parser.parse("""
				{"v":3,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"candidate":{"candidate":"","sdpMid":null,
				 "sdpMLineIndex":0.0,"usernameFragment":"ufrag"}}}
				""");
		assertThat(ice.payload().at("/candidate/sdpMid").isNull()).isTrue();

		ClientMessage.Relay endOfCandidates = (ClientMessage.Relay) parser.parse("""
				{"v":3,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer-b",
				 "payload":{"candidate":null}}
				""");
		assertThat(endOfCandidates.payload().get("candidate").isNull()).isTrue();

		assertThat(parser.parse("""
				{"v":3,"type":"moderation.media.disable","roomId":"abcd-efgh-jkmp",
				 "requestId":"moderate-1","to":"peer-b","payload":{"kind":"audio"}}
				"""))
				.isEqualTo(new ClientMessage.Moderation(
						"abcd-efgh-jkmp",
						"moderate-1",
						"peer-b",
						ClientMessage.MediaKind.AUDIO));
	}

	@Test
	void rejectsInvalidHostCapabilitiesAndModerationKinds() {
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada","hostCapability":" "}}
				""", "$.payload.hostCapability");
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada","hostCapability":null}}
				""", "$.payload.hostCapability");
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada","hostCapability":"too-short"}}
				""", "$.payload.hostCapability");
		assertInvalid("""
				{"v":3,"type":"moderation.media.disable","roomId":"abcd-efgh-jkmp",
				 "to":"peer-b","payload":{"kind":"enable"}}
				""", "$.payload.kind");
		assertInvalid("""
				{"v":3,"type":"moderation.media.disable","roomId":"abcd-efgh-jkmp",
				 "to":"peer-b","payload":{"kind":"video","enabled":true}}
				""", "$.payload");
	}

	@Test
	void acceptsAndPreservesNegotiationIdsForEveryRelayPayload() {
		String negotiationId = "n".repeat(ProtocolParser.MAX_REQUEST_ID_LENGTH);

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
				"n".repeat(ProtocolParser.MAX_REQUEST_ID_LENGTH + 1)
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
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp","from":"spoofed",
				 "payload":{"displayName":"Ada"}}
				""", "$");
		assertInvalid("""
				{"v":3,"type":"moderation.media.disable","roomId":"abcd-efgh-jkmp",
				 "from":"spoofed-host","to":"peer","payload":{"kind":"audio"}}
				""", "$");
		assertInvalid("""
				{"v":3,"type":"moderation.media.disable","roomId":"abcd-efgh-jkmp",
				 "to":"peer","payload":{"kind":"audio","role":"host"}}
				""", "$.payload");
		assertInvalid("""
				{"v":3,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":"v=0","extra":true}}}
				""", "$.payload.description");
		assertInvalid("""
				{"v":3,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","networkCost":10}}}
				""", "$.payload.candidate");
	}

	@Test
	void redactsTheHostCapabilityFromJoinDiagnostics() {
		String hostCapability = "host-capability-0123456789abcdef";
		ClientMessage.Join join = new ClientMessage.Join(
				"abcd-efgh-jkmp", "join-1", "Ada", hostCapability);

		assertThat(join.toString())
				.contains("hostCapability=<redacted>")
				.doesNotContain(hostCapability);
	}

	@Test
	void doesNotExposeAnOversizedUnexpectedPropertyNameInThePublicErrorMessage() {
		String unexpectedProperty = "x".repeat(2_048);
		String message = """
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp","%s":true,
				 "payload":{"displayName":"Ada"}}
				""".formatted(unexpectedProperty);

		assertThatThrownBy(() -> parser.parse(message))
				.isInstanceOf(ProtocolValidationException.class)
				.hasMessage("$: contains an unsupported property")
				.hasMessageNotContaining(unexpectedProperty);
	}

	@Test
	void rejectsNullOptionalFieldsExceptIceNullableFields() {
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp","requestId":null,
				 "payload":{"displayName":"Ada"}}
				""", "$.requestId");
		assertInvalid("""
				{"v":3,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":null}}}
				""", "$.payload.description.sdp");
		assertInvalid("""
				{"v":3,"type":"rtc.offer","roomId":"abcd-efgh-jkmp","to":null,
				 "payload":{"description":{"type":"offer"}}}
				""", "$.to");
	}

	@Test
	void enforcesNormalizedNamesAndAllLengthAndNumberBounds() {
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":" abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada"}}
				""", "$.roomId");
		assertInvalid("""
				{"v":3,"type":"room.join","roomId":"abcd-efgh-jkmp",
				 "payload":{"displayName":"Ada "}}
				""", "$.payload.displayName");
		assertInvalid("""
				{"v":3,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","sdpMLineIndex":65536}}}
				""", "$.payload.candidate.sdpMLineIndex");
		assertInvalid("""
				{"v":3,"type":"rtc.ice","roomId":"abcd-efgh-jkmp","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","sdpMLineIndex":0.5}}}
				""", "$.payload.candidate.sdpMLineIndex");
		assertInvalid("""
				{"v":3.5,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
				""", "$.v");
		assertInvalid("""
				{"v":1,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
				""", "$.v");
	}

	@Test
	void acceptsMaximumAsciiAndMultibyteSdp() {
		String[] maximumSdpValues = {
				"x".repeat(ProtocolParser.MAX_SDP_BYTES),
				"가".repeat(ProtocolParser.MAX_SDP_BYTES / 3)
		};

		for (String sdp : maximumSdpValues) {
			String json = offerJson(
					sdp,
					"p".repeat(ProtocolParser.MAX_PEER_ID_LENGTH),
					"r".repeat(ProtocolParser.MAX_REQUEST_ID_LENGTH));

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
	void rejectsNonCanonicalRoomIdsAndEcmaScriptWhitespaceNames() {
		assertInvalid(
				"{\"v\":3,\"type\":\"room.join\",\"roomId\":\"abcd-efgh-jkmp\","
						+ "\"payload\":{\"displayName\":\"\\u00a0Ada\"}}",
				"$.payload.displayName");
		assertInvalid(
				"{\"v\":3,\"type\":\"room.join\",\"roomId\":\"abcd-efgh-jkmp\","
						+ "\"payload\":{\"displayName\":\"\\ufeff\"}}",
				"$.payload.displayName");
		assertInvalid(
				"{\"v\":3,\"type\":\"room.join\",\"roomId\":\"abcd-efgi-jkmp\","
						+ "\"payload\":{\"displayName\":\"Ada\"}}",
				"$.roomId");
		assertInvalid(
				"{\"v\":3,\"type\":\"room.join\",\"roomId\":\"ABCD-efgh-jkmp\","
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
						"{\"v\":3,\"type\":\"room.leave\",\"roomId\":\"abcd-efgh-jkmp\"} true"))
				.isInstanceOf(MalformedJsonException.class);
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

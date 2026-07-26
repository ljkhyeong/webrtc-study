package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class ProtocolParserTest {

	private ProtocolParser parser;

	@BeforeEach
	void setUp() {
		parser = new ProtocolParser(new ObjectMapper());
	}

	@Test
	void parsesEveryClientMessageShape() {
		assertThat(parser.parse("""
				{"v":1,"type":"room.join","roomId":"Study-A","requestId":"join-1",
				 "payload":{"displayName":"Ada"}}
				"""))
				.isEqualTo(new ClientMessage.Join("Study-A", "join-1", "Ada"));

		assertThat(parser.parse("""
				{"v":1,"type":"room.leave","roomId":"Study-A"}
				"""))
				.isEqualTo(new ClientMessage.Leave("Study-A", null));

		ClientMessage.Relay offer = (ClientMessage.Relay) parser.parse("""
				{"v":1,"type":"rtc.offer","roomId":"Study-A","to":"peer-b",
				 "payload":{"description":{"type":"offer","sdp":"v=0"}}}
				""");
		assertThat(offer.type()).isEqualTo("rtc.offer");
		assertThat(offer.payload().at("/description/sdp").asText()).isEqualTo("v=0");

		ClientMessage.Relay answer = (ClientMessage.Relay) parser.parse("""
				{"v":1.0,"type":"rtc.answer","roomId":"Study-A","to":"peer-b",
				 "payload":{"description":{"type":"answer"}}}
				""");
		assertThat(answer.type()).isEqualTo("rtc.answer");

		ClientMessage.Relay ice = (ClientMessage.Relay) parser.parse("""
				{"v":1,"type":"rtc.ice","roomId":"Study-A","to":"peer-b",
				 "payload":{"candidate":{"candidate":"","sdpMid":null,
				 "sdpMLineIndex":0.0,"usernameFragment":"ufrag"}}}
				""");
		assertThat(ice.payload().at("/candidate/sdpMid").isNull()).isTrue();

		ClientMessage.Relay endOfCandidates = (ClientMessage.Relay) parser.parse("""
				{"v":1,"type":"rtc.ice","roomId":"Study-A","to":"peer-b",
				 "payload":{"candidate":null}}
				""");
		assertThat(endOfCandidates.payload().get("candidate").isNull()).isTrue();
	}

	@Test
	void rejectsUnknownAndClientOwnedSenderFieldsAtEveryLevel() {
		assertInvalid("""
				{"v":1,"type":"room.join","roomId":"room","from":"spoofed",
				 "payload":{"displayName":"Ada"}}
				""", "$.from");
		assertInvalid("""
				{"v":1,"type":"rtc.offer","roomId":"room","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":"v=0","extra":true}}}
				""", "$.payload.description.extra");
		assertInvalid("""
				{"v":1,"type":"rtc.ice","roomId":"room","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","networkCost":10}}}
				""", "$.payload.candidate.networkCost");
	}

	@Test
	void rejectsNullOptionalFieldsExceptIceNullableFields() {
		assertInvalid("""
				{"v":1,"type":"room.join","roomId":"room","requestId":null,
				 "payload":{"displayName":"Ada"}}
				""", "$.requestId");
		assertInvalid("""
				{"v":1,"type":"rtc.offer","roomId":"room","to":"peer",
				 "payload":{"description":{"type":"offer","sdp":null}}}
				""", "$.payload.description.sdp");
		assertInvalid("""
				{"v":1,"type":"rtc.offer","roomId":"room","to":null,
				 "payload":{"description":{"type":"offer"}}}
				""", "$.to");
	}

	@Test
	void enforcesNormalizedNamesAndAllLengthAndNumberBounds() {
		assertInvalid("""
				{"v":1,"type":"room.join","roomId":" room",
				 "payload":{"displayName":"Ada"}}
				""", "$.roomId");
		assertInvalid("""
				{"v":1,"type":"room.join","roomId":"room",
				 "payload":{"displayName":"Ada "}}
				""", "$.payload.displayName");
		assertInvalid("""
				{"v":1,"type":"rtc.ice","roomId":"room","to":"peer",
				 "payload":{"candidate":{"candidate":"candidate:1","sdpMLineIndex":65536}}}
				""", "$.payload.candidate.sdpMLineIndex");
		assertInvalid("""
				{"v":2,"type":"room.leave","roomId":"room"}
				""", "$.v");
	}

	@Test
	void matchesTheEcmaScriptTrimWhitespaceDefinition() {
		assertInvalid(
				"{\"v\":1,\"type\":\"room.join\",\"roomId\":\"room\","
						+ "\"payload\":{\"displayName\":\"\\u00a0Ada\"}}",
				"$.payload.displayName");
		assertInvalid(
				"{\"v\":1,\"type\":\"room.join\",\"roomId\":\"room\","
						+ "\"payload\":{\"displayName\":\"\\ufeff\"}}",
				"$.payload.displayName");

		ClientMessage.Join accepted = (ClientMessage.Join) parser.parse(
				"{\"v\":1,\"type\":\"room.join\",\"roomId\":\"\\u001croom\","
						+ "\"payload\":{\"displayName\":\"Ada\"}}");
		assertThat(accepted.roomId()).isEqualTo(Character.toString(0x1c) + "room");
	}

	@Test
	void rejectsMalformedJsonAndNonObjects() {
		assertInvalid("{", "$");
		assertInvalid("[]", "$");
		assertInvalid("null", "$");
		assertThatThrownBy(() -> parser.parse(
						"{\"v\":1,\"type\":\"room.leave\",\"roomId\":\"room\"} true"))
				.isInstanceOf(MalformedJsonException.class);
	}

	private void assertInvalid(String json, String expectedPath) {
		assertThatThrownBy(() -> parser.parse(json))
				.isInstanceOf(ProtocolValidationException.class)
				.hasMessageContaining(expectedPath);
	}
}

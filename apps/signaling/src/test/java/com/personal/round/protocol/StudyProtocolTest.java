package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class StudyProtocolTest {
	private final ProtocolParser parser = new ProtocolParser(new ObjectMapper());

	@Test
	void validatesDurationRevisionAndActionFields() {
		assertThat(parser.parse(frame("{\"action\":\"start\",\"expectedRevision\":0,\"mode\":\"focus\",\"durationSeconds\":60.0}"))).isInstanceOf(ClientMessage.Study.class);
		for (String duration : new String[] { "59", "60.5", "7201" }) {
			assertThatThrownBy(() -> parser.parse(frame("{\"action\":\"start\",\"expectedRevision\":0,\"mode\":\"focus\",\"durationSeconds\":" + duration + "}"))).isInstanceOf(ProtocolValidationException.class);
		}
		assertThatThrownBy(() -> parser.parse(frame("{\"action\":\"pause\",\"expectedRevision\":-1}"))).isInstanceOf(ProtocolValidationException.class);
		assertThatThrownBy(() -> parser.parse(frame("{\"action\":\"pause\",\"expectedRevision\":0,\"topic\":\"주제\"}"))).isInstanceOf(ProtocolValidationException.class);
		assertThat(parser.parse("{\"v\":3,\"type\":\"peer.reconnect\",\"roomId\":\"abcd-efgh-jkmp\",\"to\":\"peer\"}")).isInstanceOf(ClientMessage.Reconnect.class);
	}

	private String frame(String payload) {
		return "{\"v\":3,\"type\":\"room.study.update\",\"roomId\":\"abcd-efgh-jkmp\",\"payload\":" + payload + "}";
	}
}

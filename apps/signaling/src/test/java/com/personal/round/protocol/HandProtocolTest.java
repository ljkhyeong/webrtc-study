package com.personal.round.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class HandProtocolTest {
	private final ProtocolParser parser = new ProtocolParser(new ObjectMapper());

	@Test
	void 본인_손들기만_허용하고_대상_위조와_잘못된_값을_거부한다() {
		assertThat(parser.parse(frame("{\"raised\":true}")))
				.isEqualTo(new ClientMessage.Hand("abcd-efgh-jkmp", null, true));
		assertThat(parser.parse("{\"v\":3,\"type\":\"room.hand.sync\",\"roomId\":\"abcd-efgh-jkmp\"}"))
				.isEqualTo(new ClientMessage.Hand("abcd-efgh-jkmp", null, null));
		for (String payload : new String[] { "{}", "{\"raised\":null}", "{\"raised\":1}", "{\"raised\":true,\"peerId\":\"other\"}" }) {
			assertThatThrownBy(() -> parser.parse(frame(payload))).isInstanceOf(ProtocolValidationException.class);
		}
	}

	private String frame(String payload) {
		return "{\"v\":3,\"type\":\"room.hand.update\",\"roomId\":\"abcd-efgh-jkmp\",\"payload\":" + payload + "}";
	}
}

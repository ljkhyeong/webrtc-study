package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.personal.round.signaling.SignalingService;
import com.personal.round.signaling.SignalingWebSocketHandler;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class WebSocketConfigTest {

	@Test
	void productionProfileFailsBeforeRegistrationWhenDefaultHttpOriginsRemain() {
		MockEnvironment environment = new MockEnvironment();
		environment.setActiveProfiles("production");

		assertThatThrownBy(() -> new WebSocketConfig(
				mock(SignalingWebSocketHandler.class),
				mock(SignalingService.class),
				new SignalingProperties(),
				environment))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("HTTPS");
	}
}

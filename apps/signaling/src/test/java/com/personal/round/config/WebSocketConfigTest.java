package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingService;
import com.personal.round.signaling.SignalingWebSocketHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistration;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

class WebSocketConfigTest {

	private SignalingWebSocketHandler webSocketHandler;
	private SignalingService signalingService;
	private ConnectionAdmissionPolicy admissionPolicy;

	@BeforeEach
	void setUp() {
		webSocketHandler = mock(SignalingWebSocketHandler.class);
		signalingService = mock(SignalingService.class);
		admissionPolicy = mock(ConnectionAdmissionPolicy.class);
	}

	@Test
	void productionProfileFailsBeforeRegistrationWhenDefaultHttpOriginsRemain() {
		MockEnvironment environment = new MockEnvironment();
		environment.setActiveProfiles("production");

		assertThatThrownBy(() -> new WebSocketConfig(
				webSocketHandler,
				signalingService,
				admissionPolicy,
				TestProperties.signaling(),
				environment))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("HTTPS");
	}

	@Test
	void registersOriginCheckAndAdmissionHandlerWithoutDuplicateAdmissionInterceptor() {
		WebSocketHandlerRegistry registry = mock(WebSocketHandlerRegistry.class);
		WebSocketHandlerRegistration registration = mock(WebSocketHandlerRegistration.class);
		when(registry.addHandler(same(webSocketHandler), any(String[].class)))
				.thenReturn(registration);
		when(registration.addInterceptors(any(HandshakeInterceptor[].class)))
				.thenReturn(registration);
		when(registration.setHandshakeHandler(any(HandshakeHandler.class)))
				.thenReturn(registration);
		when(registration.setAllowedOriginPatterns(any(String[].class)))
				.thenReturn(registration);
		WebSocketConfig config = new WebSocketConfig(
				webSocketHandler,
				signalingService,
				admissionPolicy,
				TestProperties.signaling(),
				new MockEnvironment());

		config.registerWebSocketHandlers(registry);

		ArgumentCaptor<HandshakeInterceptor[]> interceptors =
				ArgumentCaptor.forClass(HandshakeInterceptor[].class);
		verify(registration).addInterceptors(interceptors.capture());
		assertThat(interceptors.getValue())
				.singleElement()
				.isInstanceOf(OriginHandshakeInterceptor.class);
		verify(registration).setHandshakeHandler(
				any(ConnectionAdmissionHandshakeHandler.class));
	}
}

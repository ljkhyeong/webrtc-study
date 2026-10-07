package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.auth.RoundAuthProperties;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingService;
import com.personal.round.signaling.SignalingWebSocketHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Answers;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistration;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import tools.jackson.databind.ObjectMapper;

class WebSocketConfigTest {

	private SignalingWebSocketHandler webSocketHandler;
	private SignalingService signalingService;
	private ConnectionAdmissionPolicy admissionPolicy;
	private WebSocketHandlerRegistry registry;

	@BeforeEach
	void setUp() {
		webSocketHandler = mock(SignalingWebSocketHandler.class);
		signalingService = mock(SignalingService.class);
		admissionPolicy = mock(ConnectionAdmissionPolicy.class);
		registry = mock(WebSocketHandlerRegistry.class);
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
				TestProperties.standaloneAuth(),
				environment, new ObjectMapper()))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("HTTPS");
	}

	@Test
	void registersOriginCheckAndAdmissionHandlerWithoutDuplicateAdmissionInterceptor() {
		WebSocketHandlerRegistration registration = register(TestProperties.standaloneAuth());

		verify(registry).addHandler(same(webSocketHandler), eq(new String[] {"/signal"}));
		verify(registration).setAllowedOrigins(
				TestProperties.signaling().allowedOrigins().toArray(String[]::new));
		verify(registration).setHandshakeHandler(any(ConnectionAdmissionHandshakeHandler.class));
	}

	@Test
	void batonModeRegistersOnlyTheRoomScopedEndpoint() {
		register(TestProperties.batonAuth());

		verify(registry).addHandler(
				same(webSocketHandler),
				eq(new String[] {"/rooms/{roomId}/signal"}));
	}

	// 등록 체인의 설정 메서드는 RETURNS_SELF로 같은 등록 객체를 돌려준다.
	private WebSocketHandlerRegistration register(RoundAuthProperties authProperties) {
		WebSocketHandlerRegistration registration =
				mock(WebSocketHandlerRegistration.class, Answers.RETURNS_SELF);
		when(registry.addHandler(same(webSocketHandler), any(String[].class)))
				.thenReturn(registration);
		new WebSocketConfig(
				webSocketHandler,
				signalingService,
				admissionPolicy,
				TestProperties.signaling(),
				authProperties,
				new MockEnvironment(), new ObjectMapper())
				.registerWebSocketHandlers(registry);

		ArgumentCaptor<HandshakeInterceptor[]> interceptors =
				ArgumentCaptor.forClass(HandshakeInterceptor[].class);
		verify(registration).addInterceptors(interceptors.capture());
		assertThat(interceptors.getValue())
				.extracting(Object::getClass)
				.containsExactly(ClientCompatibilityHandshakeInterceptor.class);
		return registration;
	}
}

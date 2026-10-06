package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
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
import tools.jackson.databind.ObjectMapper;

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
				TestProperties.standaloneAuth(),
				environment, new ObjectMapper()))
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
		when(registration.setAllowedOrigins(any(String[].class)))
				.thenReturn(registration);
		WebSocketConfig config = new WebSocketConfig(
				webSocketHandler,
				signalingService,
				admissionPolicy,
				TestProperties.signaling(),
				TestProperties.standaloneAuth(),
				new MockEnvironment(), new ObjectMapper());

		config.registerWebSocketHandlers(registry);

		ArgumentCaptor<HandshakeInterceptor[]> interceptors =
				ArgumentCaptor.forClass(HandshakeInterceptor[].class);
		verify(registration).addInterceptors(interceptors.capture());
		assertThat(interceptors.getValue())
				.extracting(Object::getClass)
				.containsExactly(ClientCompatibilityHandshakeInterceptor.class);
		verify(registration).setAllowedOrigins(TestProperties.signaling().allowedOrigins().toArray(String[]::new));
		verify(registry).addHandler(same(webSocketHandler), eq(new String[] {"/signal"}));
		verify(registration).setHandshakeHandler(
				any(ConnectionAdmissionHandshakeHandler.class));
	}

	@Test
	void batonModeRegistersOnlyTheRoomScopedEndpoint() {
		WebSocketHandlerRegistry registry = mock(WebSocketHandlerRegistry.class);
		WebSocketHandlerRegistration registration = mock(WebSocketHandlerRegistration.class);
		when(registry.addHandler(same(webSocketHandler), any(String[].class)))
				.thenReturn(registration);
		when(registration.addInterceptors(any(HandshakeInterceptor[].class)))
				.thenReturn(registration);
		when(registration.setHandshakeHandler(any(HandshakeHandler.class)))
				.thenReturn(registration);
		when(registration.setAllowedOrigins(any(String[].class)))
				.thenReturn(registration);
		WebSocketConfig config = new WebSocketConfig(
				webSocketHandler,
				signalingService,
				admissionPolicy,
				TestProperties.signaling(),
				TestProperties.batonAuth(),
				new MockEnvironment(), new ObjectMapper());

		config.registerWebSocketHandlers(registry);

		ArgumentCaptor<HandshakeInterceptor[]> interceptors =
				ArgumentCaptor.forClass(HandshakeInterceptor[].class);
		verify(registration).addInterceptors(interceptors.capture());
		assertThat(interceptors.getValue())
				.extracting(Object::getClass)
				.containsExactly(ClientCompatibilityHandshakeInterceptor.class);
		verify(registry).addHandler(
				same(webSocketHandler),
				eq(new String[] {"/rooms/{roomId}/signal"}));
	}
}

package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.net.ClientAddressKeyResolver;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingMetrics;
import com.personal.round.signaling.SignalingService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetSocketAddress;
import java.security.Principal;
import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeFailureException;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

class ConnectionAdmissionHandshakeHandlerTest {

	private static final InetSocketAddress REMOTE_ADDRESS =
			new InetSocketAddress("192.0.2.20", 41_000);

	private SignalingService service;
	private ConnectionAdmissionPolicy policy;
	private DefaultHandshakeHandler delegate;
	private ConnectionAdmissionHandshakeHandler handler;
	private MockHttpServletRequest nativeRequest;
	private ServletServerHttpRequest request;
	private ServerHttpResponse response;
	private WebSocketHandler webSocketHandler;

	@BeforeEach
	void setUp() {
		service = mock(SignalingService.class);
		policy = new ConnectionAdmissionPolicy(
				TestProperties.signalingWithConnectionLimits(6, 1_000, 1),
				new SignalingMetrics(new SimpleMeterRegistry()),
				new ClientAddressKeyResolver());
		delegate = mock(DefaultHandshakeHandler.class);
		handler = new ConnectionAdmissionHandshakeHandler(service, policy, delegate);
		nativeRequest = new MockHttpServletRequest();
		nativeRequest.setRemoteAddr(REMOTE_ADDRESS.getAddress().getHostAddress());
		nativeRequest.setRemotePort(REMOTE_ADDRESS.getPort());
		request = new ServletServerHttpRequest(nativeRequest);
		response = mock(ServerHttpResponse.class);
		webSocketHandler = mock(WebSocketHandler.class);
		when(service.isAcceptingConnections()).thenReturn(true);
	}

	@Test
	void keepsTheReservationOnlyWhenTheUpgradeSucceeds() {
		Map<String, Object> failedAttributes = new HashMap<>();
		Map<String, Object> successfulAttributes = new HashMap<>();
		when(delegate.doHandshake(any(), any(), any(), any()))
				.thenReturn(false)
				.thenReturn(true);

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				failedAttributes)).isFalse();
		assertThat(failedAttributes)
				.doesNotContainKey(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				successfulAttributes)).isTrue();
		assertThat(successfulAttributes)
				.containsKey(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		release(successfulAttributes);
	}

	@Test
	void releasesTheReservationWhenTheUpgradeThrows() {
		Map<String, Object> failedAttributes = new HashMap<>();
		when(delegate.doHandshake(any(), any(), any(), any()))
				.thenThrow(new HandshakeFailureException("upgrade failed"))
				.thenReturn(true);

		assertThatThrownBy(() -> handler.doHandshake(
				request,
				response,
				webSocketHandler,
				failedAttributes))
				.isInstanceOf(HandshakeFailureException.class);
		assertThat(failedAttributes)
				.doesNotContainKey(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);

		Map<String, Object> retryAttributes = new HashMap<>();
		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				retryAttributes)).isTrue();
		release(retryAttributes);
	}

	@Test
	void rejectsAnotherSocketFromTheSameClientUntilTheLeaseIsReleased() {
		Map<String, Object> firstAttributes = new HashMap<>();
		when(delegate.doHandshake(any(), any(), any(), any())).thenReturn(true);
		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				firstAttributes)).isTrue();

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				new HashMap<>())).isFalse();
		verify(response).setStatusCode(HttpStatus.TOO_MANY_REQUESTS);

		release(firstAttributes);
	}

	@Test
	void mapsParticipationTokenCapacityToTooManyRequests() {
		policy = new ConnectionAdmissionPolicy(
				TestProperties.signalingWithConnectionLimits(6, 1_000, 4),
				new SignalingMetrics(new SimpleMeterRegistry()),
				new ClientAddressKeyResolver());
		handler = new ConnectionAdmissionHandshakeHandler(service, policy, delegate);
		when(delegate.doHandshake(any(), any(), any(), any())).thenReturn(true);
		ParticipationGrant grant = grant();
		Map<String, Object> firstAttributes = new HashMap<>();
		firstAttributes.put(ParticipationGrant.SESSION_ATTRIBUTE, grant);
		Map<String, Object> replayAttributes = new HashMap<>();
		replayAttributes.put(ParticipationGrant.SESSION_ATTRIBUTE, grant);

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				firstAttributes)).isTrue();
		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				replayAttributes)).isFalse();

		verify(response).setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
		assertThat(replayAttributes)
				.doesNotContainKey(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		release(firstAttributes);
	}

	@Test
	void refusesBeforeAllocatingWhenShutdownHasStarted() {
		when(service.isAcceptingConnections()).thenReturn(false);

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				new HashMap<>())).isFalse();
		verify(response).setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
	}

	@Test
	void removesSensitiveHeadersBeforeTheUpgradeCopiesThemIntoTheSession() {
		nativeRequest.addHeader(
				HttpHeaders.COOKIE,
				"__Secure-round_access=raw-jwt; preference=compact");
		nativeRequest.addHeader(HttpHeaders.AUTHORIZATION, "Bearer raw-jwt");
		nativeRequest.addHeader(HttpHeaders.PROXY_AUTHORIZATION, "Basic proxy-secret");
		nativeRequest.addHeader(HttpHeaders.ORIGIN, "https://study.example.com");
		nativeRequest.addHeader(HttpHeaders.UPGRADE, "websocket");
		nativeRequest.addHeader(HttpHeaders.CONNECTION, "Upgrade");
		nativeRequest.addHeader("Sec-WebSocket-Key", "test-key");
		nativeRequest.setCookies(
				new Cookie("__Secure-round_access", "raw-jwt"),
				new Cookie("preference", "compact"));
		Principal originalPrincipal = () -> "raw-jwt-principal";
		nativeRequest.setUserPrincipal(originalPrincipal);
		when(delegate.doHandshake(any(), any(), any(), any())).thenReturn(true);
		Map<String, Object> attributes = new HashMap<>();
		attributes.put(ParticipationGrant.SESSION_ATTRIBUTE, grant());

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				attributes)).isTrue();

		ArgumentCaptor<ServerHttpRequest> requestCaptor =
				ArgumentCaptor.forClass(ServerHttpRequest.class);
		verify(delegate).doHandshake(requestCaptor.capture(), any(), any(), any());
		ServerHttpRequest upgradeRequest = requestCaptor.getValue();
		HttpHeaders upgradeHeaders = upgradeRequest.getHeaders();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.COOKIE)).isFalse();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.AUTHORIZATION)).isFalse();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.PROXY_AUTHORIZATION)).isFalse();
		assertThat(upgradeHeaders.get(HttpHeaders.ORIGIN))
				.containsExactly("https://study.example.com");
		assertThat(upgradeHeaders.getFirst(HttpHeaders.UPGRADE)).isEqualTo("websocket");
		assertThat(upgradeRequest.getPrincipal().getName()).isEqualTo("member-42");
		assertThat(upgradeRequest.getPrincipal()).isNotSameAs(originalPrincipal);
		assertThat(upgradeRequest.getPrincipal())
				.asString()
				.doesNotContain("member-42", "raw-jwt");
		assertThat(upgradeRequest).isInstanceOf(ServletServerHttpRequest.class);
		HttpServletRequest sanitizedNativeRequest =
				((ServletServerHttpRequest) upgradeRequest).getServletRequest();
		assertThat(Collections.list(sanitizedNativeRequest.getHeaderNames()))
				.doesNotContain(
						HttpHeaders.COOKIE,
						HttpHeaders.AUTHORIZATION,
						HttpHeaders.PROXY_AUTHORIZATION)
				.contains(
						HttpHeaders.ORIGIN,
						HttpHeaders.UPGRADE,
						HttpHeaders.CONNECTION,
						"Sec-WebSocket-Key");
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.COOKIE)).isNull();
		assertThat(Collections.list(
				sanitizedNativeRequest.getHeaders(HttpHeaders.AUTHORIZATION))).isEmpty();
		assertThat(sanitizedNativeRequest.getCookies()).isNull();
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.ORIGIN))
				.isEqualTo("https://study.example.com");
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.UPGRADE))
				.isEqualTo("websocket");
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.CONNECTION))
				.isEqualTo("Upgrade");
		assertThat(sanitizedNativeRequest.getHeader("Sec-WebSocket-Key"))
				.isEqualTo("test-key");
		assertThat(sanitizedNativeRequest.getUserPrincipal().getName())
				.isEqualTo("member-42");
		assertThat(sanitizedNativeRequest.getUserPrincipal())
				.isNotSameAs(originalPrincipal);
		assertThat(sanitizedNativeRequest.getRemoteUser()).isEqualTo("member-42");
		release(attributes);
	}

	private static void release(Map<String, Object> attributes) {
		Object reservation = attributes.remove(
				ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		assertThat(reservation)
				.isInstanceOf(ConnectionAdmissionPolicy.Reservation.class);
		((ConnectionAdmissionPolicy.Reservation) reservation).close();
	}

	private static ParticipationGrant grant() {
		return new ParticipationGrant(
				"member-42",
				"study-7",
				"abcd-efgh-jkmp",
				ParticipationGrant.Role.PARTICIPANT,
				"ticket-1",
				Instant.parse("2026-07-30T00:00:00Z"),
				Instant.parse("2026-07-30T00:05:00Z"));
	}
}

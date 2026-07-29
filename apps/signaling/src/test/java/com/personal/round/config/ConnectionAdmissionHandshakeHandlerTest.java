package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.net.ClientAddressKeyResolver;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingMetrics;
import com.personal.round.signaling.SignalingService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeFailureException;
import org.springframework.web.socket.server.HandshakeHandler;

class ConnectionAdmissionHandshakeHandlerTest {

	private static final InetSocketAddress REMOTE_ADDRESS =
			new InetSocketAddress("192.0.2.20", 41_000);

	private SignalingService service;
	private ConnectionAdmissionPolicy policy;
	private HandshakeHandler delegate;
	private ConnectionAdmissionHandshakeHandler handler;
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
		delegate = mock(HandshakeHandler.class);
		handler = new ConnectionAdmissionHandshakeHandler(service, policy, delegate);
		request = mock(ServletServerHttpRequest.class);
		response = mock(ServerHttpResponse.class);
		webSocketHandler = mock(WebSocketHandler.class);
		when(service.isAcceptingConnections()).thenReturn(true);
		when(request.getServletRequest()).thenReturn(mock(HttpServletRequest.class));
		when(request.getRemoteAddress()).thenReturn(REMOTE_ADDRESS);
		when(request.getHeaders()).thenReturn(new HttpHeaders());
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
		HttpHeaders originalHeaders = new HttpHeaders();
		originalHeaders.add(HttpHeaders.COOKIE, "__Secure-round_access=raw-jwt");
		originalHeaders.add(HttpHeaders.AUTHORIZATION, "Bearer raw-jwt");
		originalHeaders.add(HttpHeaders.PROXY_AUTHORIZATION, "Basic proxy-secret");
		originalHeaders.add(HttpHeaders.ORIGIN, "https://study.example.com");
		when(request.getHeaders()).thenReturn(originalHeaders);
		when(delegate.doHandshake(any(), any(), any(), any())).thenReturn(true);
		Map<String, Object> attributes = new HashMap<>();

		assertThat(handler.doHandshake(
				request,
				response,
				webSocketHandler,
				attributes)).isTrue();

		ArgumentCaptor<ServerHttpRequest> requestCaptor =
				ArgumentCaptor.forClass(ServerHttpRequest.class);
		verify(delegate).doHandshake(requestCaptor.capture(), any(), any(), any());
		HttpHeaders upgradeHeaders = requestCaptor.getValue().getHeaders();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.COOKIE)).isFalse();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.AUTHORIZATION)).isFalse();
		assertThat(upgradeHeaders.containsHeader(HttpHeaders.PROXY_AUTHORIZATION)).isFalse();
		assertThat(upgradeHeaders.get(HttpHeaders.ORIGIN))
				.containsExactly("https://study.example.com");
		assertThat(originalHeaders.containsHeader(HttpHeaders.COOKIE)).isTrue();
		release(attributes);
	}

	private static void release(Map<String, Object> attributes) {
		Object reservation = attributes.remove(
				ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		assertThat(reservation)
				.isInstanceOf(ConnectionAdmissionPolicy.Reservation.class);
		((ConnectionAdmissionPolicy.Reservation) reservation).close();
	}
}

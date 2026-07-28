package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingMetrics;
import com.personal.round.signaling.SignalingService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
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
	private ServerHttpRequest request;
	private ServerHttpResponse response;
	private WebSocketHandler webSocketHandler;

	@BeforeEach
	void setUp() {
		service = mock(SignalingService.class);
		SignalingProperties properties = new SignalingProperties();
		properties.setMaxConnectionsPerClient(1);
		policy = new ConnectionAdmissionPolicy(
				properties,
				new SignalingMetrics(new SimpleMeterRegistry()));
		delegate = mock(HandshakeHandler.class);
		handler = new ConnectionAdmissionHandshakeHandler(service, policy, delegate);
		request = mock(ServerHttpRequest.class);
		response = mock(ServerHttpResponse.class);
		webSocketHandler = mock(WebSocketHandler.class);
		when(service.isAcceptingConnections()).thenReturn(true);
		when(request.getRemoteAddress()).thenReturn(REMOTE_ADDRESS);
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

	private static void release(Map<String, Object> attributes) {
		Object reservation = attributes.remove(
				ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		assertThat(reservation)
				.isInstanceOf(ConnectionAdmissionPolicy.Reservation.class);
		((ConnectionAdmissionPolicy.Reservation) reservation).close();
	}
}

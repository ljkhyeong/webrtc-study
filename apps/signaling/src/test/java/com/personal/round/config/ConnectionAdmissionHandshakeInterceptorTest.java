package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.signaling.SignalingService;
import java.util.HashMap;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;

class ConnectionAdmissionHandshakeInterceptorTest {

	@Test
	void refusesTheHandshakeAfterShutdownBegins() {
		SignalingService service = mock(SignalingService.class);
		ServerHttpRequest request = mock(ServerHttpRequest.class);
		ServerHttpResponse response = mock(ServerHttpResponse.class);
		ConnectionAdmissionHandshakeInterceptor interceptor =
				new ConnectionAdmissionHandshakeInterceptor(service);

		when(service.isAcceptingConnections()).thenReturn(false);

		assertThat(interceptor.beforeHandshake(
				request,
				response,
				mock(WebSocketHandler.class),
				new HashMap<>())).isFalse();
		verify(response).setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
	}
}

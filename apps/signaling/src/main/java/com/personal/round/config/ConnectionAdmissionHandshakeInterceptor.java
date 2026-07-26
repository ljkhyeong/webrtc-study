package com.personal.round.config;

import com.personal.round.signaling.SignalingService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

public final class ConnectionAdmissionHandshakeInterceptor implements HandshakeInterceptor {

	private final SignalingService signalingService;

	public ConnectionAdmissionHandshakeInterceptor(SignalingService signalingService) {
		this.signalingService = signalingService;
	}

	@Override
	public boolean beforeHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes) {
		if (signalingService.isAcceptingConnections()) {
			return true;
		}
		response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
		return false;
	}

	@Override
	public void afterHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Exception exception) {
		// Admission does not allocate resources.
	}
}

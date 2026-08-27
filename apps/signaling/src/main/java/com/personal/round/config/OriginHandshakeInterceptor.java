package com.personal.round.config;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

public final class OriginHandshakeInterceptor implements HandshakeInterceptor {

	private final OriginPolicy originPolicy;

	public OriginHandshakeInterceptor(OriginPolicy originPolicy) {
		this.originPolicy = originPolicy;
	}

	@Override
	public boolean beforeHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes) {
		String origin = request.getHeaders().getOrigin();
		if (originPolicy.allows(origin)) {
			return true;
		}
		response.setStatusCode(HttpStatus.FORBIDDEN);
		return false;
	}

	@Override
	public void afterHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Exception exception) {
		// 핸드셰이크 중에는 할당한 자원이 없다.
	}
}

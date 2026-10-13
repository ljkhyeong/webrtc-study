package com.personal.round.config;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.signaling.SignalingService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.security.core.Authentication;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.web.util.WebUtils;

/**
 * BATON 참여권을 갱신한 화면이 보낸 `GET ...?lease={peerId}`로 같은 참가자의 기존 연결을 연장한다.
 * 방 일치는 보안 필터 체인이 확인했으며 새 연결이나 방 상태는 만들지 않는다. 캐시 금지 헤더는 Spring Security가 붙인다.
 */
public final class ParticipationLeaseHandshakeInterceptor implements HandshakeInterceptor {
	private final CorsConfiguration cors = new CorsConfiguration();
	private final SignalingService signalingService;

	ParticipationLeaseHandshakeInterceptor(List<String> allowedOrigins, SignalingService signalingService) {
		cors.setAllowedOrigins(allowedOrigins);
		this.signalingService = signalingService;
	}

	@Override
	public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
			WebSocketHandler handler, Map<String, Object> attributes) {
		if (request.getMethod() != HttpMethod.GET
				|| "websocket".equalsIgnoreCase(request.getHeaders().getUpgrade())) {
			return true;
		}
		var query = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams();
		if (!query.containsKey("lease")) {
			return true;
		}
		response.setStatusCode(renew(request, query.getFirst("lease")));
		return false;
	}

	private HttpStatus renew(ServerHttpRequest request, String peerId) {
		String origin = request.getHeaders().getOrigin();
		if (origin != null && !WebUtils.isSameOrigin(request) && cors.checkOrigin(origin) == null) {
			return HttpStatus.FORBIDDEN;
		}
		if (peerId == null || peerId.isBlank() || peerId.length() > ProtocolParser.MAX_PEER_ID_LENGTH) {
			return HttpStatus.BAD_REQUEST;
		}
		if (!(request instanceof ServletServerHttpRequest servletRequest)
				|| !(servletRequest.getServletRequest().getUserPrincipal()
						instanceof Authentication authentication)
				|| !(authentication.getPrincipal() instanceof ParticipationGrant grant)) {
			return HttpStatus.NOT_FOUND;
		}
		if (!signalingService.isRunning()) {
			return HttpStatus.SERVICE_UNAVAILABLE;
		}
		return switch (signalingService.renewParticipationLease(peerId, grant)) {
			case RENEWED -> HttpStatus.NO_CONTENT;
			case NOT_JOINED -> HttpStatus.NOT_FOUND;
			case FORBIDDEN -> HttpStatus.FORBIDDEN;
		};
	}

	@Override
	public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
			WebSocketHandler handler, Exception exception) {
		// 연장 요청에는 연결 자원과 방 상태가 없다.
	}
}

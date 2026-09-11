package com.personal.round.auth;

import com.personal.round.config.RoundRoutes;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.PathContainer;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

public final class ParticipationGrantHandshakeInterceptor implements HandshakeInterceptor {

	private static final PathPattern SIGNALING_PATH =
			PathPatternParser.defaultInstance.parse(RoundRoutes.BATON_SIGNAL_TEMPLATE);

	private final ParticipationGrantResolver grantResolver;

	public ParticipationGrantHandshakeInterceptor(ParticipationGrantResolver grantResolver) {
		this.grantResolver = grantResolver;
	}

	@Override
	public boolean beforeHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes) {
		PathPattern.PathMatchInfo match = SIGNALING_PATH.matchAndExtract(
				PathContainer.parsePath(request.getURI().getPath()));
		ParticipationGrant grant = grantResolver.resolve(request.getPrincipal()).orElse(null);
		String pathRoomId = match == null ? null : match.getUriVariables().get("roomId");
		if (grant == null || !grant.allows(pathRoomId)) {
			response.setStatusCode(HttpStatus.FORBIDDEN);
			return false;
		}
		attributes.put(ParticipationGrant.SESSION_ATTRIBUTE, grant);
		return true;
	}

	@Override
	public void afterHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Exception exception) {
		// 업그레이드가 성공하면 WebSocket 세션이 연결 당시 참여권과 만료 시점을 관리한다.
	}
}

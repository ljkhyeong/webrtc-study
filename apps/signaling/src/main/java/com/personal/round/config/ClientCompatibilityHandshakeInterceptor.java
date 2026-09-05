package com.personal.round.config;

import com.personal.round.protocol.ProtocolParser;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.databind.ObjectMapper;

/** HTTP 지원 기능 조회만 응답하고 일반 WebSocket 연결은 다음 단계로 전달한다. */
public final class ClientCompatibilityHandshakeInterceptor implements HandshakeInterceptor {
	private final OriginPolicy originPolicy;
	private final byte[] responseBody;

	public ClientCompatibilityHandshakeInterceptor(OriginPolicy originPolicy, ObjectMapper mapper) {
		this.originPolicy = originPolicy;
		this.responseBody = mapper.writeValueAsBytes(Map.of(
				"protocolVersion", ProtocolParser.PROTOCOL_VERSION,
				"capabilities", List.of("peer.reconnect", "room.study", "room.hand")));
	}

	@Override
	public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
			WebSocketHandler handler, Map<String, Object> attributes) throws Exception {
		if (request.getMethod() != HttpMethod.GET || "websocket".equalsIgnoreCase(request.getHeaders().getUpgrade())
				|| !UriComponentsBuilder.fromUri(request.getURI()).build()
						.getQueryParams().containsKey("compatibility")) {
			return true;
		}
		response.getHeaders().setCacheControl("no-store");
		String origin = request.getHeaders().getOrigin();
		if (origin != null) {
			if (!originPolicy.allows(origin)) {
				response.setStatusCode(HttpStatus.FORBIDDEN);
				return false;
			}
			response.getHeaders().setAccessControlAllowOrigin(origin);
			response.getHeaders().setVary(List.of("Origin"));
		}
		response.setStatusCode(HttpStatus.OK);
		response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
		response.getBody().write(responseBody);
		return false;
	}

	@Override
	public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
			WebSocketHandler handler, Exception exception) {
		// 조회 응답에는 연결 자원과 방 상태가 없다.
	}
}

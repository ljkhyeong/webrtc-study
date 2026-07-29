package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import java.security.Principal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.socket.WebSocketHandler;

class RoomPrincipalHandshakeHandlerTest {

	@Test
	void replacesTheJwtAuthenticationWithATokenFreeParticipantPrincipal() {
		RoomPrincipalHandshakeHandler handler = new RoomPrincipalHandshakeHandler();
		ServerHttpRequest request = requestWith(jwtAuthentication());
		Map<String, Object> attributes = new HashMap<>();
		attributes.put(
				ParticipationGrant.SESSION_ATTRIBUTE,
				new ParticipationGrant(
						"member-42",
						"study-7",
						"abcd-efgh-jkmp",
						ParticipationGrant.Role.PARTICIPANT,
						"ticket-1",
						Instant.parse("2026-07-29T00:00:00Z"),
						Instant.parse("2026-07-29T00:05:00Z")));

		Principal principal = handler.determineUser(
				request,
				mock(WebSocketHandler.class),
				attributes);

		assertThat(principal).isNotInstanceOf(JwtAuthenticationToken.class);
		assertThat(principal.getName()).isEqualTo("member-42");
		assertThat(principal.toString()).doesNotContain("member-42", "raw-token");
	}

	@Test
	void preservesTheDefaultPrincipalWhenNoBatonGrantExists() {
		Principal original = () -> "standalone-user";
		RoomPrincipalHandshakeHandler handler = new RoomPrincipalHandshakeHandler();

		Principal principal = handler.determineUser(
				requestWith(original),
				mock(WebSocketHandler.class),
				Map.of());

		assertThat(principal).isSameAs(original);
	}

	private static ServerHttpRequest requestWith(Principal principal) {
		ServerHttpRequest request = mock(ServerHttpRequest.class);
		when(request.getPrincipal()).thenReturn(principal);
		return request;
	}

	private static JwtAuthenticationToken jwtAuthentication() {
		Jwt jwt = Jwt.withTokenValue("raw-token")
				.header("alg", "RS256")
				.subject("member-42")
				.issuedAt(Instant.parse("2026-07-29T00:00:00Z"))
				.expiresAt(Instant.parse("2026-07-29T00:05:00Z"))
				.build();
		return new JwtAuthenticationToken(jwt);
	}
}

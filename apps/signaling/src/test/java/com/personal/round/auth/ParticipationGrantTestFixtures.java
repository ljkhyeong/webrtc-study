package com.personal.round.auth;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

final class ParticipationGrantTestFixtures {

	static final String ROOM_ID = "abcd-efgh-jkmp";
	static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";
	static final Instant ISSUED_AT = Instant.parse("2026-07-29T00:00:00Z");
	static final Instant EXPIRES_AT = Instant.parse("2026-07-29T00:05:00Z");

	private ParticipationGrantTestFixtures() {
	}

	static Jwt validJwt() {
		return jwt(claims -> {
		});
	}

	static Jwt jwt(Consumer<Map<String, Object>> claimCustomizer) {
		return Jwt.withTokenValue("signed-participation-ticket")
				.header("alg", "RS256")
				.issuer("https://baton.example/oauth2")
				.subject("member-42")
				.audience(List.of("round"))
				.issuedAt(ISSUED_AT)
				.expiresAt(EXPIRES_AT)
				.claim("jti", "ticket-123")
				.claim("study_id", "study-7")
				.claim("room_id", ROOM_ID)
				.claim("role", "participant")
				.claims(claimCustomizer)
				.build();
	}

	static JwtAuthenticationToken authentication() {
		return new JwtAuthenticationToken(validJwt());
	}

	static Jwt jwtWithLifetime(Instant issuedAt, Instant expiresAt) {
		Jwt jwt = mock(Jwt.class);
		when(jwt.getSubject()).thenReturn("member-42");
		when(jwt.getClaimAsString("study_id")).thenReturn("study-7");
		when(jwt.getClaimAsString("room_id")).thenReturn(ROOM_ID);
		when(jwt.getId()).thenReturn("ticket-123");
		when(jwt.getClaimAsString("role")).thenReturn("participant");
		when(jwt.getIssuedAt()).thenReturn(issuedAt);
		when(jwt.getExpiresAt()).thenReturn(expiresAt);
		when(jwt.getAudience()).thenReturn(List.of("round"));
		return jwt;
	}

	static ParticipationGrant grant() {
		return new ParticipationGrant(
				"member-42",
				"study-7",
				ROOM_ID,
				ParticipationGrant.Role.PARTICIPANT,
				"ticket-123",
				ISSUED_AT,
				EXPIRES_AT);
	}

	static RoundAuthProperties standaloneProperties() {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.STANDALONE,
				"round_access",
				null,
				"round",
				null,
				null,
				Duration.ofMinutes(5));
	}

	static RoundAuthProperties batonProperties() {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				null,
				Duration.ofMinutes(5));
	}
}

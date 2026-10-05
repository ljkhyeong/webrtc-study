package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.ACCOUNT_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.EXPIRES_AT;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ISSUED_AT;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.jwt;
import static com.personal.round.auth.ParticipationGrantTestFixtures.jwtWithLifetime;
import static com.personal.round.auth.ParticipationGrantTestFixtures.validJwt;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;

class ParticipationGrantAuthenticationConverterTest {

	private final ParticipationGrantAuthenticationConverter converter =
			new ParticipationGrantAuthenticationConverter();

	@Test
	void makesTheParticipationGrantTheAuthenticatedPrincipal() {
		Authentication authentication = converter.convert(validJwt());
		ParticipationGrant grant = (ParticipationGrant) authentication.getPrincipal();

		assertThat(authentication.isAuthenticated()).isTrue();
		assertThat(authentication.getName()).isEqualTo(ACCOUNT_ID);
		assertThat(authentication.getAuthorities()).isEmpty();

		assertThat(grant.subject()).isEqualTo(ACCOUNT_ID);
		assertThat(grant.studyId()).isEqualTo("study-7");
		assertThat(grant.roomId()).isEqualTo(ROOM_ID);
		assertThat(grant.role()).isEqualTo(ParticipationGrant.Role.PARTICIPANT);
		assertThat(grant.tokenId()).isEqualTo("ticket-123");
		assertThat(grant.issuedAt()).isEqualTo(ISSUED_AT);
		assertThat(grant.expiresAt()).isEqualTo(EXPIRES_AT);
		assertThat(grant.allows(ROOM_ID)).isTrue();
	}

	@Test
	void mapsTheExactHostRoleClaim() {
		Jwt jwt = jwt(claims -> claims.put("role", "host"));

		assertThat(grantOf(jwt).role()).isEqualTo(ParticipationGrant.Role.HOST);
	}

	@Test
	void rejectsEveryMissingRequiredIdentityAndAuthorizationClaim() {
		for (String claim : List.of("sub", "study_id", "room_id", "jti", "role")) {
			assertRejected("missing claim " + claim, jwt(claims -> claims.remove(claim)));
		}
	}

	@Test
	void rejectsMissingOrNonIncreasingGrantLifetime() {
		assertRejected("missing iat", jwt(claims -> claims.remove("iat")));
		assertRejected("missing exp", jwt(claims -> claims.remove("exp")));
		assertRejected("zero lifetime", jwtWithLifetime(ISSUED_AT, ISSUED_AT));
		assertRejected("negative lifetime", jwtWithLifetime(EXPIRES_AT, ISSUED_AT));
	}

	@Test
	void rejectsUnsupportedRoleNonCanonicalRoomAndUnboundedClaims() {
		assertRejected("unknown role", jwt(claims -> claims.put("role", "observer")));
		assertRejected("uppercase role", jwt(claims -> claims.put("role", "PARTICIPANT")));
		assertRejected("room id", jwt(claims -> claims.put("room_id", "NOT-A-ROOM")));
		assertRejected("long study id", jwt(claims -> claims.put("study_id", "s".repeat(257))));
		assertRejected("padded subject", jwt(claims -> claims.put("sub", " " + ACCOUNT_ID + " ")));
	}

	@Test
	void rejectsNonUuidAndNonCanonicalUuidSubjects() {
		assertRejected("non UUID", jwt(claims -> claims.put("sub", "member-42")));
		// UUID.fromString은 짧은 그룹도 받아들이지만 BATON은 정규 UUID 문자열만 발급한다.
		assertRejected("shortened UUID", jwt(claims -> claims.put("sub", "1-1-1-1-1")));
		assertRejected(
				"uppercase UUID",
				jwt(claims -> claims.put("sub", ACCOUNT_ID.toUpperCase())));
	}

	private ParticipationGrant grantOf(Jwt jwt) {
		return (ParticipationGrant) converter.convert(jwt).getPrincipal();
	}

	private void assertRejected(String description, Jwt jwt) {
		assertThatThrownBy(() -> converter.convert(jwt))
				.as(description)
				.isInstanceOf(InvalidBearerTokenException.class);
	}
}

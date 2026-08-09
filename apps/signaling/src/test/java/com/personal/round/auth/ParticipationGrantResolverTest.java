package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.ACCOUNT_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.EXPIRES_AT;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ISSUED_AT;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.authentication;
import static com.personal.round.auth.ParticipationGrantTestFixtures.jwt;
import static com.personal.round.auth.ParticipationGrantTestFixtures.jwtWithLifetime;
import static com.personal.round.auth.ParticipationGrantTestFixtures.validJwt;
import static org.assertj.core.api.Assertions.assertThat;

import java.security.Principal;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

class ParticipationGrantResolverTest {

	private final ParticipationGrantResolver resolver = new ParticipationGrantResolver();

	@Test
	void mapsAValidJwtAuthenticationToAnImmutableParticipationGrant() {
		ParticipationGrant grant = resolver.resolve(authentication()).orElseThrow();

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

		assertThat(ParticipationGrantResolver.resolve(jwt))
				.get()
				.extracting(ParticipationGrant::role)
				.isEqualTo(ParticipationGrant.Role.HOST);
	}

	@Test
	void rejectsAPrincipalThatWasNotAuthenticatedFromAJwt() {
		Principal principal = () -> "member-42";

		assertThat(resolver.resolve(principal)).isEmpty();
		assertThat(resolver.resolve((Principal) null)).isEmpty();
	}

	@Test
	void rejectsEveryMissingRequiredIdentityAndAuthorizationClaim() {
		for (String claim : List.of("sub", "study_id", "room_id", "jti", "role")) {
			assertThat(ParticipationGrantResolver.resolve(
					jwt(claims -> claims.remove(claim))))
					.as("missing claim %s", claim)
					.isEmpty();
		}
	}

	@Test
	void rejectsMissingOrNonIncreasingGrantLifetime() {
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.remove("iat"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.remove("exp"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwtWithLifetime(ISSUED_AT, ISSUED_AT)))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwtWithLifetime(EXPIRES_AT, ISSUED_AT)))
				.isEmpty();
	}

	@Test
	void rejectsUnsupportedRoleNonCanonicalRoomAndUnboundedClaims() {
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("role", "observer"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("role", "PARTICIPANT"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("room_id", "NOT-A-ROOM"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("study_id", "s".repeat(257)))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("sub", " " + ACCOUNT_ID + " "))))
				.isEmpty();
	}

	@Test
	void rejectsNonUuidAndNonCanonicalUuidSubjects() {
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("sub", "member-42"))))
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put("sub", "1-1-1-1-1"))))
				.as("UUID.fromString accepts shortened groups, but BATON emits canonical UUIDs")
				.isEmpty();
		assertThat(ParticipationGrantResolver.resolve(
				jwt(claims -> claims.put(
						"sub",
						ACCOUNT_ID.toUpperCase()))))
				.as("canonical BATON account identifiers use UUID.toString form")
				.isEmpty();
	}

	@Test
	void staticResolverAcceptsTheValidJwtFixture() {
		assertThat(ParticipationGrantResolver.resolve(validJwt())).isPresent();
	}
}

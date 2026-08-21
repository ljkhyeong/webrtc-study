package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.ISSUED_AT;
import static com.personal.round.auth.ParticipationGrantTestFixtures.jwtWithLifetime;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class BatonParticipationTokenValidatorTest {

	private final BatonParticipationTokenValidator validator =
			new BatonParticipationTokenValidator(
					Duration.ofMinutes(5),
					Clock.fixed(ISSUED_AT, ZoneOffset.UTC));

	@Test
	void rejectsGrantsAtOrBeforeTheExactExpiryBoundary() {
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT.minusSeconds(120),
				ISSUED_AT.minusSeconds(1))).hasErrors())
				.isTrue();
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT.minusSeconds(120),
				ISSUED_AT)).hasErrors())
				.isTrue();
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT.minusSeconds(120),
				ISSUED_AT.plusSeconds(1))).hasErrors())
				.isFalse();
	}

	@Test
	void rejectsFutureIssueTimesAndGrantLifetimesAboveTheConfiguredMaximum() {
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT.plusSeconds(61),
				ISSUED_AT.plusSeconds(120))).hasErrors())
				.isTrue();
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT,
				ISSUED_AT.plus(Duration.ofMinutes(5)).plusSeconds(1))).hasErrors())
				.isTrue();
		assertThat(validator.validate(jwtWithLifetime(
				ISSUED_AT.plusSeconds(60),
				ISSUED_AT.plus(Duration.ofMinutes(5)))).hasErrors())
				.isFalse();
	}
}

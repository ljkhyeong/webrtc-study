package com.personal.round.auth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

final class BatonParticipationTokenValidator implements OAuth2TokenValidator<Jwt> {

	private static final OAuth2Error INVALID_GRANT = new OAuth2Error(
			"invalid_token",
			"The token is not a valid ROUND participation grant",
			null);
	private static final Duration ALLOWED_CLOCK_SKEW = Duration.ofSeconds(60);

	private final Duration maxGrantLifetime;
	private final Clock clock;

	BatonParticipationTokenValidator(
			Duration maxGrantLifetime,
			Clock clock) {
		this.maxGrantLifetime = maxGrantLifetime;
		this.clock = clock;
	}

	@Override
	public OAuth2TokenValidatorResult validate(Jwt token) {
		ParticipationGrant grant = ParticipationGrantResolver.resolve(token).orElse(null);
		Instant now = clock.instant();
		if (grant == null
				|| !grant.expiresAt().isAfter(now)
				|| grant.issuedAt().isAfter(now.plus(ALLOWED_CLOCK_SKEW))
				|| exceedsMaximumLifetime(grant)) {
			return OAuth2TokenValidatorResult.failure(INVALID_GRANT);
		}
		return OAuth2TokenValidatorResult.success();
	}

	private boolean exceedsMaximumLifetime(ParticipationGrant grant) {
		return Duration.between(grant.issuedAt(), grant.expiresAt())
				.compareTo(maxGrantLifetime) > 0;
	}
}

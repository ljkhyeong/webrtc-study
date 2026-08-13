package com.personal.round.auth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
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
		this.maxGrantLifetime = Objects.requireNonNull(
				maxGrantLifetime,
				"maxGrantLifetime must not be null");
		this.clock = Objects.requireNonNull(clock, "clock must not be null");
	}

	@Override
	public OAuth2TokenValidatorResult validate(Jwt token) {
		ParticipationGrant grant = ParticipationGrantResolver.resolve(token).orElse(null);
		if (grant == null
				|| isExpired(grant)
				|| issuedTooFarInTheFuture(grant)
				|| exceedsMaximumLifetime(grant)) {
			return OAuth2TokenValidatorResult.failure(INVALID_GRANT);
		}
		return OAuth2TokenValidatorResult.success();
	}

	private boolean isExpired(ParticipationGrant grant) {
		return !grant.expiresAt().isAfter(clock.instant());
	}

	private boolean issuedTooFarInTheFuture(ParticipationGrant grant) {
		Instant latestAcceptedIssueTime = clock.instant().plus(ALLOWED_CLOCK_SKEW);
		return grant.issuedAt().isAfter(latestAcceptedIssueTime);
	}

	private boolean exceedsMaximumLifetime(ParticipationGrant grant) {
		return Duration.between(grant.issuedAt(), grant.expiresAt())
				.compareTo(maxGrantLifetime) > 0;
	}
}

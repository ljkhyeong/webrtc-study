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

	// 클레임 형식은 ParticipationGrantAuthenticationConverter가 확인하고, 여기서는 시간 정책만 검사한다.
	@Override
	public OAuth2TokenValidatorResult validate(Jwt token) {
		Instant issuedAt = token.getIssuedAt();
		Instant expiresAt = token.getExpiresAt();
		Instant now = clock.instant();
		if (issuedAt == null
				|| expiresAt == null
				|| !expiresAt.isAfter(now)
				|| issuedAt.isAfter(now.plus(ALLOWED_CLOCK_SKEW))
				|| Duration.between(issuedAt, expiresAt).compareTo(maxGrantLifetime) > 0) {
			return OAuth2TokenValidatorResult.failure(INVALID_GRANT);
		}
		return OAuth2TokenValidatorResult.success();
	}
}

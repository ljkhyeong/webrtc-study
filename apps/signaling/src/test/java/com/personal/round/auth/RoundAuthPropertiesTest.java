package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class RoundAuthPropertiesTest {

	private final Validator validator =
			Validation.buildDefaultValidatorFactory().getValidator();

	@Test
	void standaloneModeDoesNotRequireBatonVerifierConfiguration() {
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.STANDALONE,
				"round_access",
				null,
				"round",
				null,
				Duration.ofMinutes(5));

		assertThat(properties.batonMode()).isFalse();
		assertThat(validator.validate(properties)).isEmpty();
	}

	@Test
	void batonModeAcceptsHttpsIssuerAndJwkUrisWithPaths() {
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"  __Secure-round_access  ",
				"  https://baton.example/oauth2/issuer  ",
				"  round  ",
				"  https://baton.example/oauth2/jwks.json  ",
				Duration.ofMinutes(5));

		assertThat(properties.batonMode()).isTrue();
		assertThat(properties.cookieName()).isEqualTo("__Secure-round_access");
		assertThat(properties.issuer()).isEqualTo("https://baton.example/oauth2/issuer");
		assertThat(properties.audience()).isEqualTo("round");
		assertThat(properties.jwkSetUri())
				.isEqualTo("https://baton.example/oauth2/jwks.json");
		assertThat(validator.validate(properties)).isEmpty();
	}

	@Test
	void batonModeAllowsLoopbackHttpForLocalDevelopment() {
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"http://127.0.0.1:8080/oauth2/issuer",
				"round",
				"http://localhost:8080/oauth2/jwks",
				Duration.ofMinutes(5));

		assertThat(validator.validate(properties)).isEmpty();
	}

	@Test
	void batonModeRejectsIncompleteOrInsecureBoundaryConfiguration() {
		RoundAuthProperties incomplete = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				null,
				Duration.ofMinutes(5));
		RoundAuthProperties insecureCookie = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				Duration.ofMinutes(5));
		RoundAuthProperties insecureUri = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"http://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				Duration.ofMinutes(5));

		assertThat(validator.validate(incomplete))
				.extracting(violation -> violation.getMessage())
				.contains("BATON auth mode requires issuer and jwk-set-uri");
		assertThat(validator.validate(insecureCookie))
				.extracting(violation -> violation.getMessage())
				.contains("BATON auth mode requires an __Secure- cookie name");
		assertThat(validator.validate(insecureUri))
				.extracting(violation -> violation.getMessage())
				.contains("BATON auth issuer and jwk-set-uri must use HTTPS or loopback HTTP");
	}

	@Test
	void boundsTheConfiguredMaximumGrantLifetime() {
		RoundAuthProperties tooShort = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				Duration.ofSeconds(29));
		RoundAuthProperties tooLong = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				Duration.ofMinutes(16));

		assertThat(validator.validate(tooShort))
				.extracting(violation -> violation.getMessage())
				.contains("round.auth.max-grant-lifetime must be at least 30s");
		assertThat(validator.validate(tooLong))
				.extracting(violation -> violation.getMessage())
				.contains("round.auth.max-grant-lifetime must be at most 15m");
	}
}

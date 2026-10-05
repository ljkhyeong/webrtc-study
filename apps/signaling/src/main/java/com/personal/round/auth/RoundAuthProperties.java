package com.personal.round.auth;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.auth")
public record RoundAuthProperties(
		@NotNull Mode mode,
		@NotBlank
		@Size(max = 128)
		@Pattern(
				regexp = "[!#$%&'*+.^_`|~0-9A-Za-z-]+",
				message = "round.auth.cookie-name must be a valid cookie name")
		String cookieName,
		String issuer,
		@NotBlank @Size(max = 256) String audience,
		String jwkSetUri,
		@Pattern(
				regexp = "[0-9a-fA-F]{64}",
				message = "round.auth.standalone-host-token-sha256 must contain exactly 64 hexadecimal characters")
		String standaloneHostTokenSha256,
		@NotNull @DurationMin(seconds = 30) @DurationMax(minutes = 15) Duration maxGrantLifetime) {

	public RoundAuthProperties {
		cookieName = normalize(cookieName);
		issuer = normalize(issuer);
		audience = normalize(audience);
		jwkSetUri = normalize(jwkSetUri);
		standaloneHostTokenSha256 = normalizeOptional(standaloneHostTokenSha256);
	}

	public boolean batonMode() {
		return mode == Mode.BATON;
	}

	@AssertTrue(message = "BATON auth mode requires issuer and jwk-set-uri")
	public boolean isBatonConfigurationComplete() {
		return !batonMode() || (StringUtils.hasText(issuer) && StringUtils.hasText(jwkSetUri));
	}

	@AssertTrue(message = "BATON auth mode requires an __Secure- cookie name")
	public boolean isBatonCookieNameSecure() {
		return !batonMode()
				|| (cookieName != null && cookieName.startsWith("__Secure-"));
	}

	@AssertTrue(message = "BATON auth issuer and jwk-set-uri must use HTTPS or loopback HTTP")
	public boolean isBatonUrisSecure() {
		return !batonMode()
				|| (isSecureServiceUri(issuer) && isSecureServiceUri(jwkSetUri));
	}

	@AssertTrue(message = "BATON auth mode must not configure a standalone host token")
	public boolean isStandaloneHostTokenModeSafe() {
		return !batonMode() || standaloneHostTokenSha256 == null;
	}

	@Override
	public String toString() {
		return ("RoundAuthProperties[mode=%s, cookieName=%s, issuer=%s, audience=%s, "
				+ "jwkSetUri=%s, standaloneHostTokenSha256=<redacted>, maxGrantLifetime=%s]")
				.formatted(mode, cookieName, issuer, audience, jwkSetUri, maxGrantLifetime);
	}

	private static String normalize(String value) {
		return value == null ? null : value.trim();
	}

	private static String normalizeOptional(String value) {
		String normalized = normalize(value);
		return StringUtils.hasText(normalized) ? normalized : null;
	}

	// 주소의 사용자 정보는 toString으로 기록될 수 있으므로 허용하지 않는다.
	private static boolean isSecureServiceUri(String value) {
		if (!StringUtils.hasText(value)) {
			return true;
		}
		try {
			URI uri = URI.create(value);
			if (uri.getHost() == null || uri.getRawUserInfo() != null) {
				return false;
			}
			return "https".equalsIgnoreCase(uri.getScheme())
					|| ("http".equalsIgnoreCase(uri.getScheme()) && isLoopback(uri.getHost()));
		}
		catch (IllegalArgumentException exception) {
			return false;
		}
	}

	private static boolean isLoopback(String host) {
		return "localhost".equalsIgnoreCase(host)
				|| "127.0.0.1".equals(host)
				|| "[::1]".equals(host);
	}

	public enum Mode {
		STANDALONE,
		BATON
	}
}

package com.personal.round.auth;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import java.util.Locale;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.auth")
public record RoundAuthProperties(
		@NotNull(message = "round.auth.mode must be configured")
		Mode mode,
		@NotBlank(message = "round.auth.cookie-name must not be blank")
		@Size(max = 128, message = "round.auth.cookie-name must contain at most 128 characters")
		@Pattern(
				regexp = "[!#$%&'*+.^_`|~0-9A-Za-z-]+",
				message = "round.auth.cookie-name must be a valid cookie name")
		String cookieName,
		String issuer,
		@NotBlank(message = "round.auth.audience must not be blank")
		@Size(max = 256, message = "round.auth.audience must contain at most 256 characters")
		String audience,
		String jwkSetUri,
		@Pattern(
				regexp = "[0-9a-fA-F]{64}",
				message = "round.auth.standalone-host-token-sha256 must contain exactly 64 hexadecimal characters")
		String standaloneHostTokenSha256,
		@NotNull(message = "round.auth.max-grant-lifetime must be configured")
		@DurationMin(
				seconds = 30,
				message = "round.auth.max-grant-lifetime must be at least 30s")
		@DurationMax(
				minutes = 15,
				message = "round.auth.max-grant-lifetime must be at most 15m")
		Duration maxGrantLifetime) {

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
		return !batonMode() || (hasText(issuer) && hasText(jwkSetUri));
	}

	@AssertTrue(message = "BATON auth mode requires an __Secure- cookie name")
	public boolean isBatonCookieNameSecure() {
		return !batonMode() || (hasText(cookieName) && cookieName.startsWith("__Secure-"));
	}

	@AssertTrue(message = "BATON auth issuer and jwk-set-uri must use HTTPS or loopback HTTP")
	public boolean isBatonUrisSecure() {
		return !batonMode()
				|| (isSecureServiceUri(issuer) && isSecureServiceUri(jwkSetUri));
	}

	@AssertTrue(message = "BATON auth mode must not configure a standalone host token")
	public boolean isStandaloneHostTokenModeSafe() {
		return !batonMode() || !hasText(standaloneHostTokenSha256);
	}

	@Override
	public String toString() {
		return "RoundAuthProperties[mode=%s, cookieName=%s, issuer=%s, audience=%s, "
				+ "jwkSetUri=%s, standaloneHostTokenSha256=<redacted>, maxGrantLifetime=%s]"
				.formatted(mode, cookieName, issuer, audience, jwkSetUri, maxGrantLifetime);
	}

	private static String normalize(String value) {
		return value == null ? null : value.trim();
	}

	private static String normalizeOptional(String value) {
		String normalized = normalize(value);
		return hasText(normalized) ? normalized : null;
	}

	private static boolean hasText(String value) {
		return value != null && !value.isBlank();
	}

	private static boolean isSecureServiceUri(String value) {
		if (!hasText(value)) {
			return true;
		}
		try {
			URI uri = URI.create(value);
			String scheme = uri.getScheme();
			String host = normalizeHost(uri.getHost());
			int port = uri.getPort();
			if (scheme == null
					|| host == null
					|| uri.getRawUserInfo() != null
					|| uri.getRawQuery() != null
					|| uri.getRawFragment() != null
					|| (uri.getRawAuthority() != null
							&& uri.getRawAuthority().endsWith(":"))
					|| port == 0
					|| port > 65_535) {
				return false;
			}
			if ("https".equalsIgnoreCase(scheme)) {
				return true;
			}
			return "http".equalsIgnoreCase(scheme) && isLoopback(host);
		}
		catch (IllegalArgumentException exception) {
			return false;
		}
	}

	private static String normalizeHost(String host) {
		if (host == null || host.isBlank()) {
			return null;
		}
		String unwrapped = host.length() > 1 && host.startsWith("[") && host.endsWith("]")
				? host.substring(1, host.length() - 1)
				: host;
		return unwrapped.toLowerCase(Locale.ROOT);
	}

	private static boolean isLoopback(String host) {
		return "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
	}

	public enum Mode {
		STANDALONE,
		BATON
	}
}

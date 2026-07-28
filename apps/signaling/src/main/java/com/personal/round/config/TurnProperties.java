package com.personal.round.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import java.util.List;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.turn")
public record TurnProperties(
		List<String> urls,
		String sharedSecret,
		@NotNull(message = "round.turn.credential-ttl must be configured")
		@DurationMin(
				minutes = 5,
				message = "round.turn.credential-ttl must be at least 5m")
		@DurationMax(
				days = 7,
				message = "round.turn.credential-ttl must be at most 7d")
		Duration credentialTtl,
		@NotNull(message = "round.turn.rate-limit-window must be configured")
		@DurationMin(
				seconds = 1,
				message = "round.turn.rate-limit-window must be at least 1s")
		@DurationMax(
				hours = 1,
				message = "round.turn.rate-limit-window must be at most 1h")
		Duration rateLimitWindow,
		@Min(value = 1, message = "round.turn.rate-limit-max-requests must be at least 1")
		@Max(
				value = 10_000,
				message = "round.turn.rate-limit-max-requests must be at most 10000")
		int rateLimitMaxRequests,
		@Min(
				value = 1,
				message = "round.turn.rate-limit-global-max-requests must be at least 1")
		@Max(
				value = 1_000_000,
				message = "round.turn.rate-limit-global-max-requests must be at most 1000000")
		int rateLimitGlobalMaxRequests,
		@Min(value = 1, message = "round.turn.rate-limit-max-clients must be at least 1")
		@Max(
				value = 1_000_000,
				message = "round.turn.rate-limit-max-clients must be at most 1000000")
		int rateLimitMaxClients) {

	public TurnProperties {
		urls = urls == null
				? List.of()
				: urls.stream()
						.filter(url -> url != null && !url.isBlank())
						.toList();
		sharedSecret = sharedSecret == null ? "" : sharedSecret;
	}

	public boolean enabled() {
		return !urls.isEmpty() && !sharedSecret.isBlank();
	}

	@Override
	public String toString() {
		return "TurnProperties[urls=<"
				+ urls.size()
				+ " configured>, sharedSecret=<redacted>, credentialTtl="
				+ credentialTtl
				+ ", rateLimitWindow="
				+ rateLimitWindow
				+ ", rateLimitMaxRequests="
				+ rateLimitMaxRequests
				+ ", rateLimitGlobalMaxRequests="
				+ rateLimitGlobalMaxRequests
				+ ", rateLimitMaxClients="
				+ rateLimitMaxClients
				+ "]";
	}

	@AssertTrue(
			message = "round.turn.urls and round.turn.shared-secret must be configured together")
	public boolean isConfigurationComplete() {
		return urls.isEmpty() == sharedSecret.isBlank();
	}

	@AssertTrue(
			message =
					"round.turn.urls must contain only credential-free turn: or turns: URLs")
	public boolean isEveryUrlCredentialFree() {
		return urls.stream().allMatch(TurnProperties::isCredentialFreeTurnUrl);
	}

	@AssertTrue(
			message =
					"round.turn.rate-limit-global-max-requests must be at least twice "
							+ "rate-limit-max-requests")
	public boolean isGlobalRateLimitAtLeastTwiceClientLimit() {
		return (long) rateLimitGlobalMaxRequests >= 2L * rateLimitMaxRequests;
	}

	private static boolean isCredentialFreeTurnUrl(String url) {
		return (url.startsWith("turn:") || url.startsWith("turns:"))
				&& url.chars().noneMatch(Character::isWhitespace)
				&& !url.contains("@");
	}
}

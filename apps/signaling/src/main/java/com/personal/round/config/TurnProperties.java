package com.personal.round.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Duration;
import java.util.List;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.turn")
public record TurnProperties(
		@NotNull Provider provider,
		String cloudflareKeyId,
		String cloudflareApiToken,
		List<@Pattern(regexp = "turns?:[^\\s]+", message = "coturn URL must use turn: or turns:") String> coturnUrls,
		String coturnSecret,
		@NotNull @DurationMin(minutes = 5) @DurationMax(days = 2) Duration credentialTtl,
		@NotNull @DurationMin(seconds = 1) @DurationMax(hours = 1) Duration rateLimitWindow,
		@Min(1) @Max(10_000) int rateLimitMaxRequests,
		@Min(1) @Max(10_000) int rateLimitParticipantMaxRequests,
		@Min(1) @Max(1_000_000) int rateLimitGlobalMaxRequests,
		@Min(1) @Max(1_000_000) int rateLimitMaxClients,
		@Min(1) @Max(1_000_000) int rateLimitMaxParticipants) {

	public TurnProperties {
		cloudflareKeyId = cloudflareKeyId == null ? "" : cloudflareKeyId.strip();
		cloudflareApiToken = cloudflareApiToken == null ? "" : cloudflareApiToken;
		coturnUrls = coturnUrls == null ? List.of() : List.copyOf(coturnUrls);
		coturnSecret = coturnSecret == null ? "" : coturnSecret;
	}

	public boolean enabled() {
		return provider == Provider.CLOUDFLARE || provider == Provider.COTURN;
	}

	@Override
	public String toString() {
		return ("TurnProperties[provider=%s, cloudflareKeyId=<redacted>, cloudflareApiToken=<redacted>, "
				+ "coturnSecret=<redacted>, credentialTtl=%s, rateLimitWindow=%s, rateLimitMaxRequests=%s, "
				+ "rateLimitParticipantMaxRequests=%s, rateLimitGlobalMaxRequests=%s, rateLimitMaxClients=%s, "
				+ "rateLimitMaxParticipants=%s]")
				.formatted(
						provider,
						credentialTtl,
						rateLimitWindow,
						rateLimitMaxRequests,
						rateLimitParticipantMaxRequests,
						rateLimitGlobalMaxRequests,
						rateLimitMaxClients,
						rateLimitMaxParticipants);
	}

	@AssertTrue(
			message =
					"round.turn.cloudflare-key-id and cloudflare-api-token must be configured "
							+ "only with the cloudflare provider")
	public boolean isConfigurationComplete() {
		boolean credentialsConfigured = !cloudflareKeyId.isBlank()
				&& !cloudflareApiToken.isBlank();
		return provider == Provider.CLOUDFLARE
				? credentialsConfigured
				: cloudflareKeyId.isEmpty() && cloudflareApiToken.isEmpty();
	}

	@AssertTrue(message = "coturn requires TURN URLs and a secret of at least 32 characters; other providers must leave both empty")
	public boolean isCoturnConfigurationComplete() {
		return provider == Provider.COTURN
				? !coturnUrls.isEmpty() && !coturnSecret.isBlank() && coturnSecret.length() >= 32
				: coturnUrls.isEmpty() && coturnSecret.isEmpty();
	}

	@AssertTrue(
			message =
					"round.turn.rate-limit-global-max-requests must be at least twice "
							+ "rate-limit-max-requests")
	public boolean isGlobalRateLimitAtLeastTwiceClientLimit() {
		return (long) rateLimitGlobalMaxRequests >= 2L * rateLimitMaxRequests;
	}

	public enum Provider {
		DISABLED,
		CLOUDFLARE,
		COTURN
	}
}

package com.personal.round.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.turn")
public record TurnProperties(
		@NotNull(message = "round.turn.provider must be configured") Provider provider,
		String cloudflareKeyId,
		String cloudflareApiToken,
		@NotNull(message = "round.turn.credential-ttl must be configured")
		@DurationMin(
				minutes = 5,
				message = "round.turn.credential-ttl must be at least 5m")
		@DurationMax(
				days = 2,
				message = "round.turn.credential-ttl must be at most 2d")
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
				message =
						"round.turn.rate-limit-participant-max-requests must be at least 1")
		@Max(
				value = 10_000,
				message =
						"round.turn.rate-limit-participant-max-requests must be at most 10000")
		int rateLimitParticipantMaxRequests,
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
		int rateLimitMaxClients,
		@Min(
				value = 1,
				message = "round.turn.rate-limit-max-participants must be at least 1")
		@Max(
				value = 1_000_000,
				message =
						"round.turn.rate-limit-max-participants must be at most 1000000")
		int rateLimitMaxParticipants) {

	public TurnProperties {
		cloudflareKeyId = cloudflareKeyId == null ? "" : cloudflareKeyId.strip();
		cloudflareApiToken = cloudflareApiToken == null ? "" : cloudflareApiToken;
	}

	public boolean enabled() {
		return provider == Provider.CLOUDFLARE;
	}

	@Override
	public String toString() {
		return "TurnProperties[provider="
				+ provider
				+ ", cloudflareKeyId=<redacted>, cloudflareApiToken=<redacted>, credentialTtl="
				+ credentialTtl
				+ ", rateLimitWindow="
				+ rateLimitWindow
				+ ", rateLimitMaxRequests="
				+ rateLimitMaxRequests
				+ ", rateLimitParticipantMaxRequests="
				+ rateLimitParticipantMaxRequests
				+ ", rateLimitGlobalMaxRequests="
				+ rateLimitGlobalMaxRequests
				+ ", rateLimitMaxClients="
				+ rateLimitMaxClients
				+ ", rateLimitMaxParticipants="
				+ rateLimitMaxParticipants
				+ "]";
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

	@AssertTrue(
			message =
					"round.turn.rate-limit-global-max-requests must be at least twice "
							+ "rate-limit-max-requests")
	public boolean isGlobalRateLimitAtLeastTwiceClientLimit() {
		return (long) rateLimitGlobalMaxRequests >= 2L * rateLimitMaxRequests;
	}

	public enum Provider {
		DISABLED,
		CLOUDFLARE
	}
}

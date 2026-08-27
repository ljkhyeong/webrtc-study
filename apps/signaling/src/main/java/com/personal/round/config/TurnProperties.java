package com.personal.round.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.List;
import java.util.regex.Pattern;
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

	private static final Pattern TRANSPORT_QUERY =
			Pattern.compile("transport=[A-Za-z0-9._~-]+", Pattern.CASE_INSENSITIVE);

	public TurnProperties {
		urls = urls == null
				? List.of()
				: urls.stream()
						.filter(url -> url != null && !url.isBlank())
						.toList();
		sharedSecret = sharedSecret == null ? "" : sharedSecret;
	}

	public boolean enabled() {
		return !urls.isEmpty();
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
		try {
			URI turnUri = new URI(url);
			String scheme = turnUri.getScheme();
			if (!("turn".equalsIgnoreCase(scheme) || "turns".equalsIgnoreCase(scheme))
					|| !turnUri.isOpaque()
					|| turnUri.getRawFragment() != null) {
				return false;
			}

			String schemeSpecificPart = turnUri.getRawSchemeSpecificPart();
			int querySeparator = schemeSpecificPart.indexOf('?');
			String endpoint = querySeparator < 0
					? schemeSpecificPart
					: schemeSpecificPart.substring(0, querySeparator);
			String query = querySeparator < 0
					? null
					: schemeSpecificPart.substring(querySeparator + 1);
			if (endpoint.isEmpty()
					|| (query != null && !TRANSPORT_QUERY.matcher(query).matches())) {
				return false;
			}

			URI endpointUri = new URI("turn://" + endpoint).parseServerAuthority();
			int port = endpointUri.getPort();
			return endpointUri.getRawUserInfo() == null
					&& endpointUri.getHost() != null
					&& endpointUri.getRawPath().isEmpty()
					&& !endpointUri.getRawAuthority().endsWith(":")
					&& (port == -1 || (port >= 1 && port <= 65_535));
		}
		catch (URISyntaxException exception) {
			return false;
		}
	}
}

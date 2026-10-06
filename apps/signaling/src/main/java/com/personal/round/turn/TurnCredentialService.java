package com.personal.round.turn;

import com.personal.round.auth.ParticipantRoomKey;
import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import java.util.function.LongSupplier;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;

@Service
public class TurnCredentialService {
	private static final long MINIMUM_REFRESH_SKEW_SECONDS = 30;
	private static final long MAXIMUM_REFRESH_SKEW_SECONDS = 5 * 60;

	private final TurnProperties properties;
	private final Clock clock;
	private final LongSupplier monotonicTicker;
	private final TurnCredentialMetrics metrics;
	private final CloudflareTurnClient cloudflareTurnClient;
	private final TurnIssuanceLimiter issuanceLimiter;

	public TurnCredentialService(
			TurnProperties properties,
			Clock clock,
			LongSupplier monotonicTicker,
			TurnCredentialMetrics metrics,
			CloudflareTurnClient cloudflareTurnClient) {
		this.properties = properties;
		this.clock = clock;
		this.monotonicTicker = monotonicTicker;
		this.metrics = metrics;
		this.cloudflareTurnClient = cloudflareTurnClient;
		this.issuanceLimiter = new TurnIssuanceLimiter(properties);
	}

	public IssueResult issueFor(String clientAddress) {
		return issueFor(clientAddress, Instant.MAX, null);
	}

	public IssueResult issueFor(
			String clientAddress,
			ParticipationGrant grant) {
		return issueFor(clientAddress, grant.expiresAt(), grant.participantRoomKey());
	}

	private IssueResult issueFor(
			String clientAddress,
			Instant authorizationExpiresAt,
			ParticipantRoomKey participantKey) {
		if (!properties.enabled()) {
			return Disabled.INSTANCE;
		}

		String clientKey = ClientAddressKeyResolver.resolve(clientAddress);
		long nowNanos = monotonicTicker.getAsLong();
		long nowMillis = clock.millis();
		long nowEpochSecond = Math.floorDiv(nowMillis, 1_000);
		long configuredExpiresAt = Math.addExact(
				nowEpochSecond,
				properties.credentialTtl().toSeconds());
		long expiresAt = Math.min(
				configuredExpiresAt,
				authorizationExpiresAt.getEpochSecond());
		if (expiresAt <= nowEpochSecond) {
			return AuthorizationExpired.INSTANCE;
		}

		Optional<TurnIssuanceLimiter.Rejected> rejection =
				issuanceLimiter.tryAcquire(clientKey, participantKey, nowNanos);
		if (rejection.isPresent()) {
			metrics.recordRateLimited(rejection.get().scope());
			return new RateLimited(rejection.get().retryAfterSeconds());
		}

		TurnCredentialMaterial providerCredentials;
		try {
			providerCredentials = properties.provider() == TurnProperties.Provider.COTURN
					? CoturnCredentials.issue(properties, expiresAt)
					: cloudflareTurnClient.issue(expiresAt - nowEpochSecond);
		}
		catch (RestClientException exception) {
			metrics.recordProviderError();
			return ProviderUnavailable.INSTANCE;
		}
		long refreshAfterSeconds = refreshAfterSeconds(expiresAt - nowEpochSecond);
		TurnCredentials credentials = new TurnCredentials(
				providerCredentials.urls(),
				providerCredentials.username(),
				providerCredentials.credential(),
				expiresAt,
				refreshAfterSeconds);
		metrics.recordIssued();
		return new Issued(credentials);
	}

	private static long refreshAfterSeconds(long lifetimeSeconds) {
		long refreshSkewSeconds = Math.clamp(
				Math.floorDiv(lifetimeSeconds, 5),
				MINIMUM_REFRESH_SKEW_SECONDS,
				MAXIMUM_REFRESH_SKEW_SECONDS);
		return Math.max(1, lifetimeSeconds - refreshSkewSeconds);
	}

	public sealed interface IssueResult
			permits Issued, RateLimited, AuthorizationExpired, ProviderUnavailable, Disabled {
	}

	public record Issued(TurnCredentials credentials) implements IssueResult {
	}

	public record RateLimited(long retryAfterSeconds) implements IssueResult {
	}

	public enum AuthorizationExpired implements IssueResult {
		INSTANCE
	}

	public enum ProviderUnavailable implements IssueResult {
		INSTANCE
	}

	public enum Disabled implements IssueResult {
		INSTANCE
	}
}

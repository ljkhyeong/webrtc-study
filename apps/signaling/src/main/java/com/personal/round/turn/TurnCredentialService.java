package com.personal.round.turn;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.time.Clock;
import java.time.Instant;
import org.springframework.stereotype.Service;

@Service
public class TurnCredentialService {
	private static final long MINIMUM_REFRESH_SKEW_SECONDS = 30;
	private static final long MAXIMUM_REFRESH_SKEW_SECONDS = 5 * 60;

	private final TurnProperties properties;
	private final Clock clock;
	private final TurnCredentialMetrics metrics;
	private final ClientAddressKeyResolver clientAddressKeyResolver;
	private final CloudflareTurnClient cloudflareTurnClient;
	private final TurnIssuanceLimiter issuanceLimiter;

	public TurnCredentialService(
			TurnProperties properties,
			Clock clock,
			TurnCredentialMetrics metrics,
			ClientAddressKeyResolver clientAddressKeyResolver,
			CloudflareTurnClient cloudflareTurnClient) {
		this.properties = properties;
		this.clock = clock;
		this.metrics = metrics;
		this.clientAddressKeyResolver = clientAddressKeyResolver;
		this.cloudflareTurnClient = cloudflareTurnClient;
		this.issuanceLimiter = new TurnIssuanceLimiter(properties);
	}

	public IssueResult issueFor(String clientAddress) {
		return issueFor(clientAddress, Instant.MAX, null);
	}

	public IssueResult issueFor(
			String clientAddress,
			ParticipationGrant grant) {
		return issueFor(
				clientAddress,
				grant.expiresAt(),
				new ParticipantRoomKey(grant.roomId(), grant.subject()));
	}

	private IssueResult issueFor(
			String clientAddress,
			Instant authorizationExpiresAt,
			ParticipantRoomKey participantKey) {
		if (!properties.enabled()) {
			return Disabled.INSTANCE;
		}

		String clientKey = clientAddressKeyResolver.resolve(clientAddress);
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

		TurnIssuanceLimiter.Acquisition acquisition =
				issuanceLimiter.tryAcquire(clientKey, participantKey, nowMillis);
		if (acquisition instanceof TurnIssuanceLimiter.Rejected rejected) {
			metrics.recordRateLimited(rejected.scope());
			return new RateLimited(rejected.retryAfterSeconds());
		}

		CloudflareTurnClient.Credentials providerCredentials;
		try {
			providerCredentials = cloudflareTurnClient.issue(expiresAt - nowEpochSecond);
		}
		catch (CloudflareTurnClient.ProviderUnavailableException exception) {
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

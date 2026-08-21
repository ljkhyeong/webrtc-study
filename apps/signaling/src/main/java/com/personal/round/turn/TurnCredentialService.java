package com.personal.round.turn;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.security.crypto.keygen.Base64StringKeyGenerator;
import org.springframework.security.crypto.keygen.StringKeyGenerator;
import org.springframework.stereotype.Service;

@Service
public class TurnCredentialService {
	private static final long MINIMUM_REFRESH_SKEW_SECONDS = 30;
	private static final long MAXIMUM_REFRESH_SKEW_SECONDS = 5 * 60;

	private static final String HMAC_ALGORITHM = "HmacSHA1";
	private static final int USERNAME_RANDOM_BYTES = 12;

	private final TurnProperties properties;
	private final Clock clock;
	private final TurnCredentialMetrics metrics;
	private final ClientAddressKeyResolver clientAddressKeyResolver;
	private final TurnIssuanceLimiter issuanceLimiter;
	private final StringKeyGenerator usernameTokenGenerator =
			new Base64StringKeyGenerator(
					Base64.getUrlEncoder().withoutPadding(),
					USERNAME_RANDOM_BYTES);

	public TurnCredentialService(
			TurnProperties properties,
			Clock clock,
			TurnCredentialMetrics metrics,
			ClientAddressKeyResolver clientAddressKeyResolver) {
		this.properties = properties;
		this.clock = clock;
		this.metrics = metrics;
		this.clientAddressKeyResolver = clientAddressKeyResolver;
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

		String username = expiresAt + ":" + usernameTokenGenerator.generateKey();
		String credential = sign(username);
		long refreshAfterSeconds = refreshAfterSeconds(expiresAt - nowEpochSecond);
		TurnCredentials credentials = new TurnCredentials(
				properties.urls(),
				username,
				credential,
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

	private String sign(String username) {
		try {
			Mac mac = Mac.getInstance(HMAC_ALGORITHM);
			mac.init(new SecretKeySpec(
					properties.sharedSecret().getBytes(StandardCharsets.UTF_8),
					HMAC_ALGORITHM));
			return Base64.getEncoder().encodeToString(
					mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
		}
		catch (GeneralSecurityException exception) {
			throw new IllegalStateException(
					"TURN credential signing is unavailable",
					exception);
		}
	}

	public sealed interface IssueResult
			permits Issued, RateLimited, AuthorizationExpired, Disabled {
	}

	public record Issued(TurnCredentials credentials) implements IssueResult {
	}

	public record RateLimited(long retryAfterSeconds) implements IssueResult {
	}

	public enum AuthorizationExpired implements IssueResult {
		INSTANCE
	}

	public enum Disabled implements IssueResult {
		INSTANCE
	}
}

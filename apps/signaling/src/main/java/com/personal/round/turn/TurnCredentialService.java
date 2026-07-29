package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Service;

@Service
public class TurnCredentialService {

	private static final String HMAC_ALGORITHM = "HmacSHA1";
	private static final int USERNAME_RANDOM_BYTES = 12;

	private final TurnProperties properties;
	private final Clock clock;
	private final TurnCredentialMetrics metrics;
	private final ClientAddressKeyResolver clientAddressKeyResolver;
	private final TurnIssuanceLimiter issuanceLimiter;
	private final SecureRandom secureRandom = new SecureRandom();
	private final AtomicLong issuanceSequence = new AtomicLong();

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
		return issueFor(clientAddress, Instant.MAX);
	}

	public IssueResult issueFor(
			String clientAddress,
			Instant authorizationExpiresAt) {
		Objects.requireNonNull(
				authorizationExpiresAt,
				"authorizationExpiresAt must not be null");
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
				issuanceLimiter.tryAcquire(clientKey, nowMillis);
		if (acquisition instanceof TurnIssuanceLimiter.Rejected rejected) {
			metrics.recordRateLimited();
			return new RateLimited(rejected.retryAfterSeconds());
		}

		String username = expiresAt + ":" + randomToken();
		String credential = sign(username);
		TurnCredentials credentials = new TurnCredentials(
				properties.urls(), username, credential, expiresAt);
		metrics.recordIssued();
		return new Issued(credentials);
	}

	int trackedClientCount() {
		return issuanceLimiter.trackedClientCount();
	}

	private String randomToken() {
		byte[] random = new byte[USERNAME_RANDOM_BYTES];
		secureRandom.nextBytes(random);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(random)
				+ "."
				+ Long.toUnsignedString(issuanceSequence.incrementAndGet(), 36);
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

		public RateLimited {
			if (retryAfterSeconds < 1) {
				throw new IllegalArgumentException("retryAfterSeconds must be positive");
			}
		}
	}

	public enum AuthorizationExpired implements IssueResult {
		INSTANCE
	}

	public enum Disabled implements IssueResult {
		INSTANCE
	}
}

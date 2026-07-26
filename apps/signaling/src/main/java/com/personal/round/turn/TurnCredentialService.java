package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
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
	private final SecureRandom secureRandom = new SecureRandom();
	private final AtomicLong issuanceSequence = new AtomicLong();
	private final Map<String, IssuanceWindow> issuanceWindowsByClient;
	private final long rateLimitWindowMillis;

	public TurnCredentialService(
			TurnProperties properties,
			Clock clock,
			TurnCredentialMetrics metrics) {
		properties.validate();
		this.properties = properties;
		this.clock = clock;
		this.metrics = metrics;
		this.rateLimitWindowMillis =
				Math.multiplyExact(properties.getRateLimitWindowSeconds(), 1_000);
		this.issuanceWindowsByClient = new LinkedHashMap<>(16, 0.75f, true) {
			@Override
			protected boolean removeEldestEntry(Map.Entry<String, IssuanceWindow> eldest) {
				return size() > properties.getRateLimitMaxClients();
			}
		};
	}

	public IssueResult issueFor(String clientAddress) {
		if (!properties.isEnabled()) {
			return Disabled.INSTANCE;
		}

		String clientKey =
				clientAddress == null || clientAddress.isBlank() ? "unknown-client" : clientAddress;
		long nowMillis = clock.millis();
		synchronized (issuanceWindowsByClient) {
			IssuanceWindow window = issuanceWindowsByClient.get(clientKey);
			if (window == null || window.isExpired(nowMillis, rateLimitWindowMillis)) {
				window = new IssuanceWindow(nowMillis);
				issuanceWindowsByClient.put(clientKey, window);
			}
			if (window.issued >= properties.getRateLimitMaxRequests()) {
				metrics.recordRateLimited();
				return new RateLimited(
						window.retryAfterSeconds(nowMillis, rateLimitWindowMillis));
			}
			window.issued++;
		}

		long expiresAt = Math.addExact(
				Math.floorDiv(nowMillis, 1_000), properties.getCredentialTtlSeconds());
		String username = expiresAt + ":" + randomToken();
		String credential = sign(username);
		TurnCredentials credentials = new TurnCredentials(
				properties.getUrls(), username, credential, expiresAt);
		metrics.recordIssued();
		return new Issued(credentials);
	}

	int trackedClientCount() {
		synchronized (issuanceWindowsByClient) {
			return issuanceWindowsByClient.size();
		}
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
					properties.getSharedSecret().getBytes(StandardCharsets.UTF_8),
					HMAC_ALGORITHM));
			return Base64.getEncoder().encodeToString(
					mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
		}
		catch (GeneralSecurityException exception) {
			throw new IllegalStateException("TURN credential signing is unavailable");
		}
	}

	public sealed interface IssueResult permits Issued, RateLimited, Disabled {
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

	public enum Disabled implements IssueResult {
		INSTANCE
	}

	private static final class IssuanceWindow {

		private final long startedAtMillis;
		private int issued;

		private IssuanceWindow(long startedAtMillis) {
			this.startedAtMillis = startedAtMillis;
		}

		private boolean isExpired(long nowMillis, long windowMillis) {
			return nowMillis < startedAtMillis
					|| nowMillis - startedAtMillis >= windowMillis;
		}

		private long retryAfterSeconds(long nowMillis, long windowMillis) {
			long elapsed = Math.max(0, nowMillis - startedAtMillis);
			long remainingMillis = Math.max(1, windowMillis - elapsed);
			return Math.max(1, (remainingMillis + 999) / 1_000);
		}
	}
}

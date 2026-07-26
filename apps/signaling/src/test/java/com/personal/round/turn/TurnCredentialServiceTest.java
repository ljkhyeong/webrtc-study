package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.personal.round.config.TurnProperties;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class TurnCredentialServiceTest {

	private static final String SHARED_SECRET = "test-shared-secret";

	@Test
	void createsUniqueCoturnRestCredentialsForClientsBehindTheSameNat() throws Exception {
		TurnProperties properties = enabledProperties();
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		TurnCredentials first = issued(service.issueFor("192.0.2.10"));
		TurnCredentials sameNatClient = issued(service.issueFor("192.0.2.10"));
		TurnCredentials otherAddress = issued(service.issueFor("192.0.2.11"));

		assertThat(sameNatClient.username()).isNotEqualTo(first.username());
		assertThat(sameNatClient.credential()).isNotEqualTo(first.credential());
		assertThat(otherAddress.username()).isNotEqualTo(first.username());
		assertThat(first.urls()).containsExactly(
				"turn:turn.example.com:3478?transport=udp",
				"turns:turn.example.com:5349?transport=tcp");
		assertThat(first.expiresAt()).isEqualTo(1_800_003_600L);
		assertThat(first.username()).startsWith(first.expiresAt() + ":");
		assertThat(first.credential()).isEqualTo(hmac(first.username(), SHARED_SECRET));
		assertThat(sameNatClient.credential())
				.isEqualTo(hmac(sameNatClient.username(), SHARED_SECRET));
		assertThat(first.credential()).doesNotContain(SHARED_SECRET);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void isDisabledOnlyWhenBothSecretAndUrlsAreAbsent() {
		TurnProperties disabled = new TurnProperties();
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(disabled, clock, registry);

		assertThat(service.issueFor("192.0.2.10"))
				.isSameAs(TurnCredentialService.Disabled.INSTANCE);

		TurnProperties missingUrls = new TurnProperties();
		missingUrls.setSharedSecret(SHARED_SECRET);
		assertThatThrownBy(() -> service(missingUrls, clock, new SimpleMeterRegistry()))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("configured together")
				.hasMessageNotContaining(SHARED_SECRET);

		TurnProperties missingSecret = new TurnProperties();
		missingSecret.setUrls(List.of("turn:turn.example.com:3478"));
		assertThatThrownBy(() -> service(missingSecret, clock, new SimpleMeterRegistry()))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("configured together");
	}

	@Test
	void rejectsCredentialBearingOrInvalidTurnUrlsWithoutEchoingThem() {
		TurnProperties properties = enabledProperties();
		properties.setUrls(List.of("turn:user:password@turn.example.com:3478"));

		assertThatThrownBy(() -> service(
				properties,
				new MutableClock(1_800_000_000),
				new SimpleMeterRegistry()))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("credential-free")
				.hasMessageNotContaining("password");
	}

	@Test
	void rateLimitsPerEffectiveAddressAndResetsAtTheWindowBoundary() {
		TurnProperties properties = enabledProperties();
		properties.setRateLimitMaxRequests(2);
		properties.setRateLimitWindowSeconds(60);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		TurnCredentials first = issued(service.issueFor("198.51.100.10"));
		TurnCredentials second = issued(service.issueFor("198.51.100.10"));
		TurnCredentialService.RateLimited limited =
				rateLimited(service.issueFor("198.51.100.10"));

		assertThat(first.username()).isNotEqualTo(second.username());
		assertThat(limited.retryAfterSeconds()).isEqualTo(60);

		clock.advanceSeconds(30);
		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isEqualTo(30);

		clock.advanceSeconds(30);
		TurnCredentials afterReset = issued(service.issueFor("198.51.100.10"));
		assertThat(afterReset.username()).isNotIn(first.username(), second.username());
		assertThat(registry.get("round.turn.credentials.rate_limited").counter().count())
				.isEqualTo(2);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void boundsTheNumberOfTrackedClientWindows() {
		TurnProperties properties = enabledProperties();
		properties.setRateLimitMaxRequests(1);
		properties.setRateLimitMaxClients(2);
		TurnCredentialService service = service(
				properties,
				new MutableClock(1_800_000_000),
				new SimpleMeterRegistry());

		issued(service.issueFor("198.51.100.1"));
		issued(service.issueFor("198.51.100.2"));
		issued(service.issueFor("198.51.100.3"));

		assertThat(service.trackedClientCount()).isEqualTo(2);
		assertThat(service.issueFor("198.51.100.2"))
				.isInstanceOf(TurnCredentialService.RateLimited.class);
	}

	@Test
	void validatesRateLimitConfigurationWithoutEchoingSensitiveValues() {
		TurnProperties properties = enabledProperties();
		properties.setRateLimitMaxRequests(0);

		assertThatThrownBy(() -> service(
				properties,
				new MutableClock(1_800_000_000),
				new SimpleMeterRegistry()))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("rate-limit-max-requests")
				.hasMessageNotContaining(SHARED_SECRET);
	}

	private static TurnProperties enabledProperties() {
		TurnProperties properties = new TurnProperties();
		properties.setUrls(List.of(
				"turn:turn.example.com:3478?transport=udp",
				"turns:turn.example.com:5349?transport=tcp"));
		properties.setSharedSecret(SHARED_SECRET);
		return properties;
	}

	private static String hmac(String username, String secret) throws Exception {
		Mac mac = Mac.getInstance("HmacSHA1");
		mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
		return Base64.getEncoder().encodeToString(
				mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
	}

	private static TurnCredentialService service(
			TurnProperties properties,
			Clock clock,
			SimpleMeterRegistry registry) {
		return new TurnCredentialService(
				properties,
				clock,
				new TurnCredentialMetrics(registry));
	}

	private static TurnCredentials issued(TurnCredentialService.IssueResult result) {
		assertThat(result).isInstanceOf(TurnCredentialService.Issued.class);
		return ((TurnCredentialService.Issued) result).credentials();
	}

	private static TurnCredentialService.RateLimited rateLimited(
			TurnCredentialService.IssueResult result) {
		assertThat(result).isInstanceOf(TurnCredentialService.RateLimited.class);
		return (TurnCredentialService.RateLimited) result;
	}

	private static final class MutableClock extends Clock {

		private Instant instant;

		private MutableClock(long epochSecond) {
			this.instant = Instant.ofEpochSecond(epochSecond);
		}

		private void advanceSeconds(long seconds) {
			instant = instant.plusSeconds(seconds);
		}

		@Override
		public ZoneId getZone() {
			return ZoneOffset.UTC;
		}

		@Override
		public Clock withZone(ZoneId zone) {
			if (!ZoneOffset.UTC.equals(zone)) {
				throw new IllegalArgumentException("Only UTC is supported by this test clock");
			}
			return this;
		}

		@Override
		public Instant instant() {
			return instant;
		}
	}
}

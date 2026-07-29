package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.config.TestProperties;
import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

class TurnCredentialServiceTest {

	private static final String SHARED_SECRET = "test-shared-secret";
	private static final List<String> TURN_URLS = List.of(
			"turn:turn.example.com:3478?transport=udp",
			"turns:turn.example.com:5349?transport=tcp");
	private static final ValidatorFactory VALIDATOR_FACTORY =
			Validation.buildDefaultValidatorFactory();
	private static final Validator VALIDATOR = VALIDATOR_FACTORY.getValidator();

	@AfterAll
	static void closeValidatorFactory() {
		VALIDATOR_FACTORY.close();
	}

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
		assertThat(first.expiresAt()).isEqualTo(1_800_000_600L);
		assertThat(first.username()).startsWith(first.expiresAt() + ":");
		assertThat(first.credential()).isEqualTo(hmac(first.username(), SHARED_SECRET));
		assertThat(sameNatClient.credential())
				.isEqualTo(hmac(sameNatClient.username(), SHARED_SECRET));
		assertThat(first.credential()).doesNotContain(SHARED_SECRET);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void allowsSixSameNatParticipantsToRefreshAtEightMinutesAndLimitsTheThirteenthIssue() {
		TurnProperties properties = enabledProperties();
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		for (int participant = 0; participant < 6; participant++) {
			issued(service.issueFor("192.0.2.10"));
		}
		clock.advanceSeconds(480);
		for (int refresh = 0; refresh < 6; refresh++) {
			issued(service.issueFor("192.0.2.10"));
		}

		TurnCredentialService.RateLimited thirteenth =
				rateLimited(service.issueFor("192.0.2.10"));
		assertThat(thirteenth.retryAfterSeconds()).isEqualTo(120);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(12);
		assertThat(registry.get("round.turn.credentials.rate_limited").counter().count())
				.isEqualTo(1);
	}

	@Test
	void isDisabledOnlyWhenBothSecretAndUrlsAreAbsent() {
		TurnProperties disabled = TestProperties.turn(List.of(), "");
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(disabled, clock, registry);

		assertThat(service.issueFor("192.0.2.10"))
				.isSameAs(TurnCredentialService.Disabled.INSTANCE);

		TurnProperties missingUrls = TestProperties.turn(List.of(), SHARED_SECRET);
		assertThat(violations(missingUrls))
				.extracting(ConstraintViolation::getMessage)
				.anySatisfy(message -> assertThat(message)
						.contains("configured together"))
				.allSatisfy(message -> assertThat(message)
						.doesNotContain(SHARED_SECRET));

		TurnProperties missingSecret = TestProperties.turn(
				List.of("turn:turn.example.com:3478"), "");
		assertThat(violations(missingSecret))
				.extracting(ConstraintViolation::getMessage)
				.anySatisfy(message -> assertThat(message)
						.contains("configured together"));
	}

	@Test
	void rejectsCredentialBearingOrInvalidTurnUrlsWithoutEchoingThem() {
		TurnProperties properties = TestProperties.turn(
				List.of("turn:user:password@turn.example.com:3478"), SHARED_SECRET);

		assertThat(violations(properties))
				.extracting(ConstraintViolation::getMessage)
				.anySatisfy(message -> assertThat(message)
						.contains("credential-free"))
				.allSatisfy(message -> assertThat(message)
						.doesNotContain("password"));
	}

	@Test
	void rateLimitsPerEffectiveAddressAndResetsAtTheWindowBoundary() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 2, 8, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		TurnCredentials first = issued(service.issueFor("198.51.100.10"));
		TurnCredentials second = issued(service.issueFor("198.51.100.10"));
		TurnCredentialService.RateLimited limited =
				rateLimited(service.issueFor("198.51.100.10"));

		assertThat(first.username()).isNotEqualTo(second.username());
		assertThat(limited.retryAfterSeconds()).isEqualTo(600);

		clock.advanceSeconds(300);
		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isEqualTo(300);

		clock.advanceSeconds(300);
		TurnCredentials afterReset = issued(service.issueFor("198.51.100.10"));
		assertThat(afterReset.username()).isNotIn(first.username(), second.username());
		assertThat(registry.get("round.turn.credentials.rate_limited").counter().count())
				.isEqualTo(2);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void backwardClockMovementDoesNotResetTurnIssuanceQuota() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 1, 2, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		TurnCredentialService service =
				service(properties, clock, new SimpleMeterRegistry());

		issued(service.issueFor("198.51.100.10"));
		clock.advanceSeconds(-1);

		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isEqualTo(600);
	}

	@Test
	void sharesTurnIssuanceQuotaAcrossOneIpv6Prefix() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 1, 8, 10_000);
		TurnCredentialService service = service(
				properties,
				new MutableClock(1_800_000_000),
				new SimpleMeterRegistry());

		issued(service.issueFor("2001:db8:abcd:12::1"));

		assertThat(service.issueFor("2001:db8:abcd:12:ffff::beef"))
				.isInstanceOf(TurnCredentialService.RateLimited.class);
		assertThat(service.issueFor("2001:db8:abcd:13::1"))
				.isInstanceOf(TurnCredentialService.Issued.class);
	}

	@Test
	void rateLimitsIssuanceAcrossClientAddressesAndResetsAtTheWindowBoundary() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 1, 2, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor("198.51.100.10"));
		issued(service.issueFor("198.51.100.11"));
		TurnCredentialService.RateLimited limited =
				rateLimited(service.issueFor("198.51.100.12"));

		assertThat(limited.retryAfterSeconds()).isEqualTo(600);
		assertThat(service.trackedClientCount()).isEqualTo(2);

		clock.advanceSeconds(300);
		assertThat(rateLimited(service.issueFor("198.51.100.12")).retryAfterSeconds())
				.isEqualTo(300);

		clock.advanceSeconds(300);
		issued(service.issueFor("198.51.100.12"));
		assertThat(registry.get("round.turn.credentials.rate_limited").counter().count())
				.isEqualTo(2);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void refusesUntrackedClientsWhenLiveWindowCapacityIsFullWithoutEvictingQuotaState() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 1, 8, 2);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(
				properties,
				clock,
				registry);

		issued(service.issueFor("198.51.100.1"));
		clock.advanceSeconds(60);
		issued(service.issueFor("198.51.100.2"));

		assertThat(service.trackedClientCount()).isEqualTo(2);
		assertThat(rateLimited(service.issueFor("198.51.100.3")).retryAfterSeconds())
				.isEqualTo(540);
		assertThat(rateLimited(service.issueFor("198.51.100.1")).retryAfterSeconds())
				.isEqualTo(540);
		assertThat(service.trackedClientCount()).isEqualTo(2);

		clock.advanceSeconds(540);
		issued(service.issueFor("198.51.100.3"));

		assertThat(service.trackedClientCount()).isEqualTo(2);
		assertThat(rateLimited(service.issueFor("198.51.100.2")).retryAfterSeconds())
				.isEqualTo(60);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
		assertThat(registry.get("round.turn.credentials.rate_limited").counter().count())
				.isEqualTo(3);
	}

	@Test
	void validatesRateLimitConfigurationWithoutEchoingSensitiveValues() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 0, 8, 10_000);
		Set<ConstraintViolation<TurnProperties>> violations = violations(properties);

		assertThat(violations)
				.extracting(violation -> violation.getPropertyPath().toString())
				.contains("rateLimitMaxRequests");
		assertThat(violations)
				.extracting(ConstraintViolation::getMessage)
				.allSatisfy(message -> assertThat(message)
						.doesNotContain(SHARED_SECRET));
	}

	@Test
	void validatesGlobalRateLimitConfigurationWithoutEchoingSensitiveValues() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 12, 0, 10_000);
		Set<ConstraintViolation<TurnProperties>> violations = violations(properties);

		assertThat(violations)
				.extracting(violation -> violation.getPropertyPath().toString())
				.contains("rateLimitGlobalMaxRequests");
		assertThat(violations)
				.extracting(ConstraintViolation::getMessage)
				.allSatisfy(message -> assertThat(message)
						.doesNotContain(SHARED_SECRET));
	}

	@Test
	void requiresGlobalQuotaForTwoMisalignedClientWindows() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				TURN_URLS, SHARED_SECRET, 4, 7, 10_000);

		assertThat(violations(properties))
				.extracting(ConstraintViolation::getMessage)
				.contains(
						"round.turn.rate-limit-global-max-requests must be at least twice "
								+ "rate-limit-max-requests");
	}

	private static TurnProperties enabledProperties() {
		return TestProperties.turn(TURN_URLS, SHARED_SECRET);
	}

	private static Set<ConstraintViolation<TurnProperties>> violations(
			TurnProperties properties) {
		return VALIDATOR.validate(properties);
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
				new TurnCredentialMetrics(registry),
				new ClientAddressKeyResolver());
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

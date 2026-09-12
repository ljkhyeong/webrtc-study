package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.TestProperties;
import com.personal.round.config.TurnProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class TurnCredentialServiceTest {

	private static final String KEY_ID = "test-turn-key";
	private static final String API_TOKEN = "test-turn-token";
	private static final List<String> TURN_URLS = List.of(
			"turn:turn.example.com:3478?transport=udp",
			"turns:turn.example.com:5349?transport=tcp");

	@Test
	void returnsUniqueCloudflareCredentialsForClientsBehindTheSameNat() {
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
		assertThat(first.refreshAfterSeconds()).isEqualTo(480);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void neverIssuesAProtectedCredentialBeyondTheGrantExpiry() {
		TurnProperties properties = enabledProperties();
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		TurnCredentials credentials = issued(service.issueFor(
				"192.0.2.10",
				grant(
						"abcd-efgh-jkmp",
						"member-1",
						"ticket-1",
						Instant.ofEpochSecond(1_800_000_120))));

		assertThat(credentials.expiresAt()).isEqualTo(1_800_000_120);
		assertThat(credentials.refreshAfterSeconds()).isEqualTo(90);
		assertThat(service.issueFor(
				"192.0.2.10",
				grant(
						"abcd-efgh-jkmp",
						"member-1",
						"ticket-2",
						Instant.ofEpochSecond(1_800_000_000))))
				.isSameAs(TurnCredentialService.AuthorizationExpired.INSTANCE);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isOne();
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
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isEqualTo(1);
	}

	@Test
	void isDisabledWhenTurnConfigurationIsAbsent() {
		TurnProperties disabled = TestProperties.turn("", "");
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(disabled, clock, registry);

		assertThat(service.issueFor("192.0.2.10"))
				.isSameAs(TurnCredentialService.Disabled.INSTANCE);
	}

	@Test
	void countsProviderFailuresTowardTheAttemptRateLimit() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 1, 2, 10_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		CloudflareTurnClient client = mock(CloudflareTurnClient.class);
		when(client.issue(anyLong())).thenThrow(
				new CloudflareTurnClient.ProviderUnavailableException("provider unavailable"));
		MutableClock clock = new MutableClock(1_800_000_000);
		TurnCredentialService service = new TurnCredentialService(
				properties,
				clock,
				clock::nanoTime,
				new TurnCredentialMetrics(registry),
				new ClientAddressKeyResolver(),
				client);

		assertThat(service.issueFor("192.0.2.10"))
				.isSameAs(TurnCredentialService.ProviderUnavailable.INSTANCE);
		assertThat(service.issueFor("192.0.2.10"))
				.isInstanceOf(TurnCredentialService.RateLimited.class);
		verify(client).issue(anyLong());
		assertThat(registry.get("round.turn.credentials.provider.errors").counter().count())
				.isOne();
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isZero();
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isOne();
	}

	@Test
	void rateLimitsPerEffectiveAddressAndResetsAtTheWindowBoundary() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 2, 8, 10_000);
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
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isEqualTo(2);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void standaloneIssuanceDoesNotCreateOrApplyParticipantQuotaState() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 2, 1, 4, 10_000, 1);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service =
				service(properties, clock, registry);

		issued(service.issueFor("198.51.100.10"));
		issued(service.issueFor("198.51.100.10"));

		rateLimited(service.issueFor("198.51.100.10"));
		issued(service.issueFor(
				"198.51.100.11",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "client")
				.counter()
				.count())
				.isOne();
	}

	@Test
	void backwardClockMovementDoesNotResetTurnIssuanceQuota() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 1, 2, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		TurnCredentialService service =
				service(properties, clock, new SimpleMeterRegistry());

		issued(service.issueFor("198.51.100.10"));
		clock.advanceWallClockSeconds(-1);

		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isEqualTo(600);
	}

	@Test
	void usesMonotonicTimeForForwardClockJumpsAndRetryBoundaries() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 1, 2, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		TurnCredentialService service =
				service(properties, clock, new SimpleMeterRegistry());

		issued(service.issueFor("198.51.100.10"));
		clock.advanceWallClockSeconds(3_600);

		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isEqualTo(600);

		clock.advanceTickerMillis(599_001);
		assertThat(rateLimited(service.issueFor("198.51.100.10")).retryAfterSeconds())
				.isOne();

		clock.advanceTickerMillis(999);
		issued(service.issueFor("198.51.100.10"));
	}

	@Test
	void sharesTurnIssuanceQuotaAcrossOneIpv6Prefix() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 1, 8, 10_000);
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
				KEY_ID, API_TOKEN, 1, 2, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor("198.51.100.10"));
		issued(service.issueFor("198.51.100.11"));
		TurnCredentialService.RateLimited limited =
				rateLimited(service.issueFor("198.51.100.12"));

		assertThat(limited.retryAfterSeconds()).isEqualTo(600);
		clock.advanceSeconds(300);
		assertThat(rateLimited(service.issueFor("198.51.100.12")).retryAfterSeconds())
				.isEqualTo(300);

		clock.advanceSeconds(300);
		issued(service.issueFor("198.51.100.12"));
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isEqualTo(2);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
	}

	@Test
	void refusesUntrackedClientsWhenLiveWindowCapacityIsFullWithoutEvictingQuotaState() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 1, 8, 2);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(
				properties,
				clock,
				registry);

		issued(service.issueFor("198.51.100.1"));
		clock.advanceSeconds(60);
		issued(service.issueFor("198.51.100.2"));

		assertThat(rateLimited(service.issueFor("198.51.100.3")).retryAfterSeconds())
				.isEqualTo(540);
		assertThat(rateLimited(service.issueFor("198.51.100.1")).retryAfterSeconds())
				.isEqualTo(540);
		clock.advanceSeconds(540);
		issued(service.issueFor("198.51.100.3"));

		assertThat(rateLimited(service.issueFor("198.51.100.2")).retryAfterSeconds())
				.isEqualTo(60);
		assertThat(registry.get("round.turn.credentials.issued").counter().count())
				.isEqualTo(3);
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isEqualTo(3);
	}

	@Test
	void rateLimitsOneParticipantAcrossNewTicketsAndClientAddresses() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 12, 2, 24, 10_000, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor(
				"198.51.100.10",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		issued(service.issueFor(
				"198.51.100.11",
				grant("abcd-efgh-jkmp", "member-1", "ticket-2", clock)));

		TurnCredentialService.RateLimited limited = rateLimited(service.issueFor(
				"198.51.100.12",
				grant("abcd-efgh-jkmp", "member-1", "ticket-3", clock)));
		issued(service.issueFor(
				"198.51.100.12",
				grant("qrst-uvwx-yz23", "member-1", "ticket-4", clock)));
		issued(service.issueFor(
				"198.51.100.13",
				grant("abcd-efgh-jkmp", "member-2", "ticket-5", clock)));

		assertThat(limited.retryAfterSeconds()).isEqualTo(600);
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant")
				.counter()
				.count())
				.isOne();
		assertThat(metricCount(registry, "round.turn.credentials.rate_limited"))
				.isOne();
	}

	@Test
	void participantRejectionDoesNotConsumeClientOrGlobalQuota() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 2, 1, 4, 10_000, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service =
				service(properties, clock, registry);

		issued(service.issueFor(
				"198.51.100.1",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		rateLimited(service.issueFor(
				"198.51.100.2",
				grant("abcd-efgh-jkmp", "member-1", "ticket-2", clock)));

		issued(service.issueFor(
				"198.51.100.2",
				grant("abcd-efgh-jkmp", "member-2", "ticket-3", clock)));
		issued(service.issueFor(
				"198.51.100.2",
				grant("abcd-efgh-jkmp", "member-3", "ticket-4", clock)));
		issued(service.issueFor(
				"198.51.100.3",
				grant("abcd-efgh-jkmp", "member-4", "ticket-5", clock)));

		rateLimited(service.issueFor(
				"198.51.100.4",
				grant("abcd-efgh-jkmp", "member-5", "ticket-6", clock)));
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant")
				.counter()
				.count())
				.isOne();
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "global")
				.counter()
				.count())
				.isOne();
	}

	@Test
	void refusesUntrackedParticipantsWhenLiveWindowCapacityIsFull() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 12, 6, 24, 10_000, 2);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor(
				"198.51.100.1",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		clock.advanceSeconds(60);
		issued(service.issueFor(
				"198.51.100.2",
				grant("abcd-efgh-jkmp", "member-2", "ticket-2", clock)));

		TurnCredentialService.RateLimited limited = rateLimited(service.issueFor(
				"198.51.100.3",
				grant("abcd-efgh-jkmp", "member-3", "ticket-3", clock)));
		assertThat(limited.retryAfterSeconds()).isEqualTo(540);
		issued(service.issueFor(
				"198.51.100.1",
				grant("abcd-efgh-jkmp", "member-1", "ticket-4", clock)));
		clock.advanceSeconds(540);
		issued(service.issueFor(
				"198.51.100.3",
				grant("abcd-efgh-jkmp", "member-3", "ticket-5", clock)));

		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant_state_capacity")
				.counter()
				.count())
				.isOne();
	}

	@Test
	void atomicallyLimitsConcurrentParticipantRequestsWithVirtualThreads()
			throws Exception {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 12, 6, 24, 10_000, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service =
				service(properties, clock, registry);
		ParticipationGrant grant =
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock);
		CountDownLatch ready = new CountDownLatch(40);
		CountDownLatch start = new CountDownLatch(1);
		List<Callable<TurnCredentialService.IssueResult>> requests = IntStream
				.range(0, 40)
				.mapToObj(ignored -> (Callable<TurnCredentialService.IssueResult>)
						() -> {
							ready.countDown();
							if (!start.await(5, TimeUnit.SECONDS)) {
								throw new IllegalStateException(
										"Concurrent TURN issuance start timed out");
							}
							return service.issueFor("198.51.100.10", grant);
						})
				.toList();

		List<Future<TurnCredentialService.IssueResult>> results;
		try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
			results = requests.stream().map(executor::submit).toList();
			try {
				assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
			}
			finally {
				start.countDown();
			}
		}

		List<TurnCredentialService.IssueResult> outcomes = results.stream()
				.map(TurnCredentialServiceTest::completed)
				.toList();
		assertThat(outcomes)
				.filteredOn(TurnCredentialService.Issued.class::isInstance)
				.hasSize(6);
		assertThat(outcomes)
				.filteredOn(TurnCredentialService.RateLimited.class::isInstance)
				.hasSize(34);
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant")
				.counter()
				.count())
				.isEqualTo(34);
	}

	@Test
	void reportsTheScopeWithTheLongestExactRetryWindow() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 2, 1, 4, 10_000, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor(
				"198.51.100.1",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		clock.advanceSeconds(60);
		issued(service.issueFor(
				"198.51.100.2",
				grant("abcd-efgh-jkmp", "member-2", "ticket-2", clock)));
		issued(service.issueFor(
				"198.51.100.3",
				grant("abcd-efgh-jkmp", "member-3", "ticket-3", clock)));
		issued(service.issueFor(
				"198.51.100.4",
				grant("abcd-efgh-jkmp", "member-4", "ticket-4", clock)));

		TurnCredentialService.RateLimited limited = rateLimited(service.issueFor(
				"198.51.100.5",
				grant("abcd-efgh-jkmp", "member-2", "ticket-5", clock)));

		assertThat(limited.retryAfterSeconds()).isEqualTo(600);
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant")
				.counter()
				.count())
				.isOne();
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "global")
				.counter()
				.count())
				.isZero();
	}

	@Test
	void reportsGlobalScopeWhenParticipantAndGlobalWindowsExpireTogether() {
		TurnProperties properties = TestProperties.turnWithRateLimits(
				KEY_ID, API_TOKEN, 2, 1, 4, 10_000, 10_000);
		MutableClock clock = new MutableClock(1_800_000_000);
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		TurnCredentialService service = service(properties, clock, registry);

		issued(service.issueFor(
				"198.51.100.1",
				grant("abcd-efgh-jkmp", "member-1", "ticket-1", clock)));
		for (int participant = 2; participant <= 4; participant++) {
			issued(service.issueFor(
					"198.51.100." + participant,
					grant(
							"abcd-efgh-jkmp",
							"member-" + participant,
							"ticket-" + participant,
							clock)));
		}

		TurnCredentialService.RateLimited limited = rateLimited(service.issueFor(
				"198.51.100.5",
				grant("abcd-efgh-jkmp", "member-1", "ticket-5", clock)));

		assertThat(limited.retryAfterSeconds()).isEqualTo(600);
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "global")
				.counter()
				.count())
				.isOne();
		assertThat(registry.get("round.turn.credentials.rate_limited")
				.tag("scope", "participant")
				.counter()
				.count())
				.isZero();
	}

	@Test
	void redactsParticipantIdentityFromQuotaKeyDiagnostics() {
		assertThat(new ParticipantRoomKey("abcd-efgh-jkmp", "sensitive-member").toString())
				.isEqualTo("ParticipantRoomKey[redacted]")
				.doesNotContain("abcd-efgh-jkmp", "sensitive-member");
	}

	private static TurnProperties enabledProperties() {
		return TestProperties.turn(KEY_ID, API_TOKEN);
	}

	private static ParticipationGrant grant(
			String roomId,
			String subject,
			String tokenId,
			MutableClock clock) {
		return grant(
				roomId,
				subject,
				tokenId,
				clock.instant().plusSeconds(300));
	}

	private static ParticipationGrant grant(
			String roomId,
			String subject,
			String tokenId,
			Instant expiresAt) {
		return new ParticipationGrant(
				subject,
				"study-1",
				roomId,
				ParticipationGrant.Role.PARTICIPANT,
				tokenId,
				expiresAt.minusSeconds(300),
				expiresAt);
	}

	private static TurnCredentialService service(
			TurnProperties properties,
			MutableClock clock,
			SimpleMeterRegistry registry) {
		CloudflareTurnClient client = mock(CloudflareTurnClient.class);
		AtomicLong sequence = new AtomicLong();
		when(client.issue(anyLong())).thenAnswer(ignored -> {
			long value = sequence.incrementAndGet();
			return new TurnCredentialMaterial(
					TURN_URLS,
					"provider-user-" + value,
					"provider-credential-" + value);
		});
		return new TurnCredentialService(
				properties,
				clock,
				clock::nanoTime,
				new TurnCredentialMetrics(registry),
				new ClientAddressKeyResolver(),
				client);
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

	private static TurnCredentialService.IssueResult completed(
			Future<TurnCredentialService.IssueResult> future) {
		try {
			return future.get();
		}
		catch (Exception exception) {
			throw new AssertionError("Concurrent TURN issuance failed", exception);
		}
	}

	private static double metricCount(
			SimpleMeterRegistry registry,
			String name) {
		return registry.find(name)
				.counters()
				.stream()
				.mapToDouble(Counter::count)
				.sum();
	}

	private static final class MutableClock extends Clock {

		private Instant instant;
		private long nanoTime;

		private MutableClock(long epochSecond) {
			this.instant = Instant.ofEpochSecond(epochSecond);
		}

		private void advanceSeconds(long seconds) {
			advanceWallClockSeconds(seconds);
			nanoTime = Math.addExact(
					nanoTime,
					TimeUnit.SECONDS.toNanos(seconds));
		}

		private void advanceWallClockSeconds(long seconds) {
			instant = instant.plusSeconds(seconds);
		}

		private void advanceTickerMillis(long millis) {
			nanoTime = Math.addExact(
					nanoTime,
					TimeUnit.MILLISECONDS.toNanos(millis));
		}

		private long nanoTime() {
			return nanoTime;
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

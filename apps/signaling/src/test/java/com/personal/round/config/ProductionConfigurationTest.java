package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.auth.RoundAuthProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import com.personal.round.turn.CloudflareTurnClient;
import com.personal.round.turn.TurnCredentialMetrics;
import com.personal.round.turn.TurnCredentialService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class ProductionConfigurationTest {

	private final ApplicationContextRunner runner = new ApplicationContextRunner()
			.withInitializer(new ConfigDataApplicationContextInitializer())
			.withUserConfiguration(ConfigurationPropertiesBindingTest.PropertiesConfiguration.class);

	private ApplicationContextRunner production() {
		return runner.withPropertyValues(
				"spring.profiles.active=production",
				"ROUND_AUTH_ISSUER=https://b4ton.com",
				"ROUND_AUTH_JWK_SET_URI=https://b4ton.com/.well-known/round-participation-jwks.json",
				"ALLOWED_ORIGINS=https://b4ton.com");
	}

	@Test
	void readsBatonTurnUrlsAndMountedSecret(@TempDir Path secrets) throws Exception {
		String secret = "test-only-baton-turn-secret-32-characters";
		Files.writeString(secrets.resolve("round.turn.shared-secret"), secret);
		production().withPropertyValues(
				"spring.config.import=configtree:" + secrets + "/",
				"TURN_URLS=turn:turn.b4ton.com:3478?transport=udp,turns:turn.b4ton.com:5349?transport=tcp")
				.run(context -> {
					assertThat(context).hasNotFailed();
					assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isTrue();
					TurnProperties turn = context.getBean(TurnProperties.class);
					assertThat(turn.provider()).isEqualTo(TurnProperties.Provider.COTURN);
					assertThat(turn.coturnUrls()).containsExactly(
							"turn:turn.b4ton.com:3478?transport=udp",
							"turns:turn.b4ton.com:5349?transport=tcp");
					assertThat(turn.coturnSecret()).isEqualTo(secret);
					assertThat(turn.toString()).doesNotContain(secret);
				});
	}

	@Test
	void explicitCoturnSettingsTakePrecedenceOverBatonAliases() {
		production().withPropertyValues(
				"TURN_COTURN_URLS=turn:turn.b4ton.com:3478?transport=tcp",
				"TURN_COTURN_SECRET=test-only-current-secret-32-characters",
				"TURN_URLS=turn:old.invalid:3478",
				"round.turn.shared-secret=test-only-previous-secret-32-characters",
				"TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS=6",
				"TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS=12")
				.run(context -> {
					assertThat(context).hasNotFailed();
					TurnProperties turn = context.getBean(TurnProperties.class);
					assertThat(turn.coturnUrls()).containsExactly("turn:turn.b4ton.com:3478?transport=tcp");
					assertThat(turn.coturnSecret()).isEqualTo("test-only-current-secret-32-characters");
					assertThat(turn.rateLimitMaxRequests()).isEqualTo(6);
					assertThat(turn.rateLimitGlobalMaxRequests()).isEqualTo(12);
				});
	}

	@Test
	void supportsBatonRefreshesForSixParticipantsPerNatAndRetainsParticipantLimit() {
		production().withPropertyValues(
				"TURN_COTURN_URLS=turn:turn.b4ton.com:3478?transport=udp",
				"TURN_COTURN_SECRET=test-only-current-secret-32-characters")
				.run(context -> {
					assertThat(context).hasNotFailed();
					AtomicLong elapsed = new AtomicLong();
					long startedAt = 1_800_000_000L;
					Clock clock = mock(Clock.class);
					when(clock.millis()).thenAnswer(ignored -> (startedAt + elapsed.get()) * 1_000);
					CloudflareTurnClient cloudflare = mock(CloudflareTurnClient.class);
					SimpleMeterRegistry registry = new SimpleMeterRegistry();
					try {
						TurnCredentialService service = new TurnCredentialService(
								context.getBean(TurnProperties.class), clock,
								() -> TimeUnit.SECONDS.toNanos(elapsed.get()),
								new TurnCredentialMetrics(registry), new ClientAddressKeyResolver(), cloudflare);

						// 두 방에서 각각 같은 NAT의 6명이 5분 참여권으로 입장하고 4분마다 갱신한다.
						for (int seconds : new int[] {0, 240, 480}) {
							elapsed.set(seconds);
							for (int room = 0; room < 2; room++) {
								for (int participant = 0; participant < 6; participant++) {
									ParticipationGrant grant = grant(room, participant, startedAt + seconds);
									assertThat(service.issueFor("192.0.2." + (room + 1), grant))
											.as("%s초, 방 %s, 참가자 %s", seconds, room, participant)
											.isInstanceOfSatisfying(TurnCredentialService.Issued.class, issued -> {
												assertThat(issued.credentials().expiresAt())
														.isEqualTo(grant.expiresAt().getEpochSecond());
												assertThat(issued.credentials().refreshAfterSeconds()).isEqualTo(240);
											});
								}
							}
						}

						ParticipationGrant grant = grant(0, 0, startedAt + elapsed.get());
						for (int retry = 0; retry < 3; retry++) {
							assertThat(service.issueFor("192.0.2.1", grant))
									.isInstanceOf(TurnCredentialService.Issued.class);
						}
						assertThat(service.issueFor("192.0.2.1", grant))
								.isInstanceOfSatisfying(TurnCredentialService.RateLimited.class,
										limited -> assertThat(limited.retryAfterSeconds()).isEqualTo(120));
						elapsed.set(600);
						assertThat(service.issueFor("192.0.2.1", grant(0, 0, startedAt + 600)))
								.isInstanceOf(TurnCredentialService.Issued.class);
						verifyNoInteractions(cloudflare);
					}
					finally {
						registry.close();
					}
				});
	}

	@Test
	void missingProductionSecretsFailInsteadOfDisablingTurn() {
		production().run(context -> assertThat(context).hasFailed());
		runner.withPropertyValues("spring.profiles.active=production", "TURN_PROVIDER=disabled")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining("BATON auth mode requires issuer and jwk-set-uri"));
	}

	@Test
	void explicitStandaloneAndDisabledSettingsRemainAvailable() {
		production().withPropertyValues("ROUND_AUTH_MODE=standalone", "TURN_PROVIDER=disabled")
				.run(context -> {
					assertThat(context).hasNotFailed();
					assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isFalse();
					assertThat(context.getBean(TurnProperties.class).enabled()).isFalse();
				});
		runner.run(context -> {
			assertThat(context).hasNotFailed();
			assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isFalse();
			assertThat(context.getBean(TurnProperties.class).enabled()).isFalse();
		});
	}

	private static ParticipationGrant grant(int room, int participant, long now) {
		return new ParticipationGrant(
				"member-" + participant, "study-" + room,
				room == 0 ? "abcd-efgh-jkmp" : "bcde-fghj-kmnp", ParticipationGrant.Role.PARTICIPANT,
				"ticket-" + now + "-" + participant,
				Instant.ofEpochSecond(now), Instant.ofEpochSecond(now + 300));
	}
}

package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.personal.round.auth.RoundAuthProperties;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class ConfigurationPropertiesBindingTest {

	private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
			.withUserConfiguration(PropertiesConfiguration.class)
			.withPropertyValues(
					"round.auth.mode=standalone",
					"round.auth.cookie-name=__Secure-round_access",
					"round.auth.audience=round",
					"round.auth.max-grant-lifetime=5m",
					"round.signaling.allowed-origins=http://localhost:5173",
					"round.signaling.max-room-size=6",
					"round.signaling.max-connections=1000",
					"round.signaling.max-connections-per-client=12",
					"round.signaling.heartbeat-interval=30s",
					"round.signaling.unjoined-timeout=15s",
					"round.signaling.unjoined-sweep-interval=1s",
					"round.signaling.shutdown-close-timeout=5s",
					"round.signaling.abuse-window=10s",
					"round.signaling.max-frames-per-session-window=600",
					"round.signaling.max-frames-per-client-window=1200",
					"round.signaling.max-frames-global-window=3600",
					"round.signaling.max-bytes-per-session-window=4194304",
					"round.signaling.max-bytes-per-client-window=8388608",
					"round.signaling.max-bytes-global-window=25165824",
					"round.signaling.max-outbound-queue-bytes=2097152",
					"round.signaling.max-outbound-queue-bytes-global=67108864",
					"round.signaling.max-text-payload-bytes=65536",
					"round.turn.credential-ttl=10m",
					"round.turn.rate-limit-window=600s",
					"round.turn.rate-limit-max-requests=12",
					"round.turn.rate-limit-participant-max-requests=6",
					"round.turn.rate-limit-global-max-requests=24",
					"round.turn.rate-limit-max-clients=10000",
					"round.turn.rate-limit-max-participants=10000");

	@Test
	void bindsIsoAndReadableDurationsAndKeepsDisabledTurnConfigurationImmutable() {
		contextRunner
				.withPropertyValues(
						"round.signaling.heartbeat-interval=PT45S",
						"round.signaling.unjoined-timeout=20s",
						"round.signaling.unjoined-sweep-interval=750ms",
						"round.signaling.abuse-window=PT10S",
						"round.turn.credential-ttl=PT1H",
						"round.turn.rate-limit-window=45s")
				.run(context -> {
					assertThat(context.getStartupFailure()).isNull();
					SignalingProperties signaling = context.getBean(SignalingProperties.class);
					TurnProperties turn = context.getBean(TurnProperties.class);

					assertThat(signaling.heartbeatInterval()).isEqualTo(Duration.ofSeconds(45));
					assertThat(signaling.unjoinedTimeout()).isEqualTo(Duration.ofSeconds(20));
					assertThat(signaling.unjoinedSweepInterval()).isEqualTo(Duration.ofMillis(750));
					assertThat(signaling.abuseWindow()).isEqualTo(Duration.ofSeconds(10));
					assertThat(signaling.maxFramesPerClientWindow()).isEqualTo(1_200);
					assertThat(signaling.maxBytesPerSessionWindow()).isEqualTo(4_194_304);
					assertThat(signaling.maxBytesPerClientWindow()).isEqualTo(8_388_608);
					assertThat(signaling.maxBytesGlobalWindow()).isEqualTo(25_165_824);
					assertThat(signaling.maxOutboundQueueBytes()).isEqualTo(2_097_152);
					assertThat(signaling.maxOutboundQueueBytesGlobal()).isEqualTo(67_108_864);
					assertThat(turn.credentialTtl()).isEqualTo(Duration.ofHours(1));
					assertThat(turn.rateLimitWindow()).isEqualTo(Duration.ofSeconds(45));
					assertThat(turn.rateLimitMaxRequests()).isEqualTo(12);
					assertThat(turn.rateLimitParticipantMaxRequests()).isEqualTo(6);
					assertThat(turn.rateLimitGlobalMaxRequests()).isEqualTo(24);
					assertThat(turn.rateLimitMaxParticipants()).isEqualTo(10_000);
					assertThat(turn.enabled()).isFalse();
					assertThat(turn.urls()).isEmpty();
					assertThat(turn.sharedSecret()).isEmpty();
					assertThatThrownBy(() -> signaling.allowedOrigins().add("https://other.example"))
							.isInstanceOf(UnsupportedOperationException.class);
				});
	}

	@Test
	void recordConstructorsDefensivelyCopyBothConfigurationCollections() {
		List<String> origins = new ArrayList<>(List.of("https://study.example"));
		List<String> urls = new ArrayList<>(List.of("turn:turn.example.com:3478"));
		SignalingProperties defaults = TestProperties.signaling();
		TurnProperties turnDefaults = TestProperties.turn(List.of(), "");
		SignalingProperties signaling = new SignalingProperties(
				origins,
				defaults.maxRoomSize(),
				defaults.maxConnections(),
				defaults.maxConnectionsPerClient(),
				defaults.heartbeatInterval(),
				defaults.unjoinedTimeout(),
				defaults.unjoinedSweepInterval(),
				defaults.shutdownCloseTimeout(),
				defaults.abuseWindow(),
				defaults.maxFramesPerSessionWindow(),
				defaults.maxFramesPerClientWindow(),
				defaults.maxFramesGlobalWindow(),
				defaults.maxBytesPerSessionWindow(),
				defaults.maxBytesPerClientWindow(),
				defaults.maxBytesGlobalWindow(),
				defaults.maxOutboundQueueBytes(),
				defaults.maxOutboundQueueBytesGlobal(),
				defaults.maxTextPayloadBytes());
		TurnProperties turn = new TurnProperties(
				urls,
				"shared-secret",
				turnDefaults.credentialTtl(),
				turnDefaults.rateLimitWindow(),
				turnDefaults.rateLimitMaxRequests(),
				turnDefaults.rateLimitParticipantMaxRequests(),
				turnDefaults.rateLimitGlobalMaxRequests(),
				turnDefaults.rateLimitMaxClients(),
				turnDefaults.rateLimitMaxParticipants());

		origins.add("https://other.example");
		urls.add("turns:turn.example.com:5349");

		assertThat(signaling.allowedOrigins()).containsExactly("https://study.example");
		assertThat(turn.urls()).containsExactly("turn:turn.example.com:3478");
		assertThatThrownBy(() -> signaling.allowedOrigins().add("https://blocked.example"))
				.isInstanceOf(UnsupportedOperationException.class);
		assertThatThrownBy(() -> turn.urls().add("turn:blocked.example"))
				.isInstanceOf(UnsupportedOperationException.class);
		assertThat(turn.toString())
				.contains("urls=<1 configured>", "sharedSecret=<redacted>")
				.doesNotContain("turn.example.com", "shared-secret");
	}

	@Test
	void rejectsInvalidCrossFieldLimitsDuringContextStartup() {
		contextRunner
				.withPropertyValues(
						"round.signaling.max-connections=5",
						"round.signaling.max-connections-per-client=6")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.max-connections must not be lower than "
											+ "max-room-size")
							.hasStackTraceContaining(
									"round.signaling.max-connections-per-client must not exceed "
											+ "max-connections");
				});
	}

	@Test
	void rejectsIncompleteOrInsecureBatonVerifierConfigurationDuringContextStartup() {
		contextRunner
				.withPropertyValues(
						"round.auth.mode=baton",
						"round.auth.issuer=http://baton.example/oauth2",
						"round.auth.jwk-set-uri=")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"BATON auth mode requires issuer and jwk-set-uri")
							.hasStackTraceContaining(
									"BATON auth issuer and jwk-set-uri must use HTTPS "
											+ "or loopback HTTP");
				});
	}

	@Test
	void keepsConnectionCapacityInsideTheBoundedShutdownPolicy() {
		contextRunner
				.withPropertyValues(
						"round.signaling.max-connections=5001",
						"round.signaling.max-connections-per-client=5001")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.max-connections must be at most 5000")
							.hasStackTraceContaining(
									"round.signaling.max-connections-per-client must be at most 5000");
				});
	}

	@Test
	void rejectsRoomSizesAboveTheSupportedMeshLimit() {
		contextRunner
				.withPropertyValues("round.signaling.max-room-size=7")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining(
								"round.signaling.max-room-size must be at most 6"));
	}

	@Test
	void rejectsSessionSweepIntervalsAboveTheAuthorizationExpiryBudget() {
		contextRunner
				.withPropertyValues("round.signaling.unjoined-sweep-interval=1001ms")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining(
								"round.signaling.unjoined-sweep-interval must be at most 1s "
										+ "for authorization expiry enforcement"));
	}

	@Test
	void rejectsInvalidTimingAndFrameRelationshipsDuringContextStartup() {
		contextRunner
				.withPropertyValues(
						"round.signaling.unjoined-sweep-interval=16s",
						"round.signaling.max-frames-per-client-window=599",
						"round.signaling.max-frames-global-window=1197")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.unjoined-sweep-interval must not exceed "
											+ "unjoined-timeout")
							.hasStackTraceContaining(
									"round.signaling.max-frames-per-client-window must not be lower "
											+ "than max-frames-per-session-window");
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.max-frames-global-window must be at least "
											+ "twice max-frames-per-client-window");
				});
	}

	@Test
	void validatesFrameRelationshipsWithoutIntegerOverflow() {
		contextRunner
				.withPropertyValues(
						"round.signaling.max-frames-per-session-window=1",
						"round.signaling.max-frames-per-client-window=1500000000",
						"round.signaling.max-frames-global-window=2000000000")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining(
								"round.signaling.max-frames-global-window must be at least "
										+ "twice max-frames-per-client-window"));
	}

	@Test
	void rejectsInvalidByteBudgetRelationshipsDuringContextStartup() {
		contextRunner
				.withPropertyValues(
						"round.signaling.max-bytes-per-session-window=200",
						"round.signaling.max-bytes-per-client-window=100",
						"round.signaling.max-bytes-global-window=199",
						"round.signaling.max-outbound-queue-bytes=65535",
						"round.signaling.max-outbound-queue-bytes-global=65534")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.max-bytes-per-client-window must not be lower "
											+ "than max-bytes-per-session-window")
							.hasStackTraceContaining(
									"round.signaling.max-bytes-global-window must be at least twice "
											+ "max-bytes-per-client-window")
							.hasStackTraceContaining(
									"round.signaling.max-outbound-queue-bytes must not be lower than "
											+ "max-text-payload-bytes")
							.hasStackTraceContaining(
									"round.signaling.max-outbound-queue-bytes-global must not be lower "
											+ "than max-outbound-queue-bytes");
				});
	}

	@Test
	void keepsPayloadAndOutboundBudgetsInsideTheContainerHeapPolicy() {
		contextRunner
				.withPropertyValues(
						"round.signaling.max-outbound-queue-bytes=16777217",
						"round.signaling.max-outbound-queue-bytes-global=134217729",
						"round.signaling.max-text-payload-bytes=65537")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.max-outbound-queue-bytes must be at most 16777216")
							.hasStackTraceContaining(
									"round.signaling.max-outbound-queue-bytes-global must be at most "
											+ "134217728")
							.hasStackTraceContaining(
									"round.signaling.max-text-payload-bytes must be exactly 65536");
				});
	}

	@Test
	void rejectsTooShortDurationDuringContextStartup() {
		contextRunner
				.withPropertyValues("round.signaling.unjoined-timeout=999ms")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.unjoined-timeout must be at least 1s");
				});
	}

	@Test
	void keepsTheCloseDeadlineInsideTheSpringShutdownPhase() {
		contextRunner
				.withPropertyValues("round.signaling.shutdown-close-timeout=10s")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining(
								"round.signaling.shutdown-close-timeout must be at most 9s"));
	}

	@Test
	void turnCrossFieldValidationDoesNotExposeSecretOrUrlValues() {
		String secret = "must-not-appear-in-validation-errors";
		String credentialBearingUrl = "turn:user:password@turn.example.com:3478";

		contextRunner
				.withPropertyValues(
						"round.turn.urls=" + credentialBearingUrl,
						"round.turn.shared-secret=" + secret)
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.turn.urls must contain only credential-free turn: "
											+ "or turns: URLs");
					assertThat(stackTrace(failure))
							.doesNotContain(secret)
							.doesNotContain(credentialBearingUrl);
				});
	}

	private static String stackTrace(Throwable failure) {
		StringWriter output = new StringWriter();
		failure.printStackTrace(new PrintWriter(output));
		return output.toString();
	}

	@Configuration(proxyBeanMethods = false)
	@EnableConfigurationProperties({
		RoundAuthProperties.class,
		SignalingProperties.class,
		TurnProperties.class
	})
	static class PropertiesConfiguration {
	}
}

package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
					"round.signaling.allowed-origins=http://localhost:5173",
					"round.signaling.max-room-size=6",
					"round.signaling.max-connections=1000",
					"round.signaling.max-connections-per-client=12",
					"round.signaling.heartbeat-interval=30s",
					"round.signaling.unjoined-timeout=15s",
					"round.signaling.unjoined-sweep-interval=1s",
					"round.signaling.abuse-window=10s",
					"round.signaling.max-frames-per-session-window=600",
					"round.signaling.max-frames-global-window=3600",
					"round.signaling.max-text-payload-bytes=65536",
					"round.turn.credential-ttl=10m",
					"round.turn.rate-limit-window=60s",
					"round.turn.rate-limit-max-requests=12",
					"round.turn.rate-limit-global-max-requests=8",
					"round.turn.rate-limit-max-clients=10000");

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
					assertThat(turn.credentialTtl()).isEqualTo(Duration.ofHours(1));
					assertThat(turn.rateLimitWindow()).isEqualTo(Duration.ofSeconds(45));
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
				defaults.abuseWindow(),
				defaults.maxFramesPerSessionWindow(),
				defaults.maxFramesGlobalWindow(),
				defaults.maxTextPayloadBytes());
		TurnProperties turn = new TurnProperties(
				urls,
				"shared-secret",
				turnDefaults.credentialTtl(),
				turnDefaults.rateLimitWindow(),
				turnDefaults.rateLimitMaxRequests(),
				turnDefaults.rateLimitGlobalMaxRequests(),
				turnDefaults.rateLimitMaxClients());

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
	void rejectsInvalidTimingAndFrameRelationshipsDuringContextStartup() {
		contextRunner
				.withPropertyValues(
						"round.signaling.unjoined-sweep-interval=16s",
						"round.signaling.max-frames-global-window=599")
				.run(context -> {
					Throwable failure = context.getStartupFailure();

					assertThat(failure).isNotNull();
					assertThat(failure)
							.hasStackTraceContaining(
									"round.signaling.unjoined-sweep-interval must not exceed "
											+ "unjoined-timeout")
							.hasStackTraceContaining(
									"round.signaling.max-frames-global-window must not be lower "
											+ "than max-frames-per-session-window");
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
	@EnableConfigurationProperties({SignalingProperties.class, TurnProperties.class})
	static class PropertiesConfiguration {
	}
}

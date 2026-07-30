package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class TurnPropertiesUrlValidationTest {

	private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
			.withUserConfiguration(PropertiesConfiguration.class)
			.withPropertyValues(
					"round.turn.credential-ttl=10m",
					"round.turn.rate-limit-window=10m",
					"round.turn.rate-limit-max-requests=12",
					"round.turn.rate-limit-participant-max-requests=6",
					"round.turn.rate-limit-global-max-requests=24",
					"round.turn.rate-limit-max-clients=10000",
					"round.turn.rate-limit-max-participants=10000");

	@ParameterizedTest
	@ValueSource(strings = {
			"turn:turn.example.com",
			"turn:turn.example.com:3478?transport=udp",
			"turns:turn.example.com:5349?transport=tcp",
			"TURN:[2001:db8::1]:3478?transport=custom-1"
	})
	void acceptsSyntacticallyValidCredentialFreeTurnUrls(String url) {
		contextRunner
				.withPropertyValues(
						"round.turn.urls=" + url,
						"round.turn.shared-secret=test-shared-secret")
				.run(context -> {
					assertThat(context.getStartupFailure()).isNull();
					assertThat(context.getBean(TurnProperties.class).urls())
							.containsExactly(url);
				});
	}

	@ParameterizedTest
	@ValueSource(strings = {
			"https://turn.example.com:3478",
			"turn:",
			"turn://turn.example.com:3478",
			"turn:user:password@turn.example.com:3478",
			"turn:turn.example.com:not-a-port",
			"turn:turn.example.com:65536",
			"turn:turn.example.com:3478/path",
			"turn:turn.example.com:3478?transport=",
			"turn:turn.example.com:3478?other=udp",
			"turn:[2001:db8::1"
	})
	void rejectsMalformedOrCredentialBearingTurnUrls(String url) {
		contextRunner
				.withPropertyValues(
						"round.turn.urls=" + url,
						"round.turn.shared-secret=test-shared-secret")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining(
								"round.turn.urls must contain only credential-free turn: "
										+ "or turns: URLs"));
	}

	@Configuration(proxyBeanMethods = false)
	@EnableConfigurationProperties(TurnProperties.class)
	static class PropertiesConfiguration {
	}
}

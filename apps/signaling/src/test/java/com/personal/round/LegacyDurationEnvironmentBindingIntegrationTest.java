package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TurnProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class LegacyDurationEnvironmentBindingIntegrationTest {

	private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
			.withInitializer(new ConfigDataApplicationContextInitializer())
			.withUserConfiguration(PropertiesConfiguration.class)
			.withPropertyValues(
					"HEARTBEAT_INTERVAL_MS=45000",
					"UNJOINED_SOCKET_TIMEOUT_MS=20000",
					"UNJOINED_SOCKET_SWEEP_MS=750",
					"SIGNALING_ABUSE_WINDOW_MS=12000",
					"TURN_CREDENTIAL_TTL_SECONDS=900",
					"TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS=45");

	@Test
	void appendsUnitsToLegacyNumericEnvironmentValuesBeforeDurationBinding() {
		contextRunner.run(context -> {
			assertThat(context.getStartupFailure()).isNull();
			SignalingProperties signaling = context.getBean(SignalingProperties.class);
			TurnProperties turn = context.getBean(TurnProperties.class);

			assertThat(signaling.heartbeatInterval()).isEqualTo(Duration.ofSeconds(45));
			assertThat(signaling.unjoinedTimeout()).isEqualTo(Duration.ofSeconds(20));
			assertThat(signaling.unjoinedSweepInterval()).isEqualTo(Duration.ofMillis(750));
			assertThat(signaling.abuseWindow()).isEqualTo(Duration.ofSeconds(12));
			assertThat(turn.credentialTtl()).isEqualTo(Duration.ofMinutes(15));
			assertThat(turn.rateLimitWindow()).isEqualTo(Duration.ofSeconds(45));
		});
	}

	@Configuration(proxyBeanMethods = false)
	@EnableConfigurationProperties({SignalingProperties.class, TurnProperties.class})
	static class PropertiesConfiguration {}
}

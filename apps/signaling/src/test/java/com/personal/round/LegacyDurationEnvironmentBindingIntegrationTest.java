package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TurnProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"HEARTBEAT_INTERVAL_MS=45000",
			"UNJOINED_SOCKET_TIMEOUT_MS=20000",
			"UNJOINED_SOCKET_SWEEP_MS=750",
			"SIGNALING_ABUSE_WINDOW_MS=12000",
			"TURN_CREDENTIAL_TTL_SECONDS=900",
			"TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS=45"
		})
class LegacyDurationEnvironmentBindingIntegrationTest {

	@Autowired
	private SignalingProperties signaling;

	@Autowired
	private TurnProperties turn;

	@Test
	void appendsUnitsToLegacyNumericEnvironmentValuesBeforeDurationBinding() {
		assertThat(signaling.heartbeatInterval()).isEqualTo(Duration.ofSeconds(45));
		assertThat(signaling.unjoinedTimeout()).isEqualTo(Duration.ofSeconds(20));
		assertThat(signaling.unjoinedSweepInterval()).isEqualTo(Duration.ofMillis(750));
		assertThat(signaling.abuseWindow()).isEqualTo(Duration.ofSeconds(12));
		assertThat(signaling.maxFramesPerSessionWindow()).isEqualTo(600);
		assertThat(signaling.maxFramesPerClientWindow()).isEqualTo(1_200);
		assertThat(signaling.maxFramesGlobalWindow()).isEqualTo(3_600);
		assertThat(turn.credentialTtl()).isEqualTo(Duration.ofMinutes(15));
		assertThat(turn.rateLimitWindow()).isEqualTo(Duration.ofSeconds(45));
		assertThat(turn.rateLimitMaxRequests()).isEqualTo(12);
		assertThat(turn.rateLimitGlobalMaxRequests()).isEqualTo(24);
	}
}

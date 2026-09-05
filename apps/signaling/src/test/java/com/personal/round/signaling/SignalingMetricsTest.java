package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

class SignalingMetricsTest {

	@Test
	void 모든_거절_지표를_첫_요청_전에도_0으로_등록한다() {
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		new SignalingMetrics(registry);

		assertThat(registry.get("round.signaling.joins.rejected").counters())
				.allSatisfy(counter -> assertThat(counter.count()).isZero())
				.extracting(counter -> counter.getId().getTag("reason"))
				.containsExactlyInAnyOrder(
						"room_full", "already_joined", "unauthorized_room", "invalid_host_capability");
		assertThat(registry.get("round.signaling.connections.rejected").counters())
				.allSatisfy(counter -> assertThat(counter.count()).isZero())
				.extracting(counter -> counter.getId().getTag("reason"))
				.containsExactlyInAnyOrder(
						"server_capacity", "client_capacity", "participation_token_capacity",
						"participant_room_capacity", "missing_reservation", "missing_room_access");
	}
}

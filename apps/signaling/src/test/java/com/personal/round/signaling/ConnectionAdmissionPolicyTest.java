package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.config.SignalingProperties;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.Test;

class ConnectionAdmissionPolicyTest {

	private static final InetSocketAddress FIRST_CLIENT =
			new InetSocketAddress("192.0.2.10", 41_000);
	private static final InetSocketAddress SAME_CLIENT_DIFFERENT_PORT =
			new InetSocketAddress("192.0.2.10", 42_000);
	private static final InetSocketAddress SECOND_CLIENT =
			new InetSocketAddress("192.0.2.11", 41_000);

	@Test
	void enforcesClientAndServerCapacityUsingOnlyTheRemoteAddress() {
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		ConnectionAdmissionPolicy policy = policy(3, 2, registry);

		ConnectionAdmissionPolicy.Admission first = policy.reserve(FIRST_CLIENT);
		ConnectionAdmissionPolicy.Admission second =
				policy.reserve(SAME_CLIENT_DIFFERENT_PORT);
		ConnectionAdmissionPolicy.Admission sameClientRejected =
				policy.reserve(FIRST_CLIENT);
		ConnectionAdmissionPolicy.Admission otherClient = policy.reserve(SECOND_CLIENT);
		ConnectionAdmissionPolicy.Admission serverRejected =
				policy.reserve(new InetSocketAddress("192.0.2.12", 41_000));

		assertThat(first.accepted()).isTrue();
		assertThat(second.accepted()).isTrue();
		assertThat(sameClientRejected.rejection())
				.isEqualTo(ConnectionAdmissionPolicy.Rejection.CLIENT_CAPACITY);
		assertThat(otherClient.accepted()).isTrue();
		assertThat(serverRejected.rejection())
				.isEqualTo(ConnectionAdmissionPolicy.Rejection.SERVER_CAPACITY);
		assertThat(policy.activeReservationCount()).isEqualTo(3);
		assertThat(policy.activeReservationCount(FIRST_CLIENT)).isEqualTo(2);
		assertThat(registry.get("round.signaling.connections.rejected")
				.tag("reason", "client_capacity")
				.counter()
				.count()).isEqualTo(1);
		assertThat(registry.get("round.signaling.connections.rejected")
				.tag("reason", "server_capacity")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void releasesReservationsIdempotentlyAndRemovesEmptyClientState() {
		ConnectionAdmissionPolicy policy = policy(1, 1, new SimpleMeterRegistry());
		ConnectionAdmissionPolicy.Reservation reservation =
				policy.reserve(FIRST_CLIENT).reservation();

		reservation.close();
		reservation.close();

		assertThat(policy.activeReservationCount()).isZero();
		assertThat(policy.activeReservationCount(FIRST_CLIENT)).isZero();
		assertThat(policy.reserve(FIRST_CLIENT).accepted()).isTrue();
	}

	private static ConnectionAdmissionPolicy policy(
			int maxConnections,
			int maxConnectionsPerClient,
		SimpleMeterRegistry registry) {
		SignalingProperties properties = new SignalingProperties();
		properties.setMaxRoomSize(1);
		properties.setMaxConnections(maxConnections);
		properties.setMaxConnectionsPerClient(maxConnectionsPerClient);
		return new ConnectionAdmissionPolicy(properties, new SignalingMetrics(registry));
	}
}

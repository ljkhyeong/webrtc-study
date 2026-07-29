package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.config.TestProperties;
import com.personal.round.net.ClientAddressKeyResolver;
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

		assertAccepted(first);
		assertAccepted(second);
		assertThat(sameClientRejected)
				.isEqualTo(new ConnectionAdmissionPolicy.Rejected(
						ConnectionAdmissionPolicy.Rejection.CLIENT_CAPACITY));
		assertAccepted(otherClient);
		assertThat(serverRejected)
				.isEqualTo(new ConnectionAdmissionPolicy.Rejected(
						ConnectionAdmissionPolicy.Rejection.SERVER_CAPACITY));
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
				acceptedReservation(policy.reserve(FIRST_CLIENT));

		reservation.close();
		reservation.close();

		assertThat(policy.activeReservationCount()).isZero();
		assertThat(policy.activeReservationCount(FIRST_CLIENT)).isZero();
		assertAccepted(policy.reserve(FIRST_CLIENT));
	}

	@Test
	void appliesOneConnectionLimitAcrossRotatingIpv6InterfaceIdentifiers() {
		ConnectionAdmissionPolicy policy = policy(3, 1, new SimpleMeterRegistry());
		InetSocketAddress first =
				new InetSocketAddress("2001:db8:abcd:12::1", 41_000);
		InetSocketAddress samePrefix =
				new InetSocketAddress("2001:db8:abcd:12:ffff::beef", 42_000);
		InetSocketAddress otherPrefix =
				new InetSocketAddress("2001:db8:abcd:13::1", 41_000);

		assertAccepted(policy.reserve(first));
		assertThat(policy.reserve(samePrefix))
				.isEqualTo(new ConnectionAdmissionPolicy.Rejected(
						ConnectionAdmissionPolicy.Rejection.CLIENT_CAPACITY));
		assertAccepted(policy.reserve(otherPrefix));
		assertThat(policy.activeReservationCount(first)).isOne();
		assertThat(policy.activeReservationCount(samePrefix)).isOne();
	}

	private static ConnectionAdmissionPolicy policy(
			int maxConnections,
			int maxConnectionsPerClient,
			SimpleMeterRegistry registry) {
		return new ConnectionAdmissionPolicy(
				TestProperties.signalingWithConnectionLimits(
						1, maxConnections, maxConnectionsPerClient),
				new SignalingMetrics(registry),
				new ClientAddressKeyResolver());
	}

	private static void assertAccepted(ConnectionAdmissionPolicy.Admission admission) {
		assertThat(admission).isInstanceOf(ConnectionAdmissionPolicy.Accepted.class);
	}

	private static ConnectionAdmissionPolicy.Reservation acceptedReservation(
			ConnectionAdmissionPolicy.Admission admission) {
		assertAccepted(admission);
		return ((ConnectionAdmissionPolicy.Accepted) admission).reservation();
	}
}

package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.TestProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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

	@Test
	void rejectsConcurrentReuseOfTheSameParticipationToken() {
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		ConnectionAdmissionPolicy policy = policy(4, 4, registry);
		ParticipationGrant grant = grant(
				"member-42",
				"study-7",
				"abcd-efgh-jkmp",
				"ticket-1");

		ConnectionAdmissionPolicy.Reservation first = acceptedReservation(
				policy.reserve(FIRST_CLIENT, grant));

		assertThat(policy.reserve(SECOND_CLIENT, grant))
				.isEqualTo(new ConnectionAdmissionPolicy.Rejected(
						ConnectionAdmissionPolicy.Rejection
								.PARTICIPATION_TOKEN_CAPACITY));
		assertThat(policy.activeParticipationTokenReservationCount(grant.tokenId()))
				.isOne();
		assertThat(policy.activeParticipantRoomReservationCount(grant)).isOne();
		assertThat(registry.get("round.signaling.connections.rejected")
				.tag("reason", "participation_token_capacity")
				.counter()
				.count()).isOne();

		first.close();

		assertThat(policy.activeParticipationTokenReservationCount(grant.tokenId()))
				.isZero();
		assertThat(policy.activeParticipantRoomReservationCount(grant)).isZero();
		acceptedReservation(policy.reserve(SECOND_CLIENT, grant)).close();
	}

	@Test
	void allowsOneFreshGrantReconnectOverlapAndRejectsAThirdParticipantSocket() {
		SimpleMeterRegistry registry = new SimpleMeterRegistry();
		ConnectionAdmissionPolicy policy = policy(6, 6, registry);
		ParticipationGrant firstGrant = grant(
				"member-42",
				"study-7",
				"abcd-efgh-jkmp",
				"ticket-1");
		ParticipationGrant reconnectGrant = grant(
				"member-42",
				"study-8",
				"abcd-efgh-jkmp",
				"ticket-2");
		ParticipationGrant excessGrant = grant(
				"member-42",
				"study-9",
				"abcd-efgh-jkmp",
				"ticket-3");

		ConnectionAdmissionPolicy.Reservation first = acceptedReservation(
				policy.reserve(FIRST_CLIENT, firstGrant));
		ConnectionAdmissionPolicy.Reservation reconnect = acceptedReservation(
				policy.reserve(SECOND_CLIENT, reconnectGrant));

		assertThat(policy.reserve(
						new InetSocketAddress("192.0.2.12", 41_000),
						excessGrant))
				.isEqualTo(new ConnectionAdmissionPolicy.Rejected(
						ConnectionAdmissionPolicy.Rejection
								.PARTICIPANT_ROOM_CAPACITY));
		assertThat(policy.activeParticipantRoomReservationCount(firstGrant))
				.isEqualTo(2);
		assertThat(registry.get("round.signaling.connections.rejected")
				.tag("reason", "participant_room_capacity")
				.counter()
				.count()).isOne();

		first.close();
		ConnectionAdmissionPolicy.Reservation replacement = acceptedReservation(
				policy.reserve(
						new InetSocketAddress("192.0.2.12", 41_000),
						excessGrant));

		reconnect.close();
		replacement.close();
		assertThat(policy.activeParticipantRoomReservationCount(firstGrant)).isZero();
	}

	@Test
	void doesNotApplyParticipationLimitsToStandaloneReservations() {
		ConnectionAdmissionPolicy policy = policy(3, 3, new SimpleMeterRegistry());

		ConnectionAdmissionPolicy.Reservation first = acceptedReservation(
				policy.reserve(FIRST_CLIENT));
		ConnectionAdmissionPolicy.Reservation second = acceptedReservation(
				policy.reserve(FIRST_CLIENT));
		ConnectionAdmissionPolicy.Reservation third = acceptedReservation(
				policy.reserve(FIRST_CLIENT));

		assertThat(policy.activeReservationCount()).isEqualTo(3);

		first.close();
		second.close();
		third.close();
	}

	@Test
	void admitsExactlyTwoConcurrentFreshGrantReservationsForOneParticipant()
			throws Exception {
		ConnectionAdmissionPolicy policy = policy(32, 32, new SimpleMeterRegistry());
		int attempts = 20;
		CountDownLatch ready = new CountDownLatch(attempts);
		CountDownLatch start = new CountDownLatch(1);
		List<Future<ConnectionAdmissionPolicy.Admission>> futures =
				new ArrayList<>();

		try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
			for (int index = 0; index < attempts; index++) {
				int attempt = index;
				futures.add(executor.submit(() -> {
					ready.countDown();
					start.await();
					return policy.reserve(
							new InetSocketAddress(
									"192.0.2." + (attempt + 1),
									41_000),
							grant(
									"member-42",
									"study-7",
									"abcd-efgh-jkmp",
									"ticket-" + attempt));
				}));
			}

			boolean allWorkersReady = ready.await(2, TimeUnit.SECONDS);
			start.countDown();
			assertThat(allWorkersReady).isTrue();

			List<ConnectionAdmissionPolicy.Admission> admissions =
					new ArrayList<>();
			for (Future<ConnectionAdmissionPolicy.Admission> future : futures) {
				admissions.add(future.get(2, TimeUnit.SECONDS));
			}

			List<ConnectionAdmissionPolicy.Reservation> accepted = admissions.stream()
					.filter(ConnectionAdmissionPolicy.Accepted.class::isInstance)
					.map(ConnectionAdmissionPolicy.Accepted.class::cast)
					.map(ConnectionAdmissionPolicy.Accepted::reservation)
					.toList();
			assertThat(accepted).hasSize(2);
			assertThat(admissions.stream()
					.filter(ConnectionAdmissionPolicy.Rejected.class::isInstance)
					.map(ConnectionAdmissionPolicy.Rejected.class::cast)
					.map(ConnectionAdmissionPolicy.Rejected::reason))
					.containsOnly(
							ConnectionAdmissionPolicy.Rejection
									.PARTICIPANT_ROOM_CAPACITY);

			accepted.forEach(ConnectionAdmissionPolicy.Reservation::close);
		}

		assertThat(policy.activeReservationCount()).isZero();
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

	private static ParticipationGrant grant(
			String subject,
			String studyId,
			String roomId,
			String tokenId) {
		return new ParticipationGrant(
				subject,
				studyId,
				roomId,
				ParticipationGrant.Role.PARTICIPANT,
				tokenId,
				Instant.parse("2026-07-30T00:00:00Z"),
				Instant.parse("2026-07-30T00:05:00Z"));
	}
}

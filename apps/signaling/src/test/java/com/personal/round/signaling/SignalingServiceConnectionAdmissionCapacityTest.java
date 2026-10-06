package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;

class SignalingServiceConnectionAdmissionCapacityTest extends SignalingServiceTestSupport {

	@Test
	void enforcesRoomCapacityAtomicallyUnderConcurrentJoins() throws Exception {
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < 12; index++) {
			TestPeer peer = peer("session-" + index);
			peers.add(peer);
			connect(peer);
		}

		CountDownLatch ready = new CountDownLatch(peers.size());
		CountDownLatch start = new CountDownLatch(1);
		try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
			for (int index = 0; index < peers.size(); index++) {
				int peerIndex = index;
				executor.submit(() -> {
					ready.countDown();
					start.await();
					service.handle(peers.get(peerIndex).session(), join("Peer " + peerIndex));
					return null;
				});
			}
			assertThat(ready.await(2, TimeUnit.SECONDS)).isTrue();
			start.countDown();
		}

		assertThat(service.participantCount(ROOM_ID)).isEqualTo(6);
		peers.forEach(TestPeer::awaitTextMessage);
		long joinedCount = peers.stream()
				.filter(peer -> peer.hasMessage(
						node -> node.has("type")
								&& "room.joined".equals(node.get("type").asString())))
				.count();
		long fullCount = peers.stream()
				.filter(peer -> peer.hasMessage(
						node -> node.at("/payload/code").isString()
								&& "ROOM_FULL".equals(node.at("/payload/code").asString())))
				.count();
		assertThat(joinedCount).isEqualTo(6);
		assertThat(fullCount).isEqualTo(6);
		assertThat(meterRegistry.get("round.signaling.joins.rejected")
				.tag("reason", "room_full")
				.counter()
				.count()).isEqualTo(6);
		assertThat(meterRegistry.get("round.signaling.rooms.active").gauge().value())
				.isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.peers.joined").gauge().value())
				.isEqualTo(6);
	}


	@Test
	void rejectsConnectionsWithoutAnAdmissionReservation() throws Exception {
		TestPeer missingReservation = peer("missing-reservation");

		assertThat(service.connect(missingReservation.session())).isFalse();

		missingReservation.awaitClosed();
		assertThat(missingReservation.closeStatus().get())
				.isEqualTo(CloseStatus.SERVER_ERROR.withReason("Connection admission required"));
		assertThat(service.connectedPeerCount()).isZero();
		assertThat(meterRegistry.get("round.signaling.connections.rejected")
				.tag("reason", "missing_reservation")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void releasesAdmissionReservationsOnDisconnectStopAndConnectRejection()
			throws Exception {
		ConnectionAdmissionPolicy policy = admissionPolicy(properties(6));
		TestPeer accepted = peer("reserved-accepted");
		attachReservation(accepted, acceptedReservation(policy.reserve("192.0.2.30", null)));
		assertThat(service.connect(accepted.session())).isTrue();

		service.disconnect(accepted.session());
		service.disconnect(accepted.session());
		assertThat(policy.activeReservationCount()).isZero();

		TestPeer stoppedPeer = peer("reserved-stop");
		attachReservation(stoppedPeer, acceptedReservation(policy.reserve("192.0.2.32", null)));
		assertThat(service.connect(stoppedPeer.session())).isTrue();
		service.stop();
		assertThat(policy.activeReservationCount()).isZero();

		TestPeer rejected = peer("reserved-rejected");
		attachReservation(rejected, acceptedReservation(policy.reserve("192.0.2.31", null)));
		assertThat(service.connect(rejected.session())).isFalse();
		rejected.awaitClosed();
		assertThat(rejected.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		assertThat(policy.activeReservationCount()).isZero();
	}
}

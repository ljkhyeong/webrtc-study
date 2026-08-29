package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TestProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.protocol.ServerMessageEncoder.Participant;
import com.personal.round.protocol.SignalingErrorCode;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.JsonNode;

class SignalingServiceParticipationGrantReconnectTest extends SignalingServiceTestSupport {

	@Test
	void batonReconnectReplacesTheOnlyJoinedSessionWithoutLeavingAnUntrackedRoom()
			throws Exception {
		SignalingService batonService = newBatonService(new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant originalGrant = grantFor(
				ROOM_ID,
				"reconnecting-user",
				"original-token",
				clock.instant().plusSeconds(120));
		batonService.start();
		try {
			TestPeer original = peer("original-session");
			attachGrantReservation(
					original,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.120", 41_120),
					originalGrant);
			assertThat(batonService.connect(original.session())).isTrue();
			batonService.handle(original.session(), join("Original"));
			original.nextJson();

			clock.advanceMillis(1);
			ParticipationGrant freshGrant = grantFor(
					ROOM_ID,
					"reconnecting-user",
					"fresh-token",
					clock.instant().plusSeconds(120));
			TestPeer replacement = peer("replacement-session");
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.121", 41_121),
					freshGrant);
			assertThat(batonService.connect(replacement.session())).isTrue();

			batonService.handle(replacement.session(), join("Replacement"));

			original.awaitClosed();
			assertThat(original.closeStatus().get())
					.isEqualTo(new CloseStatus(4002, "Participation session superseded"));
			JsonNode replacementJoined = replacement.nextJson();
			assertThat(replacementJoined.get("type").asString()).isEqualTo("room.joined");
			assertThat(replacementJoined.at("/payload/participants").size()).isZero();
			assertThat(batonService.roomCount()).isOne();
			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonService.connectedPeerCount()).isOne();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeParticipationTokenReservationCount(
							originalGrant.tokenId()) == 0);
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					freshGrant.tokenId())).isOne();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isOne();

			batonService.disconnect(original.session());
			verify(original.session()).close(
					new CloseStatus(4002, "Participation session superseded"));
			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isOne();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void queuePressureDuringBatonSupersessionCannotLeaveADisconnectedReplacementInRoom()
			throws Exception {
		String fixturePeerId = "p".repeat(36);
		int maxPeerQueueBytes = 64 * 1024;
		int desiredReplacementBytes = maxPeerQueueBytes - 64;
		int errorOverheadBytes = serverMessageEncoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"",
				null,
				null).getPayloadLength();
		int firstPayloadBytes = desiredReplacementBytes / 2;
		int secondPayloadBytes = desiredReplacementBytes - firstPayloadBytes;
		int firstDetailLength = firstPayloadBytes - errorOverheadBytes;
		int secondDetailLength = secondPayloadBytes - errorOverheadBytes;
		int leftBytes = serverMessageEncoder.peerLeft(ROOM_ID, fixturePeerId).getPayloadLength();
		long globalQueueBytes = (long) desiredReplacementBytes + leftBytes - 1;
		assertThat(firstDetailLength).isPositive();
		assertThat(secondDetailLength).isPositive();
		assertThat(globalQueueBytes).isGreaterThanOrEqualTo(maxPeerQueueBytes);

		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				2,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				maxPeerQueueBytes,
				globalQueueBytes);
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(properties, batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy = admissionPolicy(properties);
		ParticipationGrant originalGrant = grantFor(
				ROOM_ID,
				"reconnecting-pressure-user",
				"pressure-original-token",
				clock.instant().plusSeconds(120));
		ParticipationGrant observerGrant = grantFor(
				ROOM_ID,
				"pressure-observer-user",
				"pressure-observer-token",
				clock.instant().plusSeconds(120));
		clock.advanceMillis(1);
		ParticipationGrant replacementGrant = grantFor(
				ROOM_ID,
				"reconnecting-pressure-user",
				"pressure-replacement-token",
				clock.instant().plusSeconds(120));
		CountDownLatch replacementSendEntered = new CountDownLatch(1);
		CountDownLatch releaseReplacementSend = new CountDownLatch(1);
		batonService.start();
		try {
			TestPeer original = peer("pressure-original");
			attachGrantReservation(
					original,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.140", 41_140),
					originalGrant);
			assertThat(batonService.connect(original.session())).isTrue();
			batonService.handle(original.session(), join("Original"));
			original.nextJson();

			TestPeer observer = peer("pressure-observer");
			attachGrantReservation(
					observer,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.141", 41_141),
					observerGrant);
			assertThat(batonService.connect(observer.session())).isTrue();
			batonService.handle(observer.session(), join("Observer"));
			JsonNode observerJoined = observer.nextJson();
			String originalPeerId = observerJoined.at("/payload/participants/0/peerId").asString();
			original.nextJson();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonRegistry.get("round.signaling.outbound.queue.bytes")
							.gauge()
							.value() == 0);

			TestPeer replacement = peer(
					"pressure-replacement",
					replacementSendEntered,
					releaseReplacementSend);
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.142", 41_142),
					replacementGrant);
			assertThat(batonService.connect(replacement.session())).isTrue();
			batonService.sendInvalidMessage(
					replacement.session(),
					"x".repeat(firstDetailLength));
			assertThat(replacementSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			batonService.sendInvalidMessage(
					replacement.session(),
					"y".repeat(secondDetailLength));
			assertThat(batonRegistry.get("round.signaling.outbound.queue.bytes")
					.gauge()
					.value()).isEqualTo(desiredReplacementBytes);

			batonService.handle(replacement.session(), join("Replacement"));
			releaseReplacementSend.countDown();

			JsonNode originalLeft = observer.nextJson();
			assertThat(originalLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(originalLeft.at("/payload/peerId").asString()).isEqualTo(originalPeerId);
			original.awaitClosed();
			replacement.awaitClosed();
			assertThat(original.closeStatus().get())
					.isEqualTo(new CloseStatus(4002, "Participation session superseded"));
			assertThat(replacement.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			observer.assertNoTextMessageFor(Duration.ofMillis(100));
			assertThat(batonService.roomCount()).isOne();
			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonService.connectedPeerCount()).isOne();
			assertThat(batonRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(1);
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeReservationCount() == 1);
		}
		finally {
			releaseReplacementSend.countDown();
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void delayedOlderBatonJoinCannotSupersedeTheNewerSession() throws Exception {
		SignalingService batonService = newBatonService(new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant originalGrant = grantFor(
				ROOM_ID,
				"reconnecting-user",
				"original-token",
				clock.instant().plusSeconds(120));
		ParticipationGrant freshGrant = grantFor(
				ROOM_ID,
				"reconnecting-user",
				"fresh-token",
				clock.instant().plusSeconds(120));
		batonService.start();
		try {
			TestPeer original = peer("original-session");
			attachGrantReservation(
					original,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.122", 41_122),
					originalGrant);
			assertThat(batonService.connect(original.session())).isTrue();

			TestPeer replacement = peer("replacement-session");
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.123", 41_123),
					freshGrant);
			assertThat(batonService.connect(replacement.session())).isTrue();
			batonService.handle(replacement.session(), join("Replacement"));

			JsonNode replacementJoined = replacement.nextJson();
			assertThat(replacementJoined.get("type").asString()).isEqualTo("room.joined");
			batonService.handle(original.session(), join("Original delayed"));

			original.awaitClosed();
			assertThat(original.closeStatus().get())
					.isEqualTo(new CloseStatus(4002, "Participation session superseded"));
			original.assertNoTextMessageFor(Duration.ofMillis(100));
			replacement.assertNoTextMessageFor(Duration.ofMillis(100));
			assertThat(replacement.closeStatus().get()).isNull();
			assertThat(batonService.roomCount()).isOne();
			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonService.connectedPeerCount()).isOne();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeParticipationTokenReservationCount(
							originalGrant.tokenId()) == 0);
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					freshGrant.tokenId())).isOne();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void freshBatonReconnectSupersedesTheSameParticipantInAFullRoom()
			throws Exception {
		SignalingService batonService = newBatonService(new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		List<TestPeer> peers = new ArrayList<>();
		List<String> peerIds = new ArrayList<>();
		List<ParticipationGrant> grants = new ArrayList<>();
		batonService.start();
		try {
			for (int index = 0; index < 6; index++) {
				ParticipationGrant grant = grantFor(
						ROOM_ID,
						"baton-user-" + index,
						"baton-token-" + index,
						clock.instant().plusSeconds(120));
				TestPeer peer = peer("baton-session-" + index);
				attachGrantReservation(
						peer,
						batonAdmissionPolicy,
						new InetSocketAddress("192.0.2." + (130 + index), 41_130 + index),
						grant);
				assertThat(batonService.connect(peer.session())).isTrue();
				batonService.handle(peer.session(), join("Participant " + index));
				JsonNode joined = peer.nextJson();
				String joinedPeerId = joined.at("/payload/peerId").asString();
				assertThat(joined.at("/payload/participants").size()).isEqualTo(index);
				for (TestPeer existing : peers) {
					JsonNode peerJoined = existing.nextJson();
					assertThat(peerJoined.get("type").asString()).isEqualTo("peer.joined");
					assertThat(peerJoined.at("/payload/participant/peerId").asString())
							.isEqualTo(joinedPeerId);
				}
				peers.add(peer);
				peerIds.add(joinedPeerId);
				grants.add(grant);
			}

			TestPeer original = peers.get(5);
			String originalPeerId = peerIds.get(5);
			ParticipationGrant originalGrant = grants.get(5);
			clock.advanceMillis(1);
			ParticipationGrant freshGrant = grantFor(
					ROOM_ID,
					originalGrant.subject(),
					"baton-token-fresh",
					clock.instant().plusSeconds(120));
			TestPeer replacement = peer("baton-session-fresh");
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.140", 41_140),
					freshGrant);
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isEqualTo(2);
			assertThat(batonService.connect(replacement.session())).isTrue();

			batonService.handle(replacement.session(), join("Participant 5 reconnected"));

			original.awaitClosed();
			assertThat(original.closeStatus().get())
					.isEqualTo(new CloseStatus(4002, "Participation session superseded"));
			JsonNode replacementJoined = replacement.nextJson();
			String replacementPeerId = replacementJoined.at("/payload/peerId").asString();
			assertThat(replacementJoined.get("type").asString()).isEqualTo("room.joined");
			assertThat(replacementJoined.at("/payload/participants").size()).isEqualTo(5);
			assertThat(replacementJoined.at("/payload/participants").toString())
					.doesNotContain(originalPeerId);

			TestPeer observer = peers.get(0);
			JsonNode peerLeft = observer.nextJson();
			JsonNode peerJoined = observer.nextJson();
			assertThat(peerLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(peerLeft.at("/payload/peerId").asString())
					.isEqualTo(originalPeerId);
			assertThat(peerJoined.get("type").asString()).isEqualTo("peer.joined");
			assertThat(peerJoined.at("/payload/participant/peerId").asString())
					.isEqualTo(replacementPeerId);

			assertThat(batonService.participantCount(ROOM_ID)).isEqualTo(6);
			assertThat(batonService.connectedPeerCount()).isEqualTo(6);
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeParticipationTokenReservationCount(
							originalGrant.tokenId()) == 0);
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					freshGrant.tokenId())).isOne();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isOne();
			batonService.disconnect(original.session());
			verify(original.session()).close(
					new CloseStatus(4002, "Participation session superseded"));
			assertThat(batonService.participantCount(ROOM_ID)).isEqualTo(6);
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void supersededSessionKeepsItsReservationAndTerminalCloseAcrossLateFailures()
			throws Exception {
		SignalingService batonService = newBatonService(new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant originalGrant = grantFor(
				ROOM_ID,
				"racing-user",
				"racing-token-original",
				clock.instant().plusSeconds(120));
		batonService.start();
		try {
			TestPeer original = peer("racing-session-original");
			attachGrantReservation(
					original,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.150", 41_150),
					originalGrant);
			assertThat(batonService.connect(original.session())).isTrue();
			batonService.handle(original.session(), join("Original"));
			original.nextJson();

			clock.advanceMillis(1);
			ParticipationGrant freshGrant = grantFor(
					ROOM_ID,
					originalGrant.subject(),
					"racing-token-fresh",
					clock.instant().plusSeconds(120));
			TestPeer replacement = peer("racing-session-replacement");
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.151", 41_151),
					freshGrant);
			assertThat(batonService.connect(replacement.session())).isTrue();

			CountDownLatch closeEntered = new CountDownLatch(1);
			CountDownLatch releaseClose = new CountDownLatch(1);
			CountDownLatch unexpectedClose = new CountDownLatch(1);
			AtomicInteger closeAttempts = new AtomicInteger();
			List<CloseStatus> attemptedStatuses =
					Collections.synchronizedList(new ArrayList<>());
			doAnswer(invocation -> {
				CloseStatus status = invocation.getArgument(0);
				attemptedStatuses.add(status);
				if (closeAttempts.incrementAndGet() > 1) {
					unexpectedClose.countDown();
				}
				closeEntered.countDown();
				if (!releaseClose.await(2, TimeUnit.SECONDS)) {
					throw new java.io.IOException("Timed out waiting for close release");
				}
				original.closeStatus().set(status);
				throw new java.io.IOException("Simulated close failure");
			}).when(original.session()).close(any(CloseStatus.class));

			batonService.handle(replacement.session(), join("Replacement"));
			assertThat(closeEntered.await(2, TimeUnit.SECONDS)).isTrue();
			replacement.nextJson();

			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonService.connectedPeerCount()).isOne();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isEqualTo(2);
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isOne();

			ParticipationGrant thirdGrant = grantFor(
					ROOM_ID,
					originalGrant.subject(),
					"racing-token-third",
					clock.instant().plusSeconds(120));
			ConnectionAdmissionPolicy.Admission blockedAdmission =
					batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.152", 41_152),
							thirdGrant);
			assertThat(blockedAdmission).isEqualTo(new ConnectionAdmissionPolicy.Rejected(
					ConnectionAdmissionPolicy.Rejection.PARTICIPANT_ROOM_CAPACITY));

			batonService.handle(
					original.session(),
					new ClientMessage.Leave(ROOM_ID, "late-leave"));
			SignalingWebSocketHandler handler = new SignalingWebSocketHandler(
					new ProtocolParser(objectMapper),
					batonService);
			handler.handleTransportError(
					original.session(),
					new java.io.IOException("late transport failure"));
			assertThat(unexpectedClose.await(100, TimeUnit.MILLISECONDS)).isFalse();
			assertThat(closeAttempts.get()).isOne();

			releaseClose.countDown();
			original.awaitClosed();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeParticipantRoomReservationCount(freshGrant) == 1);
			assertThat(attemptedStatuses)
					.containsExactly(new CloseStatus(4002, "Participation session superseded"));
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					freshGrant.tokenId())).isOne();
			handler.handleTransportError(
					original.session(),
					new java.io.IOException("post-close transport failure"));
			await().atMost(Duration.ofSeconds(2)).until(() -> closeAttempts.get() == 2);
			assertThat(attemptedStatuses).containsExactly(
					new CloseStatus(4002, "Participation session superseded"),
					new CloseStatus(4002, "Participation session superseded"));
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isZero();

			ConnectionAdmissionPolicy.Admission admittedAfterClose =
					batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.152", 41_152),
							thirdGrant);
			ConnectionAdmissionPolicy.Reservation thirdReservation =
					acceptedReservation(admittedAfterClose);
			thirdReservation.close();
			handler.afterConnectionClosed(
					original.session(),
					new CloseStatus(4002, "Participation session superseded"));
			verify(original.session(), org.mockito.Mockito.times(2)).close(
					new CloseStatus(4002, "Participation session superseded"));
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					freshGrant)).isOne();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}
}

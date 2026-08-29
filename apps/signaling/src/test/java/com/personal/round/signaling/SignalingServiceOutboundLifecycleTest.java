package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.auth.RoomAccessPolicy;
import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TestProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ServerMessageEncoder.Participant;
import com.personal.round.protocol.SignalingErrorCode;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.JsonNode;

class SignalingServiceOutboundLifecycleTest extends SignalingServiceTestSupport {

	@Test
	void slowPeerDoesNotBlockAnotherRoom() throws Exception {
		CountDownLatch slowSendEntered = new CountDownLatch(1);
		CountDownLatch releaseSlowSend = new CountDownLatch(1);
		TestPeer slow = peer("slow", slowSendEntered, releaseSlowSend);
		TestPeer independent = peer("independent");
		connect(slow, independent);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(slowSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.handle(
					independent.session(),
					new ClientMessage.Join(OTHER_ROOM_ID, null, "Independent peer", null));
			JsonNode joined = independent.nextJson();

			assertThat(joined.get("type").asString()).isEqualTo("room.joined");
			assertThat(joined.get("roomId").asString()).isEqualTo(OTHER_ROOM_ID);
			assertThat(service.participantCount(OTHER_ROOM_ID)).isOne();
		}
		finally {
			releaseSlowSend.countDown();
		}
	}

	@Test
	void serializesJoinedRelayAndHeartbeatFramesPerPeer() throws Exception {
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		TestPeer ada = peer("ada-slow", firstSendEntered, releaseFirstSend);
		TestPeer grace = peer("grace");
		connect(ada, grace);

		try {
			service.handle(ada.session(), join("Ada"));
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.handle(grace.session(), join("Grace"));
			JsonNode graceJoined = grace.nextJson();
			String adaPeerId = graceJoined.at("/payload/participants/0/peerId").asString();

			service.handle(grace.session(), relay("rtc.offer", ROOM_ID, adaPeerId));
			service.handle(grace.session(), new ClientMessage.Relay(
					"rtc.ice",
					ROOM_ID,
					null,
					adaPeerId,
					ObjectNodeFixture.object(objectMapper, """
							{"candidate":null}
							""")));
			service.heartbeatSweep();

			releaseFirstSend.countDown();
			ada.awaitFrameCount(5);
			assertThat(ada.frameKinds()).startsWith(
					"room.joined", "peer.joined", "rtc.offer", "rtc.ice", "ping");
		}
		finally {
			releaseFirstSend.countDown();
		}
	}

	@Test
	void heartbeatDeadlineDisconnectsAPeerWhosePingIsStuckInTheOutboundQueue()
			throws Exception {
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		TestPeer slow = peer("heartbeat-queued", firstSendEntered, releaseFirstSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.heartbeatSweep();
			monotonicTicker.advanceMillis(properties(6).heartbeatInterval().toMillis());
			service.heartbeatSweep();

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(4000, "Heartbeat timeout"));
			assertThat(service.connectedPeerCount()).isZero();
			assertThat(meterRegistry.get("round.signaling.heartbeat.closes")
					.counter()
					.count()).isEqualTo(1);
		}
		finally {
			releaseFirstSend.countDown();
		}
	}

	@Test
	void sendFailureDisconnectsOnceAndBroadcastsPeerLeft() throws Exception {
		TestPeer ada = peer("ada");
		TestPeer grace = peer("grace");
		connect(ada, grace);
		service.handle(ada.session(), join("Ada"));
		ada.nextJson();
		service.handle(grace.session(), join("Grace"));
		String gracePeerId = grace.nextJson().at("/payload/peerId").asString();
		ada.nextJson();

		grace.failNextSend();
		service.sendInvalidMessage(grace.session(), "force a transport write");

		assertThat(ada.nextJson().at("/payload/peerId").asString()).isEqualTo(gracePeerId);
		grace.awaitClosed();
		assertThat(service.participantCount(ROOM_ID)).isOne();
		service.disconnect(grace.session());
		ada.assertNoTextMessageFor(Duration.ofMillis(100));
		assertThat(meterRegistry.get("round.signaling.frames.invalid").counter().count())
				.isEqualTo(1);
	}

	@Test
	void outboundQueueOverflowDisconnectsSlowPeer() throws Exception {
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		TestPeer slow = peer("overflow", firstSendEntered, releaseFirstSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			for (int index = 0; index <= SignalingService.MAX_OUTBOUND_QUEUE_SIZE; index++) {
				service.sendInvalidMessage(slow.session(), "queued-" + index);
			}

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(service.roomCount()).isZero();
			assertThat(meterRegistry.get("round.signaling.outbound.queue.overflows")
					.counter()
					.count()).isEqualTo(1);
		}
		finally {
			releaseFirstSend.countDown();
		}
	}

	@Test
	void outboundByteBudgetDisconnectsBeforeAFrameCountFlood() throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				1,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				64 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		TestPeer slow = peer("byte-overflow", firstSendEntered, releaseFirstSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			String largeDetail = "x".repeat(32 * 1024);
			service.sendInvalidMessage(slow.session(), largeDetail);
			service.sendInvalidMessage(slow.session(), largeDetail);

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(meterRegistry.get("round.signaling.outbound.queue.overflows")
					.counter()
					.count()).isEqualTo(1);
		}
		finally {
			releaseFirstSend.countDown();
		}
	}

	@Test
	void disconnectKeepsInFlightBytesReservedUntilTheBlockedSendReturns() throws Exception {
		CountDownLatch sendEntered = new CountDownLatch(1);
		CountDownLatch releaseSend = new CountDownLatch(1);
		TestPeer slow = peer("in-flight-accounting", sendEntered, releaseSend);
		connect(slow);

		service.sendInvalidMessage(slow.session(), "x".repeat(32 * 1024));
		assertThat(sendEntered.await(1, TimeUnit.SECONDS)).isTrue();
		service.disconnect(slow.session());

		assertThat(meterRegistry.get("round.signaling.outbound.queue.bytes")
				.gauge()
				.value()).isGreaterThan(32D * 1024D);

		releaseSend.countDown();
		await().atMost(Duration.ofSeconds(2)).until(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0);
	}

	@Test
	void globalOutboundByteBudgetEvictsTheLargestReleasableSlowPeer()
			throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				2,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				128 * 1024,
				160 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		CountDownLatch secondSendEntered = new CountDownLatch(1);
		CountDownLatch releaseSecondSend = new CountDownLatch(1);
		TestPeer first = peer("global-byte-queue-first", firstSendEntered, releaseFirstSend);
		TestPeer second = peer("global-byte-queue-second", secondSendEntered, releaseSecondSend);
		connect(first, second);

		try {
			String largeDetail = "x".repeat(48 * 1024);
			service.sendInvalidMessage(first.session(), largeDetail);
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.sendInvalidMessage(first.session(), largeDetail);
			service.sendInvalidMessage(second.session(), largeDetail);
			assertThat(secondSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.sendInvalidMessage(second.session(), largeDetail);

			first.awaitClosed();
			assertThat(first.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(second.closeStatus().get()).isNull();
			assertThat(service.connectedPeerCount()).isOne();
			assertThat(meterRegistry.get("round.signaling.outbound.queue.overflows")
					.counter()
					.count()).isEqualTo(1);
			assertThat(meterRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(1);
			assertThat(meterRegistry.get("round.signaling.outbound.queue.bytes")
					.gauge()
					.value()).isBetween(144D * 1024D, 160D * 1024D);
		}
		finally {
			releaseFirstSend.countDown();
			releaseSecondSend.countDown();
		}

		second.awaitFrameCount(2);
		await().atMost(Duration.ofSeconds(2)).until(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0);
	}

	@Test
	void globalOutboundBudgetEvictsEnoughQueuedConsumersBeforeAdmittingAHealthyPeer()
			throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				3,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				64 * 1024,
				120 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		CountDownLatch secondSendEntered = new CountDownLatch(1);
		CountDownLatch releaseSecondSend = new CountDownLatch(1);
		TestPeer first = peer("multi-eviction-first", firstSendEntered, releaseFirstSend);
		TestPeer second = peer("multi-eviction-second", secondSendEntered, releaseSecondSend);
		TestPeer healthy = peer("multi-eviction-healthy");
		connect(first, second, healthy);

		try {
			String queuedDetail = "x".repeat(28 * 1024);
			service.sendInvalidMessage(first.session(), queuedDetail);
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.sendInvalidMessage(first.session(), queuedDetail);
			service.sendInvalidMessage(second.session(), queuedDetail);
			assertThat(secondSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.sendInvalidMessage(second.session(), queuedDetail);

			service.sendInvalidMessage(healthy.session(), "y".repeat(40 * 1024));

			first.awaitClosed();
			second.awaitClosed();
			healthy.awaitTextMessage();
			assertThat(healthy.closeStatus().get()).isNull();
			assertThat(service.connectedPeerCount()).isOne();
			assertThat(meterRegistry.get("round.signaling.outbound.queue.overflows")
					.counter()
					.count()).isEqualTo(2);
			assertThat(meterRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(1);
		}
		finally {
			releaseFirstSend.countDown();
			releaseSecondSend.countDown();
		}

		await().atMost(Duration.ofSeconds(2)).until(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0);
	}

	@Test
	void globalQueuePressureDuringJoinSendsTheSnapshotBeforeTheInducedPeerLeft()
			throws Exception {
		service.stop();
		String fixturePeerId = "p".repeat(36);
		String slowName = "Slow member";
		String newcomerName = "New member";
		int maxPeerQueueBytes = 64 * 1024;
		int slowJoinedBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of()).getPayloadLength();
		int errorOverheadBytes = serverMessageEncoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"",
				ROOM_ID,
				null).getPayloadLength();
		int newcomerJoinedBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of(new Participant(
						fixturePeerId,
						slowName,
						ParticipationGrant.Role.PARTICIPANT))).getPayloadLength();
		int desiredSlowBytes = maxPeerQueueBytes - 64;
		int queuedDetailLength = desiredSlowBytes - slowJoinedBytes - errorOverheadBytes;
		long globalQueueBytes = (long) desiredSlowBytes + newcomerJoinedBytes - 1;
		assertThat(queuedDetailLength).isPositive();
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
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch slowSendEntered = new CountDownLatch(1);
		CountDownLatch releaseSlowSend = new CountDownLatch(1);
		TestPeer slow = peer("join-pressure-slow", slowSendEntered, releaseSlowSend);
		TestPeer newcomer = peer("join-pressure-newcomer");
		connect(slow, newcomer);

		try {
			service.handle(slow.session(), join(slowName));
			assertThat(slowSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.sendInvalidMessage(slow.session(), "x".repeat(queuedDetailLength));
			assertThat(meterRegistry.get("round.signaling.outbound.queue.bytes")
					.gauge()
					.value()).isEqualTo(desiredSlowBytes);

			service.handle(newcomer.session(), join(newcomerName));
			releaseSlowSend.countDown();

			JsonNode joined = newcomer.nextJson();
			JsonNode left = newcomer.nextJson();
			assertThat(joined.get("type").asString()).isEqualTo("room.joined");
			assertThat(joined.at("/payload/participants").size()).isOne();
			assertThat(left.get("type").asString()).isEqualTo("peer.left");
			assertThat(left.at("/payload/peerId").asString())
					.isEqualTo(joined.at("/payload/participants/0/peerId").asString());
			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(newcomer.closeStatus().get()).isNull();
			assertThat(service.participantCount(ROOM_ID)).isOne();
		}
		finally {
			releaseSlowSend.countDown();
		}
	}

	@Test
	void joinAbortsWhenAnInducedDepartureEvictsTheNewcomerAfterSnapshotAdmission()
			throws Exception {
		service.stop();
		String fixturePeerId = "p".repeat(36);
		String victimName = "Victim";
		String observerName = "Observer";
		String newcomerName = "Newcomer";
		Participant victimParticipant = new Participant(
				fixturePeerId,
				victimName,
				ParticipationGrant.Role.PARTICIPANT);
		Participant observerParticipant = new Participant(
				fixturePeerId,
				observerName,
				ParticipationGrant.Role.PARTICIPANT);
		int maxPeerQueueBytes = 64 * 1024;
		int desiredBallastBytes = maxPeerQueueBytes - 64;
		int ballastOverheadBytes = serverMessageEncoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"",
				null,
				null).getPayloadLength();
		int ballastDetailLength = desiredBallastBytes - ballastOverheadBytes;
		int victimJoinedBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of()).getPayloadLength();
		int observerJoinedBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of(victimParticipant)).getPayloadLength();
		int queuedPeerJoinedBytes = serverMessageEncoder.peerJoined(
				ROOM_ID,
				observerParticipant).getPayloadLength();
		int newcomerJoinedBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of(victimParticipant, observerParticipant)).getPayloadLength();
		int leftBytes = serverMessageEncoder.peerLeft(ROOM_ID, fixturePeerId).getPayloadLength();
		long globalQueueBytes = (long) desiredBallastBytes
				+ victimJoinedBytes
				+ newcomerJoinedBytes
				+ leftBytes
				- 1;
		assertThat(ballastDetailLength).isPositive();
		assertThat(queuedPeerJoinedBytes).isGreaterThan(leftBytes);
		assertThat(observerJoinedBytes + queuedPeerJoinedBytes)
				.isLessThanOrEqualTo(newcomerJoinedBytes + leftBytes - 1);

		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				3,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				maxPeerQueueBytes,
				globalQueueBytes);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch ballastSendEntered = new CountDownLatch(1);
		CountDownLatch releaseBallastSend = new CountDownLatch(1);
		CountDownLatch victimSendEntered = new CountDownLatch(1);
		CountDownLatch releaseVictimSend = new CountDownLatch(1);
		TestPeer ballast = peer("join-eviction-ballast", ballastSendEntered, releaseBallastSend);
		TestPeer victim = peer("join-eviction-victim", victimSendEntered, releaseVictimSend);
		TestPeer observer = peer("join-eviction-observer");
		TestPeer newcomer = peer("join-eviction-newcomer");
		connect(ballast, victim, observer, newcomer);

		try {
			service.sendInvalidMessage(ballast.session(), "b".repeat(ballastDetailLength));
			assertThat(ballastSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.handle(victim.session(), join(victimName));
			assertThat(victimSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.handle(observer.session(), join(observerName));
			JsonNode observerJoined = observer.nextJson();
			String victimPeerId = observerJoined.at("/payload/participants/0/peerId").asString();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
							.gauge()
							.value()
							== desiredBallastBytes + victimJoinedBytes + queuedPeerJoinedBytes);

			service.handle(newcomer.session(), join(newcomerName));
			releaseBallastSend.countDown();
			releaseVictimSend.countDown();

			JsonNode victimLeft = observer.nextJson();
			assertThat(victimLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(victimLeft.at("/payload/peerId").asString()).isEqualTo(victimPeerId);
			victim.awaitClosed();
			newcomer.awaitClosed();
			assertThat(victim.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(newcomer.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			observer.assertNoTextMessageFor(Duration.ofMillis(100));
			newcomer.assertNoTextMessageFor(Duration.ofMillis(100));
			assertThat(service.participantCount(ROOM_ID)).isOne();
			assertThat(service.connectedPeerCount()).isEqualTo(2);
			assertThat(meterRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(2);
			await().atMost(Duration.ofSeconds(2)).until(
					() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
							.gauge()
							.value() == 0);
		}
		finally {
			releaseBallastSend.countDown();
			releaseVictimSend.countDown();
		}
	}

	@Test
	void globalQueuePressureDuringLeaveKeepsTheCausalPeerLeftOrder()
			throws Exception {
		service.stop();
		String fixturePeerId = "p".repeat(36);
		String leaverName = "Leaver";
		String victimName = "Slow victim";
		String observerName = "Observer";
		Participant leaverParticipant = new Participant(
				fixturePeerId,
				leaverName,
				ParticipationGrant.Role.PARTICIPANT);
		Participant victimParticipant = new Participant(
				fixturePeerId,
				victimName,
				ParticipationGrant.Role.PARTICIPANT);
		Participant observerParticipant = new Participant(
				fixturePeerId,
				observerName,
				ParticipationGrant.Role.PARTICIPANT);
		int leaverBaseBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of()).getPayloadLength()
				+ serverMessageEncoder.peerJoined(ROOM_ID, victimParticipant).getPayloadLength()
				+ serverMessageEncoder.peerJoined(ROOM_ID, observerParticipant).getPayloadLength();
		int victimBaseBytes = serverMessageEncoder.roomJoined(
				ROOM_ID,
				null,
				fixturePeerId,
				ParticipationGrant.Role.PARTICIPANT,
				List.of(leaverParticipant)).getPayloadLength()
				+ serverMessageEncoder.peerJoined(ROOM_ID, observerParticipant).getPayloadLength();
		int errorOverheadBytes = serverMessageEncoder.error(
				SignalingErrorCode.INVALID_MESSAGE,
				"",
				ROOM_ID,
				null).getPayloadLength();
		int leftBytes = serverMessageEncoder.peerLeft(ROOM_ID, fixturePeerId).getPayloadLength();
		int maxPeerQueueBytes = 64 * 1024;
		long globalQueueBytes = 92L * 1024;
		int desiredLeaverBytes = 32 * 1024;
		int desiredVictimBytes = Math.toIntExact(
				globalQueueBytes - leftBytes + 1 - desiredLeaverBytes);
		int leaverDetailLength = desiredLeaverBytes - leaverBaseBytes - errorOverheadBytes;
		int victimDetailLength = desiredVictimBytes - victimBaseBytes - errorOverheadBytes;
		assertThat(leaverDetailLength).isPositive();
		assertThat(victimDetailLength).isPositive();
		assertThat(desiredVictimBytes + leftBytes).isLessThanOrEqualTo(maxPeerQueueBytes);
		assertThat(desiredVictimBytes).isGreaterThan(desiredLeaverBytes);

		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				3,
				100,
				200,
				400,
				1_000_000,
				2_000_000,
				4_000_000,
				maxPeerQueueBytes,
				globalQueueBytes);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		CountDownLatch leaverSendEntered = new CountDownLatch(1);
		CountDownLatch releaseLeaverSend = new CountDownLatch(1);
		CountDownLatch victimSendEntered = new CountDownLatch(1);
		CountDownLatch releaseVictimSend = new CountDownLatch(1);
		TestPeer leaver = peer("leave-pressure-leaver", leaverSendEntered, releaseLeaverSend);
		TestPeer victim = peer("leave-pressure-victim", victimSendEntered, releaseVictimSend);
		TestPeer observer = peer("leave-pressure-observer");
		connect(leaver, victim, observer);

		try {
			service.handle(leaver.session(), join(leaverName));
			assertThat(leaverSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.handle(victim.session(), join(victimName));
			assertThat(victimSendEntered.await(1, TimeUnit.SECONDS)).isTrue();
			service.handle(observer.session(), join(observerName));
			JsonNode observerJoined = observer.nextJson();
			String leaverPeerId = observerJoined.at("/payload/participants/0/peerId").asString();
			String victimPeerId = observerJoined.at("/payload/participants/1/peerId").asString();
			service.sendInvalidMessage(leaver.session(), "x".repeat(leaverDetailLength));
			service.sendInvalidMessage(victim.session(), "y".repeat(victimDetailLength));
			await().atMost(Duration.ofSeconds(2)).until(
					() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
							.gauge()
							.value() == desiredLeaverBytes + desiredVictimBytes);

			service.handle(leaver.session(), new ClientMessage.Leave(ROOM_ID, null));
			releaseLeaverSend.countDown();
			releaseVictimSend.countDown();

			JsonNode leaverLeft = observer.nextJson();
			JsonNode victimLeft = observer.nextJson();
			assertThat(leaverLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(leaverLeft.at("/payload/peerId").asString()).isEqualTo(leaverPeerId);
			assertThat(victimLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(victimLeft.at("/payload/peerId").asString()).isEqualTo(victimPeerId);
			victim.awaitClosed();
			assertThat(victim.closeStatus().get())
					.isEqualTo(new CloseStatus(1011, "Outbound queue overflow"));
			assertThat(leaver.closeStatus().get()).isNull();
			assertThat(service.participantCount(ROOM_ID)).isOne();
			assertThat(meterRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(1);
			assertThat(meterRegistry.get("round.signaling.outbound.queue.bytes")
					.gauge()
					.value()).isLessThanOrEqualTo(globalQueueBytes);
		}
		finally {
			releaseLeaverSend.countDown();
			releaseVictimSend.countDown();
		}
	}

	@Test
	void lifecycleStartsStopsAndRestartsWithoutOwningTheExecutor() throws Exception {
		service.stop();
		service = newService(properties(6), new SimpleMeterRegistry());
		assertThat(service.isRunning()).isFalse();
		assertThat(service.isAcceptingConnections()).isFalse();

		TestPeer beforeStart = peer("before-start");
		attachDefaultReservation(beforeStart);
		assertThat(service.connect(beforeStart.session())).isFalse();
		beforeStart.awaitClosed();
		assertThat(beforeStart.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));

		service.start();
		assertThat(service.isRunning()).isTrue();
		assertThat(service.isAcceptingConnections()).isTrue();
		TestPeer connected = peer("connected-before-stop");
		connect(connected);
		service.handle(connected.session(), join("Ada"));
		connected.nextJson();

		AtomicBoolean stopCallback = new AtomicBoolean();
		service.stop(() -> stopCallback.set(true));
		assertThat(stopCallback).isTrue();
		service.stop();

		connected.awaitClosed();
		assertThat(connected.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		assertThat(service.isRunning()).isFalse();
		assertThat(service.isAcceptingConnections()).isFalse();
		assertThat(service.connectedPeerCount()).isZero();
		assertThat(service.roomCount()).isZero();
		assertThat(outboundExecutor.isShutdown()).isFalse();

		service.start();
		TestPeer restarted = peer("after-restart");
		connect(restarted);
		assertThat(service.isRunning()).isTrue();
		assertThat(service.isAcceptingConnections()).isTrue();

		service.stop();
		restarted.awaitClosed();
		assertThat(restarted.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		assertThat(outboundExecutor.isShutdown()).isFalse();
	}

	@Test
	void stopKeepsGoingAwayStatusWhenAnOutboundWriteIsInFlight() throws Exception {
		CountDownLatch sendEntered = new CountDownLatch(1);
		CountDownLatch releaseSend = new CountDownLatch(1);
		TestPeer slow = peer("stop-in-flight", sendEntered, releaseSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(sendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.stop();

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		}
		finally {
			releaseSend.countDown();
		}
	}

	@Test
	void closesAllSessionsConcurrentlyWithinTheShutdownBudget() throws Exception {
		int peerCount = 24;
		CountDownLatch closeEntered = new CountDownLatch(peerCount);
		CountDownLatch releaseClose = new CountDownLatch(1);
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < peerCount; index++) {
			TestPeer peer = peer("parallel-close-" + index);
			doAnswer(invocation -> {
				closeEntered.countDown();
				if (!releaseClose.await(2, TimeUnit.SECONDS)) {
					throw new java.io.IOException("Timed out waiting to release close");
				}
				peer.closeStatus().set(invocation.getArgument(0));
				return null;
			}).when(peer.session()).close(any(CloseStatus.class));
			peers.add(peer);
			connect(peer);
		}

		CompletableFuture<Void> stopped = CompletableFuture.runAsync(service::stop);
		try {
			assertThat(closeEntered.await(1, TimeUnit.SECONDS)).isTrue();
		}
		finally {
			releaseClose.countDown();
		}
		stopped.get(2, TimeUnit.SECONDS);

		assertThat(peers)
				.allSatisfy(peer -> assertThat(peer.closeStatus().get())
						.isEqualTo(new CloseStatus(1001, "Server shutting down")));
	}

	@Test
	void shutdownDeadlineIncludesCloseTasksThatIgnoreInterrupts() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithShutdownCloseTimeout(Duration.ofMillis(100));
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		int peerCount = 4;
		CountDownLatch closeEntered = new CountDownLatch(peerCount);
		CountDownLatch releaseClose = new CountDownLatch(1);
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < peerCount; index++) {
			TestPeer peer = peer("interrupt-ignoring-close-" + index);
			doAnswer(invocation -> {
				closeEntered.countDown();
				boolean released = false;
				while (!released) {
					try {
						releaseClose.await();
						released = true;
					}
					catch (InterruptedException ignored) {
						// 인터럽트를 무시하는 전송 계층 close 구현을 모사한다.
					}
				}
				peer.closeStatus().set(invocation.getArgument(0));
				return null;
			}).when(peer.session()).close(any(CloseStatus.class));
			peers.add(peer);
			connect(peer);
		}

		long startedAtNanos = System.nanoTime();
		try {
			service.stop();
			long elapsedMillis =
					TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);

			assertThat(closeEntered.getCount()).isZero();
			assertThat(elapsedMillis).isLessThan(1_000);
			assertThat(service.isRunning()).isFalse();
		}
		finally {
			releaseClose.countDown();
		}

		await().atMost(Duration.ofSeconds(2)).until(
				() -> peers.stream().allMatch(peer -> peer.closeStatus().get() != null));
	}

	@Test
	void sharesOneShutdownDeadlineAcrossConnectedAndSupersededSessions()
			throws Exception {
		SignalingProperties shutdownProperties =
				TestProperties.signalingWithShutdownCloseTimeout(Duration.ofMillis(300));
		SignalingService batonService =
				newBatonService(shutdownProperties, new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(shutdownProperties);
		ParticipationGrant originalGrant = grantFor(
				ROOM_ID,
				"shutdown-racing-user",
				"shutdown-racing-token-original",
				clock.instant().plusSeconds(120));
		CountDownLatch originalCloseEntered = new CountDownLatch(1);
		CountDownLatch replacementCloseEntered = new CountDownLatch(1);
		CountDownLatch releaseCloses = new CountDownLatch(1);
		batonService.start();
		try {
			TestPeer original = peer("shutdown-racing-session-original");
			attachGrantReservation(
					original,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.160", 41_160),
					originalGrant);
			assertThat(batonService.connect(original.session())).isTrue();
			batonService.handle(original.session(), join("Original"));
			original.nextJson();

			doAnswer(invocation -> {
				originalCloseEntered.countDown();
				awaitIgnoringInterrupts(releaseCloses);
				original.closeStatus().set(invocation.getArgument(0));
				return null;
			}).when(original.session()).close(any(CloseStatus.class));

			clock.advanceMillis(1);
			ParticipationGrant freshGrant = grantFor(
					ROOM_ID,
					originalGrant.subject(),
					"shutdown-racing-token-fresh",
					clock.instant().plusSeconds(120));
			TestPeer replacement = peer("shutdown-racing-session-replacement");
			attachGrantReservation(
					replacement,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.161", 41_161),
					freshGrant);
			assertThat(batonService.connect(replacement.session())).isTrue();
			batonService.handle(replacement.session(), join("Replacement"));
			assertThat(originalCloseEntered.await(2, TimeUnit.SECONDS)).isTrue();
			replacement.nextJson();

			doAnswer(invocation -> {
				replacementCloseEntered.countDown();
				awaitIgnoringInterrupts(releaseCloses);
				replacement.closeStatus().set(invocation.getArgument(0));
				return null;
			}).when(replacement.session()).close(any(CloseStatus.class));

			long startedAtNanos = System.nanoTime();
			batonService.stop();
			long elapsedMillis =
					TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);

			assertThat(replacementCloseEntered.getCount()).isZero();
			assertThat(elapsedMillis).isLessThan(500);
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					originalGrant.tokenId())).isOne();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					freshGrant.tokenId())).isZero();
		}
		finally {
			releaseCloses.countDown();
			await().atMost(Duration.ofSeconds(2)).until(
					() -> batonAdmissionPolicy.activeReservationCount() == 0);
			batonService.stop();
		}
	}

	@Test
	void executesOutboundWorkInlineWhenTheDedicatedExecutorRejectsIt() throws Exception {
		try (ExecutorService rejectingExecutor = Executors.newVirtualThreadPerTaskExecutor()) {
			SignalingService fallbackService = new SignalingService(
					serverMessageEncoder,
					properties(1),
					new SignalingMetrics(new SimpleMeterRegistry()),
					new RoomAccessPolicy(standaloneAuth()),
					rejectingExecutor,
					clock,
					monotonicTicker);
			fallbackService.start();
			TestPeer peer = peer("rejected-executor-fallback");
			attachDefaultReservation(peer);
			assertThat(fallbackService.connect(peer.session())).isTrue();
			rejectingExecutor.shutdownNow();

			fallbackService.handle(peer.session(), join("Fallback"));

			assertThat(peer.nextJson().get("type").asString()).isEqualTo("room.joined");
			fallbackService.stop();
		}
	}

	@Test
	void expiresOnlySocketsThatRemainUnjoinedPastTheConfiguredDeadline() throws Exception {
		TestPeer idle = peer("idle-unjoined");
		TestPeer joined = peer("joined");
		connect(idle, joined);
		service.handle(joined.session(), join("Grace"));
		joined.nextJson();

		monotonicTicker.advanceMillis(14_999);
		service.expireUnjoinedSessions();
		assertThat(idle.closeStatus().get()).isNull();
		assertThat(joined.closeStatus().get()).isNull();

		monotonicTicker.advanceMillis(1);
		service.expireUnjoinedSessions();
		idle.awaitClosed();
		assertThat(idle.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Room join timeout"));
		assertThat(joined.closeStatus().get()).isNull();
		assertThat(service.participantCount(ROOM_ID)).isOne();
	}

}

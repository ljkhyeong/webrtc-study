package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TestProperties;
import com.personal.round.protocol.ProtocolParser;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.PongMessage;

class SignalingServiceInboundQuotaHeartbeatTest extends SignalingServiceTestSupport {

	@Test
	void heartbeatClosesAnUnresponsivePeerAndReleasesItsSlotOnce() throws Exception {
		TestPeer responsive = peer("responsive");
		TestPeer sleeping = peer("sleeping");
		connect(responsive, sleeping);
		service.handle(responsive.session(), join("Responsive"));
		responsive.nextJson();
		service.handle(sleeping.session(), join("Sleeping laptop"));
		String sleepingPeerId = sleeping.nextJson().at("/payload/peerId").asString();
		responsive.nextJson();

		service.heartbeatSweep();
		PingMessage responsivePing = responsive.awaitPing();
		sleeping.awaitMessage(PingMessage.class::isInstance);
		service.markAlive(responsive.session(), payloadBytes(responsivePing));
		monotonicTicker.advanceMillis(properties(6).heartbeatInterval().toMillis());
		service.heartbeatSweep();

		sleeping.awaitClosed();
		assertThat(sleeping.closeStatus().get())
				.isEqualTo(new CloseStatus(4000, "Heartbeat timeout"));
		assertThat(responsive.nextJson().at("/payload/peerId").asString())
				.isEqualTo(sleepingPeerId);
		assertThat(service.participantCount(ROOM_ID)).isOne();
		assertThat(meterRegistry.get("round.signaling.heartbeat.closes").counter().count())
				.isEqualTo(1);

		service.disconnect(sleeping.session());
		assertThat(service.participantCount(ROOM_ID)).isOne();
	}

	@Test
	void heartbeatDeadlineIgnoresWallClockJumpsAndUsesMonotonicElapsedTime()
			throws Exception {
		TestPeer peer = peer("heartbeat-wall-clock-jump");
		connect(peer);
		service.heartbeatSweep();
		peer.awaitPing();

		clock.advanceMillis(Duration.ofDays(365).toMillis());
		service.heartbeatSweep();
		assertThat(peer.closeStatus().get()).isNull();

		clock.advanceMillis(-2 * Duration.ofDays(365).toMillis());
		monotonicTicker.advanceMillis(properties(6).heartbeatInterval().toMillis());
		service.heartbeatSweep();

		peer.awaitClosed();
		assertThat(peer.closeStatus().get())
				.isEqualTo(new CloseStatus(4000, "Heartbeat timeout"));
	}


	@Test
	void unjoinedDeadlineIgnoresWallClockJumpsAndUsesMonotonicElapsedTime()
			throws Exception {
		TestPeer idle = peer("unjoined-wall-clock-jump");
		connect(idle);

		clock.advanceMillis(Duration.ofDays(365).toMillis());
		service.expireUnjoinedSessions();
		assertThat(idle.closeStatus().get()).isNull();

		clock.advanceMillis(-2 * Duration.ofDays(365).toMillis());
		monotonicTicker.advanceMillis(properties(6).unjoinedTimeout().toMillis());
		service.expireUnjoinedSessions();

		idle.awaitClosed();
		assertThat(idle.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Room join timeout"));
	}

	@Test
	void allowsSixPeerIceBurstButClosesAConnectionThatExceedsItsWindow() throws Exception {
		ConnectionAdmissionPolicy policy = admissionPolicy(properties(6));
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < 6; index++) {
			TestPeer peer = peer("burst-" + index);
			peers.add(peer);
			connectFrom(policy, "192.0.2." + (index + 1), peer);
		}

		for (TestPeer peer : peers) {
			for (int frame = 0; frame < 200; frame++) {
				assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
			}
		}
		TestPeer offender = peers.getFirst();
		for (int frame = 200; frame < 600; frame++) {
			assertThat(service.acceptInboundFrame(offender.session(), 0)).isTrue();
		}

		assertThat(service.acceptInboundFrame(offender.session(), 0)).isFalse();
		offender.awaitClosed();
		assertThat(offender.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isZero();
		assertThat(service.connectedPeerCount()).isEqualTo(5);
	}

	@Test
	void forwardWallClockMovementDoesNotResetAnInboundQuotaWindow() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(1, 1, 2, 4);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer peer = peer("clock-forward");
		connect(peer);

		assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
		clock.advanceMillis(Duration.ofDays(365).toMillis());
		assertThat(service.acceptInboundFrame(peer.session(), 0)).isFalse();

		peer.awaitClosed();
		assertThat(peer.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
	}

	@Test
	void monotonicElapsedWindowResetsAfterTheWallClockRollsBack() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(1, 1, 2, 4);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer peer = peer("clock-rollback");
		connect(peer);

		assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
		clock.advanceMillis(-Duration.ofDays(365).toMillis());
		monotonicTicker.advanceMillis(properties.abuseWindow().toMillis());

		assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
		assertThat(peer.closeStatus().get()).isNull();
	}

	@Test
	void dropsAnExhaustedClientWithoutClosingItsSessionsOrSpendingAnotherClientQuota()
			throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(6, 4, 6, 20);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("client-first");
		TestPeer second = peer("client-second");
		TestPeer otherClient = peer("client-other");
		connectFrom(policy, "192.0.2.10", first, second);
		connectFrom(policy, "192.0.2.11", otherClient);

		for (int frame = 0; frame < 3; frame++) {
			assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();
			assertThat(service.acceptInboundFrame(second.session(), 0)).isTrue();
		}

		assertThat(service.acceptInboundFrame(first.session(), 0)).isFalse();
		assertThat(first.closeStatus().get()).isNull();
		assertThat(second.closeStatus().get()).isNull();
		assertThat(service.acceptInboundFrame(otherClient.session(), 0)).isTrue();
		assertThat(meterRegistry.get("round.signaling.frames.client_rate_limited")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isZero();
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isZero();

		assertThat(service.acceptInboundFrame(first.session(), 0)).isFalse();
		first.awaitClosed();
		assertThat(first.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
		assertThat(second.closeStatus().get()).isNull();
		assertThat(otherClient.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void rejectedSessionAndClientFramesDoNotConsumeGlobalQuota() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(6, 2, 2, 4);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer exhaustedSession = peer("quota-session");
		TestPeer exhaustedClient = peer("quota-client");
		TestPeer otherClient = peer("quota-other-client");
		connectFrom(policy, "192.0.2.40", exhaustedSession, exhaustedClient);
		connectFrom(policy, "192.0.2.41", otherClient);

		assertThat(service.acceptInboundFrame(exhaustedSession.session(), 0)).isTrue();
		assertThat(service.acceptInboundFrame(exhaustedSession.session(), 0)).isTrue();

		assertThat(service.acceptInboundFrame(exhaustedSession.session(), 0)).isFalse();
		exhaustedSession.awaitClosed();
		assertThat(service.acceptInboundFrame(exhaustedClient.session(), 0)).isFalse();

		assertThat(service.acceptInboundFrame(otherClient.session(), 0)).isTrue();
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isZero();
	}

	@Test
	void preservesClientQuotaAcrossDisconnectAndReconnectWithinTheWindow() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(6, 2, 2, 6);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("reconnect-first");
		connectFrom(policy, "192.0.2.20", first);
		assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();
		assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();

		service.disconnect(first.session());
		assertThat(service.trackedInboundClientCount()).isOne();

		TestPeer reconnected = peer("reconnect-second");
		connectFrom(policy, "192.0.2.20", reconnected);

		assertThat(service.acceptInboundFrame(reconnected.session(), 0)).isFalse();
		assertThat(reconnected.closeStatus().get()).isNull();
		assertThat(service.connectedPeerCount()).isOne();
		assertThat(meterRegistry.get("round.signaling.frames.client_rate_limited")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void removesExpiredInactiveClientWindowsOnConnectAndPeriodicSweep() throws Exception {
		SignalingProperties properties = properties(6);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("expired-on-connect");
		connectFrom(policy, "192.0.2.21", first);
		assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();
		service.disconnect(first.session());
		assertThat(service.trackedInboundClientCount()).isOne();

		monotonicTicker.advanceMillis(properties.abuseWindow().toMillis());
		TestPeer second = peer("expired-on-sweep");
		connectFrom(policy, "192.0.2.22", second);
		assertThat(service.trackedInboundClientCount()).isOne();
		assertThat(service.acceptInboundFrame(second.session(), 0)).isTrue();
		service.disconnect(second.session());

		monotonicTicker.advanceMillis(properties.abuseWindow().toMillis() - 1);
		service.expireUnjoinedSessions();
		assertThat(service.trackedInboundClientCount()).isOne();

		monotonicTicker.advanceMillis(1);
		service.expireUnjoinedSessions();
		assertThat(service.trackedInboundClientCount()).isZero();
	}

	@Test
	void inactiveClientCleanupIgnoresWallClockJumpsAndUsesMonotonicElapsedTime()
			throws Exception {
		SignalingProperties properties = properties(6);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("cleanup-wall-clock-first");
		connectFrom(policy, "192.0.2.81", first);
		assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();
		service.disconnect(first.session());

		clock.advanceMillis(Duration.ofDays(365).toMillis());
		TestPeer second = peer("cleanup-wall-clock-second");
		connectFrom(policy, "192.0.2.82", second);
		assertThat(service.trackedInboundClientCount()).isEqualTo(2);
		assertThat(service.acceptInboundFrame(second.session(), 0)).isTrue();
		service.disconnect(second.session());

		clock.advanceMillis(-2 * Duration.ofDays(365).toMillis());
		monotonicTicker.advanceMillis(properties.abuseWindow().toMillis());
		service.expireUnjoinedSessions();

		assertThat(service.trackedInboundClientCount()).isZero();
	}

	@Test
	void boundsClientWindowsByEvictingOnlyInactiveState() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithConnectionAndFrameLimits(
						1, 2, 2, 2, 2, 6);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer active = peer("bounded-active");
		TestPeer inactive = peer("bounded-inactive");
		connectFrom(policy, "192.0.2.23", active);
		connectFrom(policy, "192.0.2.24", inactive);
		assertThat(service.acceptInboundFrame(active.session(), 0)).isTrue();
		assertThat(service.acceptInboundFrame(inactive.session(), 0)).isTrue();
		service.disconnect(inactive.session());
		assertThat(service.trackedInboundClientCount()).isEqualTo(2);

		TestPeer replacement = peer("bounded-replacement");
		connectFrom(policy, "192.0.2.25", replacement);

		assertThat(service.trackedInboundClientCount()).isEqualTo(2);
		service.disconnect(active.session());
		assertThat(service.trackedInboundClientCount()).isEqualTo(2);

		TestPeer reconnectedActive = peer("bounded-active-reconnected");
		connectFrom(policy, "192.0.2.23", reconnectedActive);
		assertThat(service.acceptInboundFrame(reconnectedActive.session(), 0)).isTrue();
		assertThat(service.acceptInboundFrame(reconnectedActive.session(), 0)).isFalse();
	}

	@Test
	void stopClearsRetainedInactiveClientWindows() throws Exception {
		ConnectionAdmissionPolicy policy = admissionPolicy(properties(6));
		TestPeer peer = peer("retained-until-stop");
		connectFrom(policy, "192.0.2.26", peer);
		assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
		service.disconnect(peer.session());
		assertThat(service.trackedInboundClientCount()).isOne();

		service.stop();

		assertThat(service.trackedInboundClientCount()).isZero();
	}

	@Test
	void dropsGlobalOverloadWithoutClosingAnArbitrarySession() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(6, 10, 10, 20);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("global-first");
		TestPeer second = peer("global-second");
		TestPeer third = peer("global-third");
		connectFrom(policy, "192.0.2.30", first);
		connectFrom(policy, "192.0.2.31", second);
		connectFrom(policy, "192.0.2.32", third);

		for (int frame = 0; frame < 7; frame++) {
			assertThat(service.acceptInboundFrame(first.session(), 0)).isTrue();
			assertThat(service.acceptInboundFrame(second.session(), 0)).isTrue();
		}
		for (int frame = 0; frame < 6; frame++) {
			assertThat(service.acceptInboundFrame(third.session(), 0)).isTrue();
		}

		assertThat(service.acceptInboundFrame(third.session(), 0)).isFalse();
		assertThat(first.closeStatus().get()).isNull();
		assertThat(second.closeStatus().get()).isNull();
		assertThat(third.closeStatus().get()).isNull();
		assertThat(service.connectedPeerCount()).isEqualTo(3);
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isZero();
		assertThat(meterRegistry.get("round.signaling.frames.client_rate_limited")
				.counter()
				.count()).isZero();
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isEqualTo(1);
		monotonicTicker.advanceMillis(properties.abuseWindow().toMillis());
		assertThat(service.acceptInboundFrame(third.session(), 0)).isTrue();
	}

	@Test
	void closesOnlyTheSessionThatExhaustsItsInboundByteBudget() throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				2,
				100,
				200,
				400,
				10,
				100,
				200,
				64 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer offender = peer("session-byte-offender");
		TestPeer healthy = peer("session-byte-healthy");
		connect(offender, healthy);

		assertThat(service.acceptInboundFrame(offender.session(), 6)).isTrue();
		assertThat(service.acceptInboundFrame(offender.session(), 5)).isFalse();

		offender.awaitClosed();
		assertThat(offender.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
		assertThat(healthy.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.frames.byte_limited")
				.tag("scope", "session")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isZero();
	}

	@Test
	void sharesInboundByteBudgetAcrossConnectionsFromOneClient() throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				2,
				100,
				200,
				400,
				10,
				10,
				100,
				64 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("client-byte-first");
		TestPeer second = peer("client-byte-second");
		connectFrom(policy, "192.0.2.60", first, second);

		assertThat(service.acceptInboundFrame(first.session(), 6)).isTrue();
		assertThat(service.acceptInboundFrame(second.session(), 5)).isFalse();

		assertThat(first.closeStatus().get()).isNull();
		assertThat(second.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.frames.byte_limited")
				.tag("scope", "client")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void globalInboundByteBudgetDropsLoadWithoutClosingAnArbitraryPeer() throws Exception {
		service.stop();
		SignalingProperties properties = TestProperties.signalingWithFrameAndByteLimits(
				3,
				100,
				200,
				400,
				100,
				100,
				200,
				64 * 1024);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer first = peer("global-byte-first");
		TestPeer second = peer("global-byte-second");
		TestPeer third = peer("global-byte-third");
		connectFrom(policy, "192.0.2.61", first);
		connectFrom(policy, "192.0.2.62", second);
		connectFrom(policy, "192.0.2.63", third);

		assertThat(service.acceptInboundFrame(first.session(), 80)).isTrue();
		assertThat(service.acceptInboundFrame(second.session(), 80)).isTrue();
		assertThat(service.acceptInboundFrame(third.session(), 50)).isFalse();

		assertThat(first.closeStatus().get()).isNull();
		assertThat(second.closeStatus().get()).isNull();
		assertThat(third.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.frames.byte_limited")
				.tag("scope", "global")
				.counter()
				.count()).isEqualTo(1);
	}

	@Test
	void globalOverloadDoesNotTurnAValidPongIntoAHeartbeatTimeout() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(3, 1, 1, 2);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		SignalingWebSocketHandler handler = new SignalingWebSocketHandler(
				new ProtocolParser(objectMapper),
				service);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer firstLoad = peer("pong-global-load-first");
		TestPeer secondLoad = peer("pong-global-load-second");
		TestPeer responsive = peer("pong-global-responsive");
		connectFrom(policy, "192.0.2.40", firstLoad);
		connectFrom(policy, "192.0.2.41", secondLoad);
		connectFrom(policy, "192.0.2.42", responsive);
		assertThat(service.acceptInboundFrame(firstLoad.session(), 0)).isTrue();
		assertThat(service.acceptInboundFrame(secondLoad.session(), 0)).isTrue();
		service.disconnect(firstLoad.session());
		service.disconnect(secondLoad.session());

		service.heartbeatSweep();
		PingMessage responsivePing = responsive.awaitPing();
		handler.handleMessage(
				responsive.session(),
				new PongMessage(responsivePing.getPayload().asReadOnlyBuffer()));
		monotonicTicker.advanceMillis(properties(6).heartbeatInterval().toMillis());
		service.heartbeatSweep();

		responsive.awaitFrameCount(2);
		assertThat(responsive.closeStatus().get()).isNull();
		assertThat(service.connectedPeerCount()).isOne();
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.heartbeat.closes")
				.counter()
				.count()).isZero();
	}

	@Test
	void forgedPongCannotResetAQueuedHeartbeatDeadline() throws Exception {
		CountDownLatch firstSendEntered = new CountDownLatch(1);
		CountDownLatch releaseFirstSend = new CountDownLatch(1);
		TestPeer slow = peer("heartbeat-forged-pong", firstSendEntered, releaseFirstSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(firstSendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.heartbeatSweep();
			service.markAlive(
					slow.session(),
					"forged-heartbeat-response".getBytes(java.nio.charset.StandardCharsets.UTF_8));
			monotonicTicker.advanceMillis(properties(6).heartbeatInterval().toMillis());
			service.heartbeatSweep();

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(4000, "Heartbeat timeout"));
		}
		finally {
			releaseFirstSend.countDown();
		}
	}

	@Test
	void pongStillDisconnectsTheSessionThatExceedsItsOwnFrameWindow() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(1, 1, 1, 2);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		SignalingWebSocketHandler handler = new SignalingWebSocketHandler(
				new ProtocolParser(objectMapper),
				service);
		TestPeer offender = peer("pong-session-offender");
		connect(offender);

		handler.handleMessage(offender.session(), new PongMessage());
		handler.handleMessage(offender.session(), new PongMessage());

		offender.awaitClosed();
		assertThat(offender.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
		assertThat(service.connectedPeerCount()).isZero();
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isZero();
	}

}

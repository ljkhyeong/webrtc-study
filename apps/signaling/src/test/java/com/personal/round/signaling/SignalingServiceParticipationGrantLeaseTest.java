package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.protocol.ClientMessage;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.JsonNode;

class SignalingServiceParticipationGrantLeaseTest extends SignalingServiceTestSupport {

	@Test
	void keepsTheParticipantReservationUntilSocketDisconnectAfterRoomLeave()
			throws Exception {
		SignalingService batonService = newBatonService(new SimpleMeterRegistry());
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant grant = grantFor(ROOM_ID);
		batonService.start();
		try {
			TestPeer peer = peer("baton-leave-reservation");
			attachReservation(
					peer,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.40", 41_000),
							grant)));
			peer.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					grant);

			assertThat(batonService.connect(peer.session())).isTrue();
			batonService.handle(peer.session(), join("Ada"));
			peer.nextJson();

			batonService.handle(
					peer.session(),
					new ClientMessage.Leave(ROOM_ID, null));

			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					grant.tokenId())).isOne();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					grant)).isOne();

			batonService.disconnect(peer.session());

			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					grant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					grant)).isZero();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void failsClosedWhenBatonHandshakeMetadataDoesNotReachTheSession() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		batonService.start();
		try {
			TestPeer peer = peer("baton-missing-room-access");
			attachDefaultReservation(peer);

			assertThat(batonService.connect(peer.session())).isFalse();

			peer.awaitClosed();
			assertThat(peer.closeStatus().get())
					.isEqualTo(new CloseStatus(1008, "Room authorization required"));
			assertThat(batonService.connectedPeerCount()).isZero();
			assertThat(batonRegistry.get("round.signaling.connections.rejected")
					.tag("reason", "missing_room_access")
					.counter()
					.count())
					.isOne();
		}
		finally {
			batonService.stop();
		}
	}

	@Test
	void acceptsOneMillisecondBeforeExpirationAndRejectsAtExpiration()
			throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant stillValid = grantFor(
				ROOM_ID,
				"boundary-valid-user",
				"boundary-valid-token",
				clock.instant().plusMillis(1));
		ParticipationGrant expired = grantFor(
				ROOM_ID,
				"boundary-expired-user",
				"boundary-expired-token",
				clock.instant());
		batonService.start();
		try {
			TestPeer accepted = peer("grant-exp-minus-one");
			attachReservation(
					accepted,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.61", 41_000),
							stillValid)));
			accepted.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					stillValid);

			TestPeer rejected = peer("grant-at-exp");
			attachReservation(
					rejected,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.62", 41_001),
							expired)));
			rejected.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					expired);

			assertThat(batonService.connect(accepted.session())).isTrue();
			assertThat(batonService.connect(rejected.session())).isFalse();

			rejected.awaitClosed();
			assertThat(rejected.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					stillValid.tokenId())).isOne();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					expired.tokenId())).isZero();
			var authorizationCloses = batonRegistry
					.get("round.signaling.authorization.closes")
					.counter();
			assertThat(authorizationCloses.count()).isOne();
			assertThat(authorizationCloses.getId().getTags()).isEmpty();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void rechecksExpirationAfterInboundAdmissionBeforeHandlingTheMessage()
			throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		batonService.start();
		try {
			ParticipationGrant inboundGrant = grantFor(
					ROOM_ID,
					"inbound-expired-user",
					"inbound-expired-token",
					clock.instant().plusMillis(1));
			TestPeer inbound = peer("expired-at-inbound");
			attachReservation(
					inbound,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.63", 41_002),
							inboundGrant)));
			inbound.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					inboundGrant);
			assertThat(batonService.connect(inbound.session())).isTrue();

			clock.advanceMillis(1);

			assertThat(batonService.acceptInboundFrame(inbound.session(), 0)).isFalse();
			inbound.awaitClosed();
			assertThat(inbound.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));

			ParticipationGrant handleGrant = grantFor(
					ROOM_ID,
					"handle-expired-user",
					"handle-expired-token",
					clock.instant().plusMillis(1));
			TestPeer handleRace = peer("expired-between-inbound-and-handle");
			attachReservation(
					handleRace,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.64", 41_003),
							handleGrant)));
			handleRace.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					handleGrant);
			assertThat(batonService.connect(handleRace.session())).isTrue();
			assertThat(batonService.acceptInboundFrame(handleRace.session(), 0)).isTrue();

			clock.advanceMillis(1);
			batonService.handle(handleRace.session(), join("Ada"));

			handleRace.awaitClosed();
			assertThat(handleRace.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(batonService.roomCount()).isZero();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isEqualTo(2);
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void idleSweepExpiresJoinedUnjoinedAndLeftSocketsExactlyOnce()
			throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant observerGrant = grantFor(
				ROOM_ID,
				"observer-user",
				"observer-token",
				clock.instant().plusSeconds(120));
		ParticipationGrant joinedGrant = grantFor(
				ROOM_ID,
				"joined-expired-user",
				"joined-expired-token",
				clock.instant().plusMillis(1));
		ParticipationGrant unjoinedGrant = grantFor(
				ROOM_ID,
				"unjoined-expired-user",
				"unjoined-expired-token",
				clock.instant().plusMillis(1));
		ParticipationGrant leftGrant = grantFor(
				ROOM_ID,
				"left-expired-user",
				"left-expired-token",
				clock.instant().plusMillis(1));
		batonService.start();
		try {
			TestPeer observer = peer("grant-observer");
			TestPeer joined = peer("grant-joined");
			TestPeer unjoined = peer("grant-unjoined");
			TestPeer left = peer("grant-left");
			attachGrantReservation(
					observer,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.65", 41_004),
					observerGrant);
			attachGrantReservation(
					joined,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.66", 41_005),
					joinedGrant);
			attachGrantReservation(
					unjoined,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.67", 41_006),
					unjoinedGrant);
			attachGrantReservation(
					left,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.68", 41_007),
					leftGrant);
			assertThat(batonService.connect(observer.session())).isTrue();
			assertThat(batonService.connect(joined.session())).isTrue();
			assertThat(batonService.connect(unjoined.session())).isTrue();
			assertThat(batonService.connect(left.session())).isTrue();

			batonService.handle(observer.session(), join("Observer"));
			observer.nextJson();
			batonService.handle(joined.session(), join("Joined"));
			String joinedPeerId = joined.nextJson().at("/payload/peerId").asString();
			assertThat(observer.nextJson().at("/payload/participant/peerId").asString())
					.isEqualTo(joinedPeerId);
			batonService.handle(left.session(), join("Left"));
			String leftPeerId = left.nextJson().at("/payload/peerId").asString();
			assertThat(observer.nextJson().at("/payload/participant/peerId").asString())
					.isEqualTo(leftPeerId);
			joined.nextJson();
			batonService.handle(left.session(), new ClientMessage.Leave(ROOM_ID, null));
			assertThat(observer.nextJson().at("/payload/peerId").asString())
					.isEqualTo(leftPeerId);
			joined.nextJson();

			clock.advanceMillis(1);
			batonService.expireUnjoinedSessions();

			joined.awaitClosed();
			unjoined.awaitClosed();
			left.awaitClosed();
			assertThat(joined.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(unjoined.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(left.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(observer.nextJson().at("/payload/peerId").asString())
					.isEqualTo(joinedPeerId);
			observer.assertNoTextMessageFor(Duration.ofMillis(100));
			assertThat(batonService.participantCount(ROOM_ID)).isOne();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					joinedGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					unjoinedGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					leftGrant.tokenId())).isZero();
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					observerGrant.tokenId())).isOne();

			batonService.expireUnjoinedSessions();
			batonService.disconnect(joined.session());
			batonService.disconnect(unjoined.session());
			batonService.disconnect(left.session());

			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isEqualTo(3);
			observer.assertNoTextMessageFor(Duration.ofMillis(100));
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void expiresAnOutboundTargetBeforeEnqueueingTheRelay() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant senderGrant = grantFor(
				ROOM_ID,
				"sender-user",
				"sender-token",
				clock.instant().plusSeconds(120));
		ParticipationGrant targetGrant = grantFor(
				ROOM_ID,
				"target-user",
				"target-token",
				clock.instant().plusMillis(1));
		batonService.start();
		try {
			TestPeer sender = peer("grant-sender");
			TestPeer target = peer("grant-target");
			attachReservation(
					sender,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.69", 41_008),
							senderGrant)));
			sender.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					senderGrant);
			attachReservation(
					target,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.70", 41_009),
							targetGrant)));
			target.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					targetGrant);
			assertThat(batonService.connect(sender.session())).isTrue();
			assertThat(batonService.connect(target.session())).isTrue();
			batonService.handle(sender.session(), join("Sender"));
			sender.nextJson();
			batonService.handle(target.session(), join("Target"));
			String targetPeerId = target.nextJson().at("/payload/peerId").asString();
			sender.nextJson();

			clock.advanceMillis(1);
			batonService.handle(
					sender.session(),
					relay("rtc.offer", ROOM_ID, targetPeerId));

			target.awaitClosed();
			assertThat(target.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			JsonNode peerLeft = sender.nextJson();
			assertThat(peerLeft.get("type").asString()).isEqualTo("peer.left");
			assertThat(peerLeft.at("/payload/peerId").asString()).isEqualTo(targetPeerId);
			target.assertNoTextMessageFor(Duration.ofMillis(100));
			assertThat(batonAdmissionPolicy.activeParticipationTokenReservationCount(
					targetGrant.tokenId())).isZero();

			batonService.handle(
					sender.session(),
					relay("rtc.offer", ROOM_ID, targetPeerId));

			assertError(sender.nextJson(), "TARGET_NOT_FOUND");
			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isOne();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void heartbeatPrefersGrantExpirationOverHeartbeatWork() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant grant = grantFor(
				ROOM_ID,
				"heartbeat-expired-user",
				"heartbeat-expired-token",
				clock.instant().plusMillis(1));
		batonService.start();
		try {
			TestPeer peer = peer("grant-heartbeat");
			attachReservation(
					peer,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.71", 41_010),
							grant)));
			peer.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					grant);
			assertThat(batonService.connect(peer.session())).isTrue();

			clock.advanceMillis(1);
			batonService.heartbeatSweep();

			peer.awaitClosed();
			assertThat(peer.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(peer.frameKinds()).doesNotContain("ping");
			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isOne();
			assertThat(batonRegistry.get("round.signaling.heartbeat.closes")
					.counter()
					.count()).isZero();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void expiredOverlapSocketsReleaseCapacityForAFreshGrant() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant oldFirst = grantFor(
				ROOM_ID,
				"reconnecting-user",
				"old-token-1",
				clock.instant().plusMillis(1));
		ParticipationGrant oldSecond = grantFor(
				ROOM_ID,
				"reconnecting-user",
				"old-token-2",
				clock.instant().plusMillis(1));
		batonService.start();
		try {
			TestPeer first = peer("old-grant-first");
			TestPeer second = peer("old-grant-second");
			attachReservation(
					first,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.72", 41_011),
							oldFirst)));
			first.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					oldFirst);
			attachReservation(
					second,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.73", 41_012),
							oldSecond)));
			second.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					oldSecond);
			assertThat(batonService.connect(first.session())).isTrue();
			assertThat(batonService.connect(second.session())).isTrue();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					oldFirst)).isEqualTo(2);

			clock.advanceMillis(1);
			batonService.expireUnjoinedSessions();

			first.awaitClosed();
			second.awaitClosed();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					oldFirst)).isZero();

			ParticipationGrant fresh = grantFor(
					ROOM_ID,
					"reconnecting-user",
					"fresh-token",
					clock.instant().plusSeconds(120));
			TestPeer reconnect = peer("fresh-grant");
			attachReservation(
					reconnect,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.74", 41_013),
							fresh)));
			reconnect.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					fresh);

			assertThat(batonService.connect(reconnect.session())).isTrue();
			assertThat(batonAdmissionPolicy.activeParticipantRoomReservationCount(
					fresh)).isOne();
			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isEqualTo(2);
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void monotonicLeaseExpiresEvenAfterTheWallClockRollsBack() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy =
				admissionPolicy(properties(6));
		ParticipationGrant grant = grantFor(
				ROOM_ID,
				"rollback-user",
				"rollback-token",
				clock.instant().plusSeconds(1));
		batonService.start();
		try {
			TestPeer peer = peer("grant-clock-rollback");
			attachReservation(
					peer,
					acceptedReservation(batonAdmissionPolicy.reserve(
							new InetSocketAddress("192.0.2.75", 41_014),
							grant)));
			peer.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					grant);
			assertThat(batonService.connect(peer.session())).isTrue();

			clock.advanceMillis(-60_000);
			monotonicTicker.advanceMillis(1_000);
			batonService.expireUnjoinedSessions();

			peer.awaitClosed();
			assertThat(peer.closeStatus().get())
					.isEqualTo(new CloseStatus(4001, "Participation grant expired"));
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
			assertThat(batonRegistry.get("round.signaling.authorization.closes")
					.counter()
					.count()).isOne();
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
		}
	}

	@Test
	void standaloneConnectionsRemainUnbounded() throws Exception {
		TestPeer peer = peer("standalone-unbounded");
		connect(peer);
		service.handle(peer.session(), join("Standalone"));
		peer.nextJson();

		clock.advanceMillis(Duration.ofDays(365).toMillis());
		monotonicTicker.advanceMillis(Duration.ofDays(365).toMillis());
		service.expireUnjoinedSessions();

		assertThat(service.acceptInboundFrame(peer.session(), 0)).isTrue();
		service.heartbeatSweep();
		peer.awaitPing();
		assertThat(peer.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.authorization.closes")
				.counter()
				.count()).isZero();
	}
}

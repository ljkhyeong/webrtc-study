package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.auth.RoomAccessPolicy;
import com.personal.round.auth.RoundAuthProperties;
import com.personal.round.config.MonotonicTicker;
import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TestProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.protocol.ServerMessageEncoder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class SignalingServiceTest {

	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";

	private ObjectMapper objectMapper;
	private ServerMessageEncoder serverMessageEncoder;
	private MutableClock clock;
	private MutableTicker monotonicTicker;
	private SimpleMeterRegistry meterRegistry;
	private ExecutorService outboundExecutor;
	private ConnectionAdmissionPolicy defaultAdmissionPolicy;
	private int nextTestClientAddress;
	private SignalingService service;

	@BeforeEach
	void setUp() {
		objectMapper = new ObjectMapper();
		serverMessageEncoder = new ServerMessageEncoder(objectMapper);
		clock = new MutableClock(
				Instant.parse("2026-07-26T00:00:00Z"),
				ZoneOffset.UTC);
		monotonicTicker = new MutableTicker();
		meterRegistry = new SimpleMeterRegistry();
		outboundExecutor = Executors.newThreadPerTaskExecutor(
				Thread.ofVirtual().name("round-signaling-test-", 0).factory());
		defaultAdmissionPolicy = admissionPolicy(properties(6));
		nextTestClientAddress = 1;
		service = service(properties(6), meterRegistry);
	}

	@AfterEach
	void tearDown() {
		service.stop();
		assertThat(defaultAdmissionPolicy.activeReservationCount()).isZero();
		outboundExecutor.close();
		assertThat(outboundExecutor.isTerminated()).isTrue();
	}

	@Test
	void joinsRelaysLeavesAndAllowsRejoinWithServerOwnedIdentity() throws Exception {
		TestPeer ada = peer("ada-session");
		TestPeer grace = peer("grace-session");
		TestPeer linus = peer("linus-session");
		connect(ada, grace, linus);

		service.handle(ada.session(), join("Ada"));
		JsonNode adaJoined = ada.nextJson();
		String adaPeerId = adaJoined.at("/payload/peerId").asString();
		assertThat(adaJoined.at("/payload/participants").size()).isZero();

		service.handle(grace.session(), join("Grace"));
		JsonNode graceJoined = grace.nextJson();
		String gracePeerId = graceJoined.at("/payload/peerId").asString();
		assertThat(graceJoined.at("/payload/participants/0/peerId").asString())
				.isEqualTo(adaPeerId);
		assertThat(ada.nextJson().at("/payload/participant/peerId").asString())
				.isEqualTo(gracePeerId);

		service.handle(linus.session(), join("Linus"));
		String linusPeerId = linus.nextJson().at("/payload/peerId").asString();
		ada.nextJson();
		grace.nextJson();

		service.handle(grace.session(), new ClientMessage.Relay(
				"rtc.offer",
				ROOM_ID,
				"must-not-be-relayed",
				adaPeerId,
				(ObjectNodeFixture.object(objectMapper, """
						{"negotiationId":"negotiation-42",
						 "description":{"type":"offer","sdp":"v=0"}}
						"""))));
		JsonNode relayed = ada.nextJson();
		assertThat(relayed.get("from").asString()).isEqualTo(gracePeerId);
		assertThat(relayed.has("to")).isFalse();
		assertThat(relayed.has("requestId")).isFalse();
		assertThat(relayed.at("/payload/negotiationId").asString()).isEqualTo("negotiation-42");
		assertThat(relayed.at("/payload/description/sdp").asString()).isEqualTo("v=0");

		service.handle(grace.session(), new ClientMessage.Leave(ROOM_ID, null));
		assertThat(ada.nextJson().at("/payload/peerId").asString()).isEqualTo(gracePeerId);
		assertThat(linus.nextJson().at("/payload/peerId").asString()).isEqualTo(gracePeerId);

		service.handle(grace.session(), join("Grace again"));
		JsonNode rejoined = grace.nextJson();
		assertThat(rejoined.get("type").asString()).isEqualTo("room.joined");
		assertThat(rejoined.at("/payload/participants").size()).isEqualTo(2);

		service.disconnect(grace.session());
		service.disconnect(grace.session());
		ada.nextJson();
		linus.nextJson();
		service.disconnect(linus.session());
		ada.nextJson();
		service.disconnect(ada.session());
		assertThat(service.roomCount()).isZero();
		assertThat(linusPeerId).isNotEqualTo(adaPeerId);
	}

	@Test
	void validatesRelayInTheDocumentedOrder() throws Exception {
		TestPeer ada = peer("ada-session");
		TestPeer grace = peer("grace-session");
		connect(ada, grace);

		service.handle(ada.session(), relay("rtc.offer", ROOM_ID, "anything"));
		assertError(ada.nextJson(), "NOT_IN_ROOM");

		service.handle(ada.session(), join("Ada"));
		String adaPeerId = ada.nextJson().at("/payload/peerId").asString();
		service.handle(ada.session(), relay("rtc.offer", OTHER_ROOM_ID, adaPeerId));
		assertError(ada.nextJson(), "ROOM_MISMATCH");

		service.handle(ada.session(), relay("rtc.offer", ROOM_ID, adaPeerId));
		assertError(ada.nextJson(), "TARGET_SELF");

		service.handle(ada.session(), relay("rtc.offer", ROOM_ID, "missing-peer"));
		assertError(ada.nextJson(), "TARGET_NOT_FOUND");
	}

	@Test
	void rejectsJoinOutsideTheVerifiedGrantBeforeCreatingRoomState() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		batonService.start();
		try {
			TestPeer peer = peer("baton-room-mismatch");
			attachDefaultReservation(peer);
			peer.session().getAttributes().put(
					ParticipationGrant.SESSION_ATTRIBUTE,
					grantFor(ROOM_ID));

			assertThat(batonService.connect(peer.session())).isTrue();
			batonService.handle(
					peer.session(),
					new ClientMessage.Join(OTHER_ROOM_ID, "join-other", "Mallory"));

			assertError(peer.nextJson(), "ROOM_MISMATCH");
			assertThat(batonService.roomCount()).isZero();
			assertThat(batonService.participantCount(OTHER_ROOM_ID)).isZero();
			assertThat(batonRegistry.get("round.signaling.joins.rejected")
					.tag("reason", "unauthorized_room")
					.counter()
					.count())
					.isOne();
		}
		finally {
			batonService.stop();
		}
	}

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

			assertThat(batonService.acceptInboundFrame(inbound.session())).isFalse();
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
			assertThat(batonService.acceptInboundFrame(handleRace.session())).isTrue();

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
			assertThat(observer.hasNoTextMessageFor(100)).isTrue();
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
			assertThat(observer.hasNoTextMessageFor(100)).isTrue();
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
			assertThat(target.hasNoTextMessageFor(100)).isTrue();
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

		assertThat(service.acceptInboundFrame(peer.session())).isTrue();
		service.heartbeatSweep();
		peer.awaitPing();
		assertThat(peer.closeStatus().get()).isNull();
		assertThat(meterRegistry.get("round.signaling.authorization.closes")
				.counter()
				.count()).isZero();
	}

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
		clock.advanceMillis(properties(6).heartbeatInterval().toMillis());
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
					new ClientMessage.Join(OTHER_ROOM_ID, null, "Independent peer"));
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
			clock.advanceMillis(properties(6).heartbeatInterval().toMillis());
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
		assertThat(ada.hasNoTextMessageFor(100)).isTrue();
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
		assertThat(TestPeer.await(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0,
				2_000)).isTrue();
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
		assertThat(TestPeer.await(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0,
				2_000)).isTrue();
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
			assertThat(meterRegistry.get("round.signaling.outbound.queue.global_overflows")
					.counter()
					.count()).isEqualTo(1);
		}
		finally {
			releaseFirstSend.countDown();
			releaseSecondSend.countDown();
		}

		assertThat(TestPeer.await(
				() -> meterRegistry.get("round.signaling.outbound.queue.bytes")
						.gauge()
						.value() == 0,
				2_000)).isTrue();
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
						// Simulate a transport close implementation that ignores interruption.
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

		assertThat(TestPeer.await(
				() -> peers.stream().allMatch(peer -> peer.closeStatus().get() != null),
				2_000)).isTrue();
	}

	@Test
	void executesOutboundWorkInlineWhenTheDedicatedExecutorRejectsIt() throws Exception {
		try (ExecutorService rejectingExecutor = Executors.newThreadPerTaskExecutor(
				Thread.ofVirtual().name("round-signaling-rejected-test-", 0).factory())) {
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

		long connectedAt = clock.millis();
		service.expireUnjoinedSessions(connectedAt + 14_999);
		assertThat(idle.closeStatus().get()).isNull();
		assertThat(joined.closeStatus().get()).isNull();

		service.expireUnjoinedSessions(connectedAt + 15_000);
		idle.awaitClosed();
		assertThat(idle.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Room join timeout"));
		assertThat(joined.closeStatus().get()).isNull();
		assertThat(service.participantCount(ROOM_ID)).isOne();
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
				assertThat(service.acceptInboundFrame(peer.session())).isTrue();
			}
		}
		TestPeer offender = peers.getFirst();
		for (int frame = 200; frame < 600; frame++) {
			assertThat(service.acceptInboundFrame(offender.session())).isTrue();
		}

		assertThat(service.acceptInboundFrame(offender.session())).isFalse();
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
	void backwardClockMovementDoesNotResetAnInboundQuotaWindow() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithFrameLimits(1, 1, 2, 4);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer peer = peer("clock-rollback");
		connect(peer);
		long windowStart = clock.millis();

		assertThat(service.acceptInboundFrame(peer.session(), windowStart)).isTrue();
		assertThat(service.acceptInboundFrame(peer.session(), windowStart - 1)).isFalse();

		peer.awaitClosed();
		assertThat(peer.closeStatus().get())
				.isEqualTo(new CloseStatus(1008, "Inbound frame rate exceeded"));
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
			assertThat(service.acceptInboundFrame(first.session())).isTrue();
			assertThat(service.acceptInboundFrame(second.session())).isTrue();
		}

		assertThat(service.acceptInboundFrame(first.session())).isFalse();
		assertThat(first.closeStatus().get()).isNull();
		assertThat(second.closeStatus().get()).isNull();
		assertThat(service.acceptInboundFrame(otherClient.session())).isTrue();
		assertThat(meterRegistry.get("round.signaling.frames.client_rate_limited")
				.counter()
				.count()).isEqualTo(1);
		assertThat(meterRegistry.get("round.signaling.frames.rate_limited")
				.counter()
				.count()).isZero();
		assertThat(meterRegistry.get("round.signaling.frames.overloaded")
				.counter()
				.count()).isZero();

		assertThat(service.acceptInboundFrame(first.session())).isFalse();
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

		assertThat(service.acceptInboundFrame(exhaustedSession.session())).isTrue();
		assertThat(service.acceptInboundFrame(exhaustedSession.session())).isTrue();

		assertThat(service.acceptInboundFrame(exhaustedSession.session())).isFalse();
		exhaustedSession.awaitClosed();
		assertThat(service.acceptInboundFrame(exhaustedClient.session())).isFalse();

		assertThat(service.acceptInboundFrame(otherClient.session())).isTrue();
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
		assertThat(service.acceptInboundFrame(first.session())).isTrue();
		assertThat(service.acceptInboundFrame(first.session())).isTrue();

		service.disconnect(first.session());
		assertThat(service.trackedInboundClientCount()).isOne();
		assertThat(service.activeInboundClientCount()).isZero();

		TestPeer reconnected = peer("reconnect-second");
		connectFrom(policy, "192.0.2.20", reconnected);

		assertThat(service.acceptInboundFrame(reconnected.session())).isFalse();
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
		assertThat(service.acceptInboundFrame(first.session())).isTrue();
		service.disconnect(first.session());
		assertThat(service.trackedInboundClientCount()).isOne();

		clock.advanceMillis(properties.abuseWindow().toMillis());
		TestPeer second = peer("expired-on-sweep");
		connectFrom(policy, "192.0.2.22", second);
		assertThat(service.trackedInboundClientCount()).isOne();
		assertThat(service.acceptInboundFrame(second.session())).isTrue();
		service.disconnect(second.session());

		clock.advanceMillis(properties.abuseWindow().toMillis() - 1);
		service.expireUnjoinedSessions();
		assertThat(service.trackedInboundClientCount()).isOne();

		clock.advanceMillis(1);
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
		assertThat(service.acceptInboundFrame(active.session())).isTrue();
		assertThat(service.acceptInboundFrame(inactive.session())).isTrue();
		service.disconnect(inactive.session());
		assertThat(service.trackedInboundClientCount()).isEqualTo(2);
		assertThat(service.activeInboundClientCount()).isOne();

		TestPeer replacement = peer("bounded-replacement");
		connectFrom(policy, "192.0.2.25", replacement);

		assertThat(service.trackedInboundClientCount()).isEqualTo(2);
		assertThat(service.activeInboundClientCount()).isEqualTo(2);
		service.disconnect(active.session());
		assertThat(service.trackedInboundClientCount()).isEqualTo(2);
		assertThat(service.activeInboundClientCount()).isOne();
	}

	@Test
	void stopClearsRetainedInactiveClientWindows() throws Exception {
		ConnectionAdmissionPolicy policy = admissionPolicy(properties(6));
		TestPeer peer = peer("retained-until-stop");
		connectFrom(policy, "192.0.2.26", peer);
		assertThat(service.acceptInboundFrame(peer.session())).isTrue();
		service.disconnect(peer.session());
		assertThat(service.trackedInboundClientCount()).isOne();

		service.stop();

		assertThat(service.trackedInboundClientCount()).isZero();
		assertThat(service.activeInboundClientCount()).isZero();
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
			assertThat(service.acceptInboundFrame(first.session())).isTrue();
			assertThat(service.acceptInboundFrame(second.session())).isTrue();
		}
		for (int frame = 0; frame < 6; frame++) {
			assertThat(service.acceptInboundFrame(third.session())).isTrue();
		}

		assertThat(service.acceptInboundFrame(third.session())).isFalse();
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
		assertThat(service.acceptInboundFrame(
				third.session(),
				clock.millis() + properties.abuseWindow().toMillis())).isTrue();
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
				service,
				properties);
		ConnectionAdmissionPolicy policy = admissionPolicy(properties);
		TestPeer firstLoad = peer("pong-global-load-first");
		TestPeer secondLoad = peer("pong-global-load-second");
		TestPeer responsive = peer("pong-global-responsive");
		connectFrom(policy, "192.0.2.40", firstLoad);
		connectFrom(policy, "192.0.2.41", secondLoad);
		connectFrom(policy, "192.0.2.42", responsive);
		assertThat(service.acceptInboundFrame(firstLoad.session())).isTrue();
		assertThat(service.acceptInboundFrame(secondLoad.session())).isTrue();
		service.disconnect(firstLoad.session());
		service.disconnect(secondLoad.session());

		service.heartbeatSweep();
		PingMessage responsivePing = responsive.awaitPing();
		handler.handleMessage(
				responsive.session(),
				new PongMessage(responsivePing.getPayload().asReadOnlyBuffer()));
		clock.advanceMillis(properties(6).heartbeatInterval().toMillis());
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
			clock.advanceMillis(properties(6).heartbeatInterval().toMillis());
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
				service,
				properties);
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

	@Test
	void rejectsConnectionsBeyondTheConfiguredGlobalLimit() throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithConnectionLimits(2, 2, 2);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer first = peer("limit-first");
		TestPeer second = peer("limit-second");
		TestPeer rejected = peer("limit-rejected");
		attachDefaultReservation(first);
		attachDefaultReservation(second);
		attachDefaultReservation(rejected);

		assertThat(service.connect(first.session())).isTrue();
		assertThat(service.connect(second.session())).isTrue();
		assertThat(service.connect(rejected.session())).isFalse();

		rejected.awaitClosed();
		assertThat(rejected.closeStatus().get())
				.isEqualTo(new CloseStatus(1013, "Server connection limit reached"));
		assertThat(service.connectedPeerCount()).isEqualTo(2);
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
	void releasesAdmissionReservationsOnDisconnectConnectRejectionAndStop()
			throws Exception {
		service.stop();
		SignalingProperties properties =
				TestProperties.signalingWithConnectionLimits(1, 1, 1);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		ConnectionAdmissionPolicy policy = new ConnectionAdmissionPolicy(
				TestProperties.signalingWithConnectionLimits(1, 3, 3),
				new SignalingMetrics(new SimpleMeterRegistry()),
				new ClientAddressKeyResolver());
		TestPeer unclaimed = peer("reserved-unclaimed");
		attachReservation(
				unclaimed,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.29", 41_000))));
		service.releaseUnclaimedReservation(unclaimed.session());
		assertThat(policy.activeReservationCount()).isZero();

		TestPeer accepted = peer("reserved-accepted");
		TestPeer rejected = peer("reserved-rejected");
		attachReservation(
				accepted,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.30", 41_000))));
		attachReservation(
				rejected,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.31", 41_000))));

		assertThat(service.connect(accepted.session())).isTrue();
		assertThat(service.connect(rejected.session())).isFalse();
		rejected.awaitClosed();
		assertThat(policy.activeReservationCount()).isEqualTo(1);

		service.disconnect(rejected.session());
		service.disconnect(accepted.session());
		service.disconnect(accepted.session());
		assertThat(policy.activeReservationCount()).isZero();

		TestPeer stoppedPeer = peer("reserved-stop");
		attachReservation(
				stoppedPeer,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.32", 41_000))));
		assertThat(service.connect(stoppedPeer.session())).isTrue();

		service.stop();

		assertThat(policy.activeReservationCount()).isZero();
	}

	private void connect(TestPeer... peers) {
		for (TestPeer peer : peers) {
			attachDefaultReservation(peer);
			assertThat(service.connect(peer.session())).isTrue();
		}
	}

	private void attachDefaultReservation(TestPeer peer) {
		ConnectionAdmissionPolicy.Admission admission = defaultAdmissionPolicy.reserve(
				new InetSocketAddress(
						"198.51.100." + nextTestClientAddress++,
						41_000));
		attachReservation(peer, acceptedReservation(admission));
	}

	private ConnectionAdmissionPolicy admissionPolicy(SignalingProperties properties) {
		return new ConnectionAdmissionPolicy(
				properties,
				new SignalingMetrics(new SimpleMeterRegistry()),
				new ClientAddressKeyResolver());
	}

	private void connectFrom(
			ConnectionAdmissionPolicy policy,
			String clientAddress,
			TestPeer... peers) {
		int port = 41_000;
		for (TestPeer peer : peers) {
			ConnectionAdmissionPolicy.Admission admission =
					policy.reserve(new InetSocketAddress(clientAddress, port++));
			attachReservation(peer, acceptedReservation(admission));
			assertThat(service.connect(peer.session())).isTrue();
		}
	}

	private ClientMessage.Join join(String displayName) {
		return new ClientMessage.Join(ROOM_ID, null, displayName);
	}

	private ClientMessage.Relay relay(String type, String roomId, String target) throws Exception {
		String descriptionType = type.substring("rtc.".length());
		return new ClientMessage.Relay(
				type,
				roomId,
				null,
				target,
				ObjectNodeFixture.object(
						objectMapper,
						"{\"description\":{\"type\":\"" + descriptionType + "\"}}"));
	}

	private static SignalingProperties properties(int maxRoomSize) {
		return TestProperties.signaling(maxRoomSize);
	}

	private SignalingService service(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		SignalingService started = newService(properties, registry);
		started.start();
		return started;
	}

	private SignalingService newService(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		return new SignalingService(
				serverMessageEncoder,
				properties,
				new SignalingMetrics(registry),
				new RoomAccessPolicy(standaloneAuth()),
				outboundExecutor,
				clock,
				monotonicTicker);
	}

	private SignalingService newBatonService(SimpleMeterRegistry registry) {
		return new SignalingService(
				serverMessageEncoder,
				properties(6),
				new SignalingMetrics(registry),
				new RoomAccessPolicy(batonAuth()),
				outboundExecutor,
				clock,
				monotonicTicker);
	}

	private static RoundAuthProperties standaloneAuth() {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.STANDALONE,
				"__Secure-round_access",
				null,
				"round",
				null,
				Duration.ofMinutes(5));
	}

	private static RoundAuthProperties batonAuth() {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				Duration.ofMinutes(5));
	}

	private ParticipationGrant grantFor(String roomId) {
		return grantFor(
				roomId,
				"baton-user-1",
				"grant-1",
				clock.instant().plusSeconds(120));
	}

	private ParticipationGrant grantFor(
			String roomId,
			String subject,
			String tokenId,
			Instant expiresAt) {
		return new ParticipationGrant(
				subject,
				"study-1",
				roomId,
				ParticipationGrant.Role.PARTICIPANT,
				tokenId,
				clock.instant().minusSeconds(1),
				expiresAt);
	}

	private TestPeer peer(String id) throws Exception {
		return peer(id, null, null);
	}

	private static void attachReservation(
			TestPeer peer,
			ConnectionAdmissionPolicy.Reservation reservation) {
		Map<String, Object> attributes = new HashMap<>();
		attributes.put(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		when(peer.session().getAttributes()).thenReturn(attributes);
	}

	private static void attachGrantReservation(
			TestPeer peer,
			ConnectionAdmissionPolicy admissionPolicy,
			InetSocketAddress remoteAddress,
			ParticipationGrant grant) {
		attachReservation(
				peer,
				acceptedReservation(admissionPolicy.reserve(remoteAddress, grant)));
		peer.session().getAttributes().put(
				ParticipationGrant.SESSION_ATTRIBUTE,
				grant);
	}

	private static ConnectionAdmissionPolicy.Reservation acceptedReservation(
			ConnectionAdmissionPolicy.Admission admission) {
		assertThat(admission).isInstanceOf(ConnectionAdmissionPolicy.Accepted.class);
		return ((ConnectionAdmissionPolicy.Accepted) admission).reservation();
	}

	private TestPeer peer(
			String id,
			CountDownLatch firstSendEntered,
			CountDownLatch releaseFirstSend) throws Exception {
		WebSocketSession session = mock(WebSocketSession.class);
		List<WebSocketMessage<?>> messages = Collections.synchronizedList(new ArrayList<>());
		AtomicBoolean open = new AtomicBoolean(true);
		AtomicBoolean firstSend = new AtomicBoolean(true);
		AtomicBoolean failNextSend = new AtomicBoolean(false);
		AtomicReference<CloseStatus> closeStatus = new AtomicReference<>();
		when(session.getId()).thenReturn(id);
		when(session.isOpen()).thenAnswer(ignored -> open.get());
		doAnswer(invocation -> {
			if (failNextSend.compareAndSet(true, false)) {
				throw new java.io.IOException("Simulated send failure");
			}
			messages.add(invocation.getArgument(0));
			if (firstSendEntered != null && firstSend.compareAndSet(true, false)) {
				firstSendEntered.countDown();
				if (!releaseFirstSend.await(2, TimeUnit.SECONDS)) {
					throw new java.io.IOException("Timed out waiting to release blocked send");
				}
			}
			return null;
		}).when(session).sendMessage(any(WebSocketMessage.class));
		doAnswer(invocation -> {
			open.set(false);
			closeStatus.set(invocation.getArgument(0));
			return null;
		}).when(session).close(any(CloseStatus.class));
		return new TestPeer(session, messages, closeStatus, failNextSend, objectMapper);
	}

	private static void assertError(JsonNode message, String code) {
		assertThat(message.get("type").asString()).isEqualTo("error");
		assertThat(message.at("/payload/code").asString()).isEqualTo(code);
	}

	private static byte[] payloadBytes(PingMessage pingMessage) {
		var payload = pingMessage.getPayload().asReadOnlyBuffer();
		byte[] bytes = new byte[payload.remaining()];
		payload.get(bytes);
		return bytes;
	}

	private static final class MutableClock extends Clock {

		private Instant instant;
		private final ZoneId zone;

		private MutableClock(Instant instant, ZoneId zone) {
			this.instant = instant;
			this.zone = zone;
		}

		private void advanceMillis(long millis) {
			instant = instant.plusMillis(millis);
		}

		@Override
		public ZoneId getZone() {
			return zone;
		}

		@Override
		public Clock withZone(ZoneId requestedZone) {
			return new MutableClock(instant, requestedZone);
		}

		@Override
		public Instant instant() {
			return instant;
		}
	}

	private static final class MutableTicker implements MonotonicTicker {

		private final AtomicLong nanos = new AtomicLong();

		private void advanceMillis(long millis) {
			nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis));
		}

		@Override
		public long readNanos() {
			return nanos.get();
		}
	}

	private record TestPeer(
			WebSocketSession session,
			List<WebSocketMessage<?>> messages,
			AtomicReference<CloseStatus> closeStatus,
			AtomicBoolean failNextSendFlag,
			ObjectMapper objectMapper) {

		JsonNode nextJson() throws Exception {
			long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
			do {
				synchronized (messages) {
					for (int index = 0; index < messages.size(); index++) {
						WebSocketMessage<?> message = messages.get(index);
						if (message instanceof TextMessage textMessage) {
							messages.remove(index);
							return objectMapper.readTree(textMessage.getPayload());
						}
					}
				}
				Thread.sleep(5);
			}
			while (System.nanoTime() < deadline);
			throw new AssertionError("No queued text signaling message");
		}

		boolean hasMessage(Predicate<JsonNode> predicate) {
			synchronized (messages) {
				return messages.stream()
						.filter(TextMessage.class::isInstance)
						.map(TextMessage.class::cast)
						.map(text -> {
							try {
								return objectMapper.readTree(text.getPayload());
							}
							catch (Exception exception) {
								throw new AssertionError(exception);
							}
						})
						.anyMatch(predicate);
			}
		}

		void awaitTextMessage() {
			awaitMessage(TextMessage.class::isInstance);
		}

		void awaitMessage(Predicate<WebSocketMessage<?>> predicate) {
			assertThat(await(() -> {
				synchronized (messages) {
					return messages.stream().anyMatch(predicate);
				}
			}, 2_000)).isTrue();
		}

		PingMessage awaitPing() {
			awaitMessage(PingMessage.class::isInstance);
			synchronized (messages) {
				return messages.stream()
						.filter(PingMessage.class::isInstance)
						.map(PingMessage.class::cast)
						.findFirst()
						.orElseThrow();
			}
		}

		void awaitFrameCount(int expected) {
			assertThat(await(() -> messages.size() >= expected, 2_000)).isTrue();
		}

		void awaitClosed() {
			assertThat(await(() -> closeStatus.get() != null, 2_000)).isTrue();
		}

		void failNextSend() {
			failNextSendFlag.set(true);
		}

		List<String> frameKinds() {
			synchronized (messages) {
				return messages.stream()
						.map(message -> {
							if (message instanceof PingMessage) {
								return "ping";
							}
							if (message instanceof TextMessage textMessage) {
								try {
									return objectMapper.readTree(textMessage.getPayload())
											.get("type")
											.asString();
								}
								catch (Exception exception) {
									throw new AssertionError(exception);
								}
							}
							return message.getClass().getSimpleName();
						})
						.toList();
			}
		}

		boolean hasNoTextMessageFor(long milliseconds) {
			long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(milliseconds);
			do {
				synchronized (messages) {
					if (messages.stream().anyMatch(TextMessage.class::isInstance)) {
						return false;
					}
				}
				try {
					Thread.sleep(5);
				}
				catch (InterruptedException exception) {
					Thread.currentThread().interrupt();
					return false;
				}
			}
			while (System.nanoTime() < deadline);
			return true;
		}

		private static boolean await(BooleanSupplier condition, long milliseconds) {
			long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(milliseconds);
			do {
				if (condition.getAsBoolean()) {
					return true;
				}
				try {
					Thread.sleep(5);
				}
				catch (InterruptedException exception) {
					Thread.currentThread().interrupt();
					return false;
				}
			}
			while (System.nanoTime() < deadline);
			return condition.getAsBoolean();
		}
	}

	private static final class ObjectNodeFixture {

		private ObjectNodeFixture() {
		}

		static tools.jackson.databind.node.ObjectNode object(ObjectMapper mapper, String json)
				throws Exception {
			return (tools.jackson.databind.node.ObjectNode) mapper.readTree(json);
		}
	}
}

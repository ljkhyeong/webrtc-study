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
import com.personal.round.net.ClientAddressKeyResolver;
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
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.JsonNode;

class SignalingServiceRoomAuthorizationTest extends SignalingServiceTestSupport {

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
					new ClientMessage.Join(OTHER_ROOM_ID, "join-other", "Mallory", null));

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
	void standaloneHostDisablesOnlyARemoteParticipantsMedia() throws Exception {
		service.stop();
		service = newService(properties(6), meterRegistry, standaloneAuth(HOST_TOKEN_SHA256));
		service.start();
		TestPeer host = peer("host-session");
		TestPeer participant = peer("participant-session");
		connect(host, participant);

		service.handle(
				host.session(),
				new ClientMessage.Join(ROOM_ID, "join-host", "Host", HOST_TOKEN));
		JsonNode hostJoined = host.nextJson();
		String hostPeerId = hostJoined.at("/payload/peerId").asString();
		assertThat(hostJoined.at("/payload/selfRole").asString()).isEqualTo("host");
		assertThat(hostJoined.at("/payload/capabilities/canModerateMedia").asBoolean()).isTrue();

		service.handle(participant.session(), join("Participant"));
		JsonNode participantJoined = participant.nextJson();
		String participantPeerId = participantJoined.at("/payload/peerId").asString();
		assertThat(participantJoined.at("/payload/selfRole").asString()).isEqualTo("participant");
		assertThat(participantJoined.at("/payload/participants/0/role").asString())
				.isEqualTo("host");
		assertThat(host.nextJson().at("/payload/participant/role").asString())
				.isEqualTo("participant");

		service.handle(
				host.session(),
				new ClientMessage.Moderation(
						ROOM_ID,
						"moderate-audio",
						participantPeerId,
						ClientMessage.MediaKind.AUDIO));

		JsonNode command = participant.nextJson();
		assertThat(command.get("type").asString()).isEqualTo("moderation.media.disabled");
		assertThat(command.get("from").asString()).isEqualTo(hostPeerId);
		assertThat(command.get("requestId").asString()).isEqualTo("moderate-audio");
		assertThat(command.at("/payload/targetPeerId").asString())
				.isEqualTo(participantPeerId);
		assertThat(command.at("/payload/kind").asString()).isEqualTo("audio");
		host.assertNoTextMessageFor(Duration.ofMillis(100));

		service.handle(
				participant.session(),
				new ClientMessage.Moderation(
						ROOM_ID,
						"participant-attempt",
						hostPeerId,
						ClientMessage.MediaKind.VIDEO));
		assertError(participant.nextJson(), "FORBIDDEN");
	}

	@Test
	void rejectsAnInvalidStandaloneHostCapabilityWithoutJoiningTheRoom() throws Exception {
		service.stop();
		service = newService(properties(6), meterRegistry, standaloneAuth(HOST_TOKEN_SHA256));
		service.start();
		TestPeer impostor = peer("impostor-session");
		connect(impostor);

		service.handle(
				impostor.session(),
				new ClientMessage.Join(ROOM_ID, "join-impostor", "Impostor", "wrong-token"));

		assertError(impostor.nextJson(), "FORBIDDEN");
		assertThat(service.participantCount(ROOM_ID)).isZero();
		assertThat(service.roomCount()).isZero();
		assertThat(meterRegistry.get("round.signaling.joins.rejected")
				.tag("reason", "invalid_host_capability")
				.counter()
				.count())
				.isOne();
	}

	@Test
	void rejectsModerationOutsideTheAuthorizedTargetBoundary() throws Exception {
		service.stop();
		service = newService(properties(6), meterRegistry, standaloneAuth(HOST_TOKEN_SHA256));
		service.start();
		TestPeer host = peer("boundary-host");
		TestPeer secondHost = peer("boundary-second-host");
		TestPeer participant = peer("boundary-participant");
		TestPeer otherRoom = peer("boundary-other-room");
		TestPeer unjoined = peer("boundary-unjoined");
		connect(host, secondHost, participant, otherRoom, unjoined);

		service.handle(
				host.session(),
				new ClientMessage.Join(ROOM_ID, "join-host", "Host", HOST_TOKEN));
		String hostPeerId = host.nextJson().at("/payload/peerId").asString();

		service.handle(
				secondHost.session(),
				new ClientMessage.Join(ROOM_ID, "join-second-host", "Second host", HOST_TOKEN));
		String secondHostPeerId = secondHost.nextJson().at("/payload/peerId").asString();
		host.nextJson();

		service.handle(participant.session(), join("Participant"));
		String participantPeerId = participant.nextJson().at("/payload/peerId").asString();
		host.nextJson();
		secondHost.nextJson();

		service.handle(
				otherRoom.session(),
				new ClientMessage.Join(
						OTHER_ROOM_ID, "join-other-room", "Other room", null));
		String otherRoomPeerId = otherRoom.nextJson().at("/payload/peerId").asString();

		service.handle(
				unjoined.session(),
				new ClientMessage.Moderation(
						ROOM_ID,
						"before-join",
						participantPeerId,
						ClientMessage.MediaKind.AUDIO));
		assertError(unjoined.nextJson(), "NOT_IN_ROOM");

		service.handle(
				host.session(),
				new ClientMessage.Moderation(
						OTHER_ROOM_ID,
						"wrong-room",
						participantPeerId,
						ClientMessage.MediaKind.AUDIO));
		assertError(host.nextJson(), "ROOM_MISMATCH");

		service.handle(
				host.session(),
				new ClientMessage.Moderation(
						ROOM_ID,
						"self-target",
						hostPeerId,
						ClientMessage.MediaKind.VIDEO));
		assertError(host.nextJson(), "TARGET_SELF");

		for (String target : List.of("missing-peer", otherRoomPeerId)) {
			service.handle(
					host.session(),
					new ClientMessage.Moderation(
							ROOM_ID,
							"missing-target",
							target,
							ClientMessage.MediaKind.AUDIO));
			assertError(host.nextJson(), "TARGET_NOT_FOUND");
		}

		service.handle(
				host.session(),
				new ClientMessage.Moderation(
						ROOM_ID,
						"host-target",
						secondHostPeerId,
						ClientMessage.MediaKind.VIDEO));
		assertError(host.nextJson(), "FORBIDDEN");
	}

	@Test
	void clearsStandaloneHostRoleBeforeRejoiningWithoutTheCapability() throws Exception {
		service.stop();
		service = newService(properties(6), meterRegistry, standaloneAuth(HOST_TOKEN_SHA256));
		service.start();
		TestPeer peer = peer("rejoining-host");
		connect(peer);

		service.handle(
				peer.session(),
				new ClientMessage.Join(ROOM_ID, "join-host", "Host", HOST_TOKEN));
		assertThat(peer.nextJson().at("/payload/selfRole").asString()).isEqualTo("host");

		service.handle(peer.session(), new ClientMessage.Leave(ROOM_ID, "leave-host"));
		service.handle(
				peer.session(),
				new ClientMessage.Join(ROOM_ID, "join-participant", "Host", null));
		JsonNode rejoined = peer.nextJson();
		assertThat(rejoined.at("/payload/selfRole").asString()).isEqualTo("participant");
		assertThat(rejoined.at("/payload/capabilities/canModerateMedia").asBoolean()).isFalse();
	}

	@Test
	void acceptsModerationOnlyFromTheRoleInAVerifiedBatonGrant() throws Exception {
		SimpleMeterRegistry batonRegistry = new SimpleMeterRegistry();
		SignalingService batonService = newBatonService(batonRegistry);
		ConnectionAdmissionPolicy batonAdmissionPolicy = admissionPolicy(properties(6));
		ParticipationGrant hostGrant = grantFor(
				ROOM_ID,
				"baton-host",
				"baton-host-token",
				clock.instant().plusSeconds(120),
				ParticipationGrant.Role.HOST);
		ParticipationGrant participantGrant = grantFor(
				ROOM_ID,
				"baton-participant",
				"baton-participant-token",
				clock.instant().plusSeconds(120));
		batonService.start();
		try {
			TestPeer host = peer("baton-host-session");
			TestPeer participant = peer("baton-participant-session");
			attachGrantReservation(
					host,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.90", 41_020),
					hostGrant);
			attachGrantReservation(
					participant,
					batonAdmissionPolicy,
					new InetSocketAddress("192.0.2.91", 41_021),
					participantGrant);
			assertThat(batonService.connect(host.session())).isTrue();
			assertThat(batonService.connect(participant.session())).isTrue();

			batonService.handle(host.session(), join("BATON host"));
			JsonNode hostJoined = host.nextJson();
			String hostPeerId = hostJoined.at("/payload/peerId").asString();
			assertThat(hostJoined.at("/payload/selfRole").asString()).isEqualTo("host");

			batonService.handle(participant.session(), join("BATON participant"));
			String participantPeerId = participant.nextJson().at("/payload/peerId").asString();
			host.nextJson();

			batonService.handle(
					host.session(),
					new ClientMessage.Moderation(
							ROOM_ID,
							"baton-moderation",
							participantPeerId,
							ClientMessage.MediaKind.VIDEO));
			JsonNode command = participant.nextJson();
			assertThat(command.get("type").asString()).isEqualTo("moderation.media.disabled");
			assertThat(command.get("from").asString()).isEqualTo(hostPeerId);
			host.assertNoTextMessageFor(Duration.ofMillis(100));
		}
		finally {
			batonService.stop();
			assertThat(batonAdmissionPolicy.activeReservationCount()).isZero();
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
	void releasesAdmissionReservationsOnConnectRejectionDisconnectAndStop()
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
		TestPeer accepted = peer("reserved-accepted");
		TestPeer rejected = peer("reserved-rejected");
		attachReservation(
				accepted,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.30", 41_000),
						null)));
		attachReservation(
				rejected,
				acceptedReservation(policy.reserve(
						new InetSocketAddress("192.0.2.31", 41_000),
						null)));

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
						new InetSocketAddress("192.0.2.32", 41_000),
						null)));
		assertThat(service.connect(stoppedPeer.session())).isTrue();

		service.stop();

		assertThat(policy.activeReservationCount()).isZero();
	}
}

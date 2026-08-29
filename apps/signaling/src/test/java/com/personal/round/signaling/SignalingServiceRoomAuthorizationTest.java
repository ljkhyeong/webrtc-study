package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ServerMessageEncoder.Participant;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
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
}

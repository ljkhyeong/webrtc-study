package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class SignalingServiceTest {

	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";

	private ObjectMapper objectMapper;
	private Clock clock;
	private SimpleMeterRegistry meterRegistry;
	private SignalingService service;

	@BeforeEach
	void setUp() {
		objectMapper = new ObjectMapper();
		clock = Clock.fixed(Instant.parse("2026-07-26T00:00:00Z"), ZoneOffset.UTC);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties(6), meterRegistry);
	}

	@AfterEach
	void tearDown() {
		service.shutdown();
	}

	@Test
	void joinsRelaysLeavesAndAllowsRejoinWithServerOwnedIdentity() throws Exception {
		TestPeer ada = peer("ada-session");
		TestPeer grace = peer("grace-session");
		TestPeer linus = peer("linus-session");
		connect(ada, grace, linus);

		service.handle(ada.session(), join("Ada"));
		JsonNode adaJoined = ada.nextJson();
		String adaPeerId = adaJoined.at("/payload/peerId").asText();
		assertThat(adaJoined.at("/payload/participants").size()).isZero();

		service.handle(grace.session(), join("Grace"));
		JsonNode graceJoined = grace.nextJson();
		String gracePeerId = graceJoined.at("/payload/peerId").asText();
		assertThat(graceJoined.at("/payload/participants/0/peerId").asText())
				.isEqualTo(adaPeerId);
		assertThat(ada.nextJson().at("/payload/participant/peerId").asText())
				.isEqualTo(gracePeerId);

		service.handle(linus.session(), join("Linus"));
		String linusPeerId = linus.nextJson().at("/payload/peerId").asText();
		ada.nextJson();
		grace.nextJson();

		service.handle(grace.session(), new ClientMessage.Relay(
				"rtc.offer",
				ROOM_ID,
				"must-not-be-relayed",
				adaPeerId,
				(ObjectNodeFixture.object(objectMapper, """
						{"description":{"type":"offer","sdp":"v=0"}}
						"""))));
		JsonNode relayed = ada.nextJson();
		assertThat(relayed.get("from").asText()).isEqualTo(gracePeerId);
		assertThat(relayed.has("to")).isFalse();
		assertThat(relayed.has("requestId")).isFalse();
		assertThat(relayed.at("/payload/description/sdp").asText()).isEqualTo("v=0");

		service.handle(grace.session(), new ClientMessage.Leave(ROOM_ID, null));
		assertThat(ada.nextJson().at("/payload/peerId").asText()).isEqualTo(gracePeerId);
		assertThat(linus.nextJson().at("/payload/peerId").asText()).isEqualTo(gracePeerId);

		service.handle(grace.session(), join("Grace again"));
		JsonNode rejoined = grace.nextJson();
		assertThat(rejoined.get("type").asText()).isEqualTo("room.joined");
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
		String adaPeerId = ada.nextJson().at("/payload/peerId").asText();
		service.handle(ada.session(), relay("rtc.offer", OTHER_ROOM_ID, adaPeerId));
		assertError(ada.nextJson(), "ROOM_MISMATCH");

		service.handle(ada.session(), relay("rtc.offer", ROOM_ID, adaPeerId));
		assertError(ada.nextJson(), "TARGET_SELF");

		service.handle(ada.session(), relay("rtc.offer", ROOM_ID, "missing-peer"));
		assertError(ada.nextJson(), "TARGET_NOT_FOUND");
	}

	@Test
	void enforcesRoomCapacityAtomicallyUnderConcurrentJoins() throws Exception {
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < 12; index++) {
			TestPeer peer = peer("session-" + index);
			peers.add(peer);
			service.connect(peer.session());
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
								&& "room.joined".equals(node.get("type").asText())))
				.count();
		long fullCount = peers.stream()
				.filter(peer -> peer.hasMessage(
						node -> node.at("/payload/code").isTextual()
								&& "ROOM_FULL".equals(node.at("/payload/code").asText())))
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
		String sleepingPeerId = sleeping.nextJson().at("/payload/peerId").asText();
		responsive.nextJson();

		service.heartbeatSweep();
		responsive.awaitMessage(PingMessage.class::isInstance);
		sleeping.awaitMessage(PingMessage.class::isInstance);
		service.markAlive(responsive.session());
		service.heartbeatSweep();

		sleeping.awaitClosed();
		assertThat(sleeping.closeStatus().get())
				.isEqualTo(new CloseStatus(4000, "Heartbeat timeout"));
		assertThat(responsive.nextJson().at("/payload/peerId").asText()).isEqualTo(sleepingPeerId);
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

			assertThat(joined.get("type").asText()).isEqualTo("room.joined");
			assertThat(joined.get("roomId").asText()).isEqualTo(OTHER_ROOM_ID);
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
			String adaPeerId = graceJoined.at("/payload/participants/0/peerId").asText();

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
	void sendFailureDisconnectsOnceAndBroadcastsPeerLeft() throws Exception {
		TestPeer ada = peer("ada");
		TestPeer grace = peer("grace");
		connect(ada, grace);
		service.handle(ada.session(), join("Ada"));
		ada.nextJson();
		service.handle(grace.session(), join("Grace"));
		String gracePeerId = grace.nextJson().at("/payload/peerId").asText();
		ada.nextJson();

		grace.failNextSend();
		service.sendInvalidMessage(grace.session(), "force a transport write");

		assertThat(ada.nextJson().at("/payload/peerId").asText()).isEqualTo(gracePeerId);
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
	void shutdownRejectsNewConnectionsAndClosesExistingSessionsWithGoingAway() throws Exception {
		TestPeer connected = peer("connected-before-shutdown");
		connect(connected);
		service.handle(connected.session(), join("Ada"));
		connected.nextJson();

		service.shutdown();

		connected.awaitClosed();
		assertThat(connected.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		assertThat(service.isAcceptingConnections()).isFalse();
		assertThat(service.connectedPeerCount()).isZero();
		assertThat(service.roomCount()).isZero();

		TestPeer late = peer("late-connection");
		assertThat(service.connect(late.session())).isFalse();
		late.awaitClosed();
		assertThat(late.closeStatus().get())
				.isEqualTo(new CloseStatus(1001, "Server shutting down"));
	}

	@Test
	void shutdownKeepsGoingAwayStatusWhenAnOutboundWriteIsInFlight() throws Exception {
		CountDownLatch sendEntered = new CountDownLatch(1);
		CountDownLatch releaseSend = new CountDownLatch(1);
		TestPeer slow = peer("shutdown-in-flight", sendEntered, releaseSend);
		connect(slow);

		try {
			service.handle(slow.session(), join("Slow peer"));
			assertThat(sendEntered.await(1, TimeUnit.SECONDS)).isTrue();

			service.shutdown();

			slow.awaitClosed();
			assertThat(slow.closeStatus().get())
					.isEqualTo(new CloseStatus(1001, "Server shutting down"));
		}
		finally {
			releaseSend.countDown();
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
		List<TestPeer> peers = new ArrayList<>();
		for (int index = 0; index < 6; index++) {
			TestPeer peer = peer("burst-" + index);
			peers.add(peer);
			assertThat(service.connect(peer.session())).isTrue();
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
		assertThat(service.connectedPeerCount()).isEqualTo(5);
	}

	@Test
	void appliesTheGlobalFrameWindowAcrossSessions() throws Exception {
		service.shutdown();
		SignalingProperties properties = properties(6);
		properties.setMaxFramesPerSessionWindow(10);
		properties.setMaxFramesGlobalWindow(12);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer first = peer("global-first");
		TestPeer second = peer("global-second");
		connect(first, second);

		for (int frame = 0; frame < 6; frame++) {
			assertThat(service.acceptInboundFrame(first.session())).isTrue();
			assertThat(service.acceptInboundFrame(second.session())).isTrue();
		}

		assertThat(service.acceptInboundFrame(first.session())).isFalse();
		first.awaitClosed();
		assertThat(second.closeStatus().get()).isNull();
	}

	@Test
	void rejectsConnectionsBeyondTheConfiguredGlobalLimit() throws Exception {
		service.shutdown();
		SignalingProperties properties = properties(2);
		properties.setMaxConnections(2);
		meterRegistry = new SimpleMeterRegistry();
		service = service(properties, meterRegistry);
		TestPeer first = peer("limit-first");
		TestPeer second = peer("limit-second");
		TestPeer rejected = peer("limit-rejected");

		assertThat(service.connect(first.session())).isTrue();
		assertThat(service.connect(second.session())).isTrue();
		assertThat(service.connect(rejected.session())).isFalse();

		rejected.awaitClosed();
		assertThat(rejected.closeStatus().get())
				.isEqualTo(new CloseStatus(1013, "Server connection limit reached"));
		assertThat(service.connectedPeerCount()).isEqualTo(2);
	}

	private void connect(TestPeer... peers) {
		for (TestPeer peer : peers) {
			service.connect(peer.session());
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
		SignalingProperties properties = new SignalingProperties();
		properties.setMaxRoomSize(maxRoomSize);
		return properties;
	}

	private SignalingService service(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		return new SignalingService(
				objectMapper,
				properties,
				new SignalingMetrics(registry),
				clock);
	}

	private TestPeer peer(String id) throws Exception {
		return peer(id, null, null);
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
		assertThat(message.get("type").asText()).isEqualTo("error");
		assertThat(message.at("/payload/code").asText()).isEqualTo(code);
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
											.asText();
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

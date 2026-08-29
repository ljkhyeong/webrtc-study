package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.auth.RoomAccessPolicy;
import com.personal.round.auth.RoundAuthProperties;
import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TestProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import com.personal.round.protocol.ClientMessage;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

abstract class SignalingServiceTestSupport {

	static final String ROOM_ID = "abcd-efgh-jkmp";
	static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";
	static final String HOST_TOKEN =
			"round-test-only-host-capability-not-a-secret";
	static final String HOST_TOKEN_SHA256 =
			"de7ca4487720742a8acf93c4bd14b590f2753d370b5c2f13cc0cc09590e183ef";

	ObjectMapper objectMapper;
	ServerMessageEncoder serverMessageEncoder;
	MutableClock clock;
	MutableTicker monotonicTicker;
	SimpleMeterRegistry meterRegistry;
	ExecutorService outboundExecutor;
	private ConnectionAdmissionPolicy defaultAdmissionPolicy;
	private int nextTestClientAddress;
	SignalingService service;

	@BeforeEach
	void setUp() {
		objectMapper = new ObjectMapper();
		serverMessageEncoder = new ServerMessageEncoder(objectMapper);
		clock = new MutableClock(
				Instant.parse("2026-07-26T00:00:00Z"),
				ZoneOffset.UTC);
		monotonicTicker = new MutableTicker();
		meterRegistry = new SimpleMeterRegistry();
		outboundExecutor = Executors.newVirtualThreadPerTaskExecutor();
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

	void connect(TestPeer... peers) {
		for (TestPeer peer : peers) {
			attachDefaultReservation(peer);
			assertThat(service.connect(peer.session())).isTrue();
		}
	}

	void attachDefaultReservation(TestPeer peer) {
		ConnectionAdmissionPolicy.Admission admission = defaultAdmissionPolicy.reserve(
				new InetSocketAddress(
						"198.51.100." + nextTestClientAddress++,
						41_000),
				null);
		attachReservation(peer, acceptedReservation(admission));
	}

	ConnectionAdmissionPolicy admissionPolicy(SignalingProperties properties) {
		return new ConnectionAdmissionPolicy(
				properties,
				new SignalingMetrics(new SimpleMeterRegistry()),
				new ClientAddressKeyResolver());
	}

	void connectFrom(
			ConnectionAdmissionPolicy policy,
			String clientAddress,
			TestPeer... peers) {
		int port = 41_000;
		for (TestPeer peer : peers) {
			ConnectionAdmissionPolicy.Admission admission =
					policy.reserve(new InetSocketAddress(clientAddress, port++), null);
			attachReservation(peer, acceptedReservation(admission));
			assertThat(service.connect(peer.session())).isTrue();
		}
	}

	ClientMessage.Join join(String displayName) {
		return new ClientMessage.Join(ROOM_ID, null, displayName, null);
	}

	ClientMessage.Relay relay(String type, String roomId, String target) throws Exception {
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

	static SignalingProperties properties(int maxRoomSize) {
		return TestProperties.signaling(maxRoomSize);
	}

	SignalingService service(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		SignalingService started = newService(properties, registry);
		started.start();
		return started;
	}

	SignalingService newService(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		return newService(properties, registry, standaloneAuth());
	}

	SignalingService newService(
			SignalingProperties properties,
			SimpleMeterRegistry registry,
			RoundAuthProperties authProperties) {
		return new SignalingService(
				serverMessageEncoder,
				properties,
				new SignalingMetrics(registry),
				new RoomAccessPolicy(authProperties),
				outboundExecutor,
				clock,
				monotonicTicker);
	}

	SignalingService newBatonService(SimpleMeterRegistry registry) {
		return newBatonService(properties(6), registry);
	}

	SignalingService newBatonService(
			SignalingProperties properties,
			SimpleMeterRegistry registry) {
		return new SignalingService(
				serverMessageEncoder,
				properties,
				new SignalingMetrics(registry),
				new RoomAccessPolicy(batonAuth()),
				outboundExecutor,
				clock,
				monotonicTicker);
	}

	static RoundAuthProperties standaloneAuth() {
		return standaloneAuth(null);
	}

	static RoundAuthProperties standaloneAuth(String hostTokenSha256) {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.STANDALONE,
				"__Secure-round_access",
				null,
				"round",
				null,
				hostTokenSha256,
				Duration.ofMinutes(5));
	}

	private static RoundAuthProperties batonAuth() {
		return new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				"https://baton.example/oauth2",
				"round",
				"https://baton.example/oauth2/jwks",
				null,
				Duration.ofMinutes(5));
	}

	ParticipationGrant grantFor(String roomId) {
		return grantFor(
				roomId,
				"baton-user-1",
				"grant-1",
				clock.instant().plusSeconds(120));
	}

	ParticipationGrant grantFor(
			String roomId,
			String subject,
			String tokenId,
			Instant expiresAt) {
		return grantFor(
				roomId,
				subject,
				tokenId,
				expiresAt,
				ParticipationGrant.Role.PARTICIPANT);
	}

	ParticipationGrant grantFor(
			String roomId,
			String subject,
			String tokenId,
			Instant expiresAt,
			ParticipationGrant.Role role) {
		return new ParticipationGrant(
				subject,
				"study-1",
				roomId,
				role,
				tokenId,
				clock.instant().minusSeconds(1),
				expiresAt);
	}

	TestPeer peer(String id) throws Exception {
		return peer(id, null, null);
	}

	static void attachReservation(
			TestPeer peer,
			ConnectionAdmissionPolicy.Reservation reservation) {
		Map<String, Object> attributes = new HashMap<>();
		attributes.put(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		when(peer.session().getAttributes()).thenReturn(attributes);
	}

	static void attachGrantReservation(
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

	static ConnectionAdmissionPolicy.Reservation acceptedReservation(
			ConnectionAdmissionPolicy.Admission admission) {
		assertThat(admission).isInstanceOf(ConnectionAdmissionPolicy.Accepted.class);
		return ((ConnectionAdmissionPolicy.Accepted) admission).reservation();
	}

	static void awaitIgnoringInterrupts(CountDownLatch latch) {
		boolean interrupted = false;
		while (true) {
			try {
				latch.await();
				break;
			}
			catch (InterruptedException exception) {
				interrupted = true;
			}
		}
		if (interrupted) {
			Thread.currentThread().interrupt();
		}
	}

	TestPeer peer(
			String id,
			CountDownLatch firstSendEntered,
			CountDownLatch releaseFirstSend) throws Exception {
		WebSocketSession session = mock(WebSocketSession.class);
		List<WebSocketMessage<?>> messages = Collections.synchronizedList(new ArrayList<>());
		AtomicBoolean firstSend = new AtomicBoolean(true);
		AtomicBoolean failNextSend = new AtomicBoolean(false);
		AtomicReference<CloseStatus> closeStatus = new AtomicReference<>();
		when(session.getId()).thenReturn(id);
		when(session.getAttributes()).thenReturn(new HashMap<>());
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
			closeStatus.set(invocation.getArgument(0));
			return null;
		}).when(session).close(any(CloseStatus.class));
		return new TestPeer(session, messages, closeStatus, failNextSend, objectMapper);
	}

	static void assertError(JsonNode message, String code) {
		assertThat(message.get("type").asString()).isEqualTo("error");
		assertThat(message.at("/payload/code").asString()).isEqualTo(code);
	}

	static byte[] payloadBytes(PingMessage pingMessage) {
		var payload = pingMessage.getPayload().asReadOnlyBuffer();
		byte[] bytes = new byte[payload.remaining()];
		payload.get(bytes);
		return bytes;
	}

	static final class MutableClock extends Clock {

		private Instant instant;
		private final ZoneId zone;

		private MutableClock(Instant instant, ZoneId zone) {
			this.instant = instant;
			this.zone = zone;
		}

		void advanceMillis(long millis) {
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

	static final class MutableTicker implements LongSupplier {

		private final AtomicLong nanos = new AtomicLong();

		void advanceMillis(long millis) {
			nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis));
		}

		@Override
		public long getAsLong() {
			return nanos.get();
		}
	}

	record TestPeer(
			WebSocketSession session,
			List<WebSocketMessage<?>> messages,
			AtomicReference<CloseStatus> closeStatus,
			AtomicBoolean failNextSendFlag,
			ObjectMapper objectMapper) {

		JsonNode nextJson() throws Exception {
			return await().atMost(Duration.ofSeconds(2)).until(() -> {
				synchronized (messages) {
					for (int index = 0; index < messages.size(); index++) {
						WebSocketMessage<?> message = messages.get(index);
						if (message instanceof TextMessage textMessage) {
							messages.remove(index);
							return objectMapper.readTree(textMessage.getPayload());
						}
					}
				}
				return null;
			}, java.util.Objects::nonNull);
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
			await().atMost(Duration.ofSeconds(2)).until(() -> {
				synchronized (messages) {
					return messages.stream().anyMatch(predicate);
				}
			});
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
			await().atMost(Duration.ofSeconds(2)).until(() -> messages.size() >= expected);
		}

		void awaitClosed() {
			await().atMost(Duration.ofSeconds(2)).until(() -> closeStatus.get() != null);
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

		void assertNoTextMessageFor(Duration duration) {
			await().pollInterval(Duration.ofMillis(5))
					.during(duration)
					.atMost(duration.plusSeconds(1))
					.until(() -> {
						synchronized (messages) {
							return messages.stream().noneMatch(TextMessage.class::isInstance);
						}
					});
		}
	}

	static final class ObjectNodeFixture {

		private ObjectNodeFixture() {
		}

		static tools.jackson.databind.node.ObjectNode object(ObjectMapper mapper, String json)
				throws Exception {
			return (tools.jackson.databind.node.ObjectNode) mapper.readTree(json);
		}
	}
}

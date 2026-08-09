package com.personal.round;

import static org.awaitility.Awaitility.await;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.personal.round.signaling.SignalingWebSocketHandler;
import com.personal.round.signaling.SignalingService;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.Execution;
import org.junit.jupiter.api.parallel.ExecutionMode;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.auth.mode=baton",
			"round.auth.cookie-name=__Secure-round_access",
			"round.auth.audience=round",
			"round.auth.max-grant-lifetime=5m",
			"round.signaling.allowed-origins=http://localhost:5173",
			"round.signaling.heartbeat-interval=60s",
			"round.turn.urls=turn:turn.example.com:3478",
			"round.turn.shared-secret=integration-shared-secret",
			"round.turn.credential-ttl=1h",
			"round.turn.rate-limit-window=60s",
			"round.turn.rate-limit-max-requests=20",
			"round.turn.rate-limit-participant-max-requests=2",
			"round.turn.rate-limit-global-max-requests=40"
		})
@Execution(ExecutionMode.SAME_THREAD)
class BatonAuthBoundaryIntegrationTest {
	private static final String ACCOUNT_ID = "4c1e30a9-6d44-4f05-8f31-0f8a0f490042";

	private static final TestBatonIssuer BATON_ISSUER = TestBatonIssuer.start();
	private static final String COOKIE_NAME = "__Secure-round_access";
	private static final String ALLOWED_ORIGIN = "http://localhost:5173";
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";
	private static final String MATCHING_TOKEN =
			BATON_ISSUER.issueParticipationGrant(ROOM_ID, "ticket-1");
	private static final String RECONNECT_TOKEN =
			BATON_ISSUER.issueParticipationGrant(ROOM_ID, "ticket-2");
	private static final String EXCESS_TOKEN =
			BATON_ISSUER.issueParticipationGrant(ROOM_ID, "ticket-3");
	private static final String OTHER_ROOM_TOKEN =
			BATON_ISSUER.issueParticipationGrant(OTHER_ROOM_ID, "ticket-other-room");
	private static final String UNKNOWN_KEY_TOKEN = BATON_ISSUER.issueParticipationGrant(
			ROOM_ID,
			"ticket-unknown-key",
			"retired-baton-key");
	private static final String MALFORMED_KEY_TOKEN = BATON_ISSUER.issueParticipationGrant(
			ROOM_ID,
			"ticket-malformed-key",
			"../baton-key");
	private static final String EXTRA_AUDIENCE_TOKEN =
			BATON_ISSUER.issueParticipationGrant(
					ROOM_ID,
					"ticket-extra-audience",
					List.of("round", "other-service"));
	private static final String INVALID_TOKEN = "not-a-jwt";

	private final HttpClient httpClient = HttpClient.newHttpClient();
	private final ObjectMapper objectMapper = new ObjectMapper();

	@LocalServerPort
	private int port;

	@MockitoSpyBean
	private SignalingWebSocketHandler signalingWebSocketHandler;

	@Autowired
	private SignalingService signalingService;

	@DynamicPropertySource
	static void batonIssuerProperties(DynamicPropertyRegistry registry) {
		registry.add("round.auth.issuer", BATON_ISSUER::issuer);
		registry.add("round.auth.jwk-set-uri", BATON_ISSUER::jwkSetUri);
	}

	@AfterAll
	static void stopBatonIssuer() {
		BATON_ISSUER.close();
	}

	@Test
	void keepsHealthPublicEvenWhenTheParticipationCookieIsMissingOrInvalid() throws Exception {
		HttpResponse<String> withoutCookie = get("/healthz", null);
		HttpResponse<String> withInvalidCookie = get("/healthz", INVALID_TOKEN);

		assertThat(withoutCookie.statusCode()).isEqualTo(200);
		assertThat(withInvalidCookie.statusCode()).isEqualTo(200);
		assertThat(withoutCookie.body()).isEqualTo("{\"status\":\"ok\"}");
		assertThat(withInvalidCookie.body()).isEqualTo("{\"status\":\"ok\"}");
	}

	@Test
	void blocksStandaloneEndpointsInBatonModeEvenWithAValidParticipationCookie()
			throws Exception {
		HttpResponse<String> legacySignal = get("/signal", MATCHING_TOKEN);
		HttpResponse<String> legacyTurn = post(
				"/api/turn-credentials",
				MATCHING_TOKEN,
				origin(),
				"same-origin");

		assertThat(legacySignal.statusCode()).isEqualTo(403);
		assertThat(legacyTurn.statusCode()).isEqualTo(403);
	}

	@Test
	void protectsRoomScopedTurnIssuanceWithTicketRoomAndOriginBoundaries()
			throws Exception {
		String path = "/api/rooms/" + ROOM_ID + "/turn-credentials";

		HttpResponse<String> missingCookie = post(
				path,
				null,
				origin(),
				"same-origin");
		HttpResponse<String> otherRoom = post(
				path,
				OTHER_ROOM_TOKEN,
				origin(),
				"same-origin");
		HttpResponse<String> crossOrigin = post(
				path,
				MATCHING_TOKEN,
				"https://attacker.example",
				"cross-site");
		HttpResponse<String> issued = post(
				path,
				MATCHING_TOKEN,
				origin(),
				"same-origin");
		HttpResponse<String> refreshed = post(
				path,
				RECONNECT_TOKEN,
				origin(),
				"same-origin");
		HttpResponse<String> participantLimited = post(
				path,
				EXCESS_TOKEN,
				origin(),
				"same-origin");

		assertThat(missingCookie.statusCode()).isEqualTo(401);
		assertThat(missingCookie.headers().firstValue("cache-control")).contains("no-store");
		assertThat(otherRoom.statusCode()).isEqualTo(403);
		assertThat(otherRoom.headers().firstValue("cache-control")).contains("no-store");
		assertThat(crossOrigin.statusCode()).isEqualTo(403);
		assertThat(crossOrigin.headers().firstValue("cache-control")).contains("no-store");

		assertThat(issued.statusCode()).isEqualTo(200);
		assertThat(BATON_ISSUER.jwkRequestCount()).isPositive();
		assertThat(issued.headers().firstValue("cache-control")).contains("no-store");
		JsonNode credentials = objectMapper.readTree(issued.body());
		assertThat(credentials.at("/urls/0").asString())
				.isEqualTo("turn:turn.example.com:3478");
		assertThat(credentials.get("username").asString()).isNotBlank();
		assertThat(credentials.get("credential").asString())
				.isNotBlank()
				.doesNotContain("integration-shared-secret");
		assertThat(credentials.get("expiresAt").asLong())
				.isLessThanOrEqualTo(Instant.now().plusSeconds(250).getEpochSecond());
		assertThat(credentials.get("refreshAfterSeconds").asLong())
				.isBetween(1L, 220L);
		assertThat(refreshed.statusCode()).isEqualTo(200);
		assertThat(participantLimited.statusCode()).isEqualTo(429);
		assertThat(participantLimited.headers().firstValue("cache-control"))
				.contains("no-store");
		assertThat(participantLimited.headers().firstValue("retry-after")
				.map(Long::parseLong))
				.hasValueSatisfying(seconds -> assertThat(seconds).isBetween(1L, 60L));
		assertThat(participantLimited.body()).isEmpty();
	}

	@Test
	void rejectsUnsupportedAndMalformedKeyIdentifiersAsUnauthorized() throws Exception {
		String path = "/api/rooms/" + ROOM_ID + "/turn-credentials";

		HttpResponse<String> unknownKey = post(
				path,
				UNKNOWN_KEY_TOKEN,
				origin(),
				"same-origin");
		HttpResponse<String> malformedKey = post(
				path,
				MALFORMED_KEY_TOKEN,
				origin(),
				"same-origin");

		assertThat(unknownKey.statusCode()).isEqualTo(401);
		assertThat(unknownKey.headers().firstValue("cache-control"))
				.contains("no-store");
		assertThat(malformedKey.statusCode()).isEqualTo(401);
		assertThat(malformedKey.headers().firstValue("cache-control"))
				.contains("no-store");
	}

	@Test
	void rejectsAnAdditionalAudienceAtTurnAndWebSocketBoundaries() throws Exception {
		String turnPath = "/api/rooms/" + ROOM_ID + "/turn-credentials";
		HttpResponse<String> turnResponse = post(
				turnPath,
				EXTRA_AUDIENCE_TOKEN,
				origin(),
				"same-origin");

		assertThat(turnResponse.statusCode()).isEqualTo(401);
		assertThat(turnResponse.headers().firstValue("cache-control"))
				.contains("no-store");
		assertWebSocketRejected(
				"/rooms/" + ROOM_ID + "/signal",
				EXTRA_AUDIENCE_TOKEN,
				ALLOWED_ORIGIN,
				"401");
	}

	@Test
	void admitsOnlyTheTicketRoomAtTheWebSocketAndJoinBoundaries() throws Exception {
		CompletableFuture<String> responseMessage = new CompletableFuture<>();
		TextWebSocketHandler handler = new TextWebSocketHandler() {
			@Override
			protected void handleTextMessage(
					WebSocketSession session,
					TextMessage message) {
				responseMessage.complete(message.getPayload());
			}
		};

		WebSocketSession session = connect(
				handler,
				"/rooms/" + ROOM_ID + "/signal",
				MATCHING_TOKEN);
		try {
			ArgumentCaptor<WebSocketSession> serverSessionCaptor =
					ArgumentCaptor.forClass(WebSocketSession.class);
			verify(signalingWebSocketHandler, timeout(2_000))
					.afterConnectionEstablished(serverSessionCaptor.capture());
			WebSocketSession serverSession = serverSessionCaptor.getValue();
			assertThat(serverSession.getHandshakeHeaders().containsHeader(HttpHeaders.COOKIE))
					.isFalse();
			assertThat(serverSession.getHandshakeHeaders().toString())
					.doesNotContain(MATCHING_TOKEN);
			assertThat(serverSession).isInstanceOf(NativeWebSocketSession.class);
			jakarta.websocket.Session nativeSession =
					((NativeWebSocketSession) serverSession)
							.getNativeSession(jakarta.websocket.Session.class);
			assertThat(nativeSession).isNotNull();
			assertThat(nativeSession.getUserPrincipal())
					.isNotInstanceOf(JwtAuthenticationToken.class)
					.extracting(java.security.Principal::getName)
					.isEqualTo(ACCOUNT_ID);
			assertThat(nativeSession.getUserPrincipal().toString())
					.doesNotContain(MATCHING_TOKEN, ACCOUNT_ID);

			session.sendMessage(new TextMessage("""
					{"v":3,"type":"room.join","roomId":"%s","requestId":"join-1","payload":{"displayName":"스터디원"}}
					""".formatted(ROOM_ID).trim()));

			JsonNode joined = objectMapper.readTree(responseMessage.get(2, TimeUnit.SECONDS));
			assertThat(joined.get("type").asString()).isEqualTo("room.joined");
			assertThat(joined.get("roomId").asString()).isEqualTo(ROOM_ID);
			assertThat(joined.get("requestId").asString()).isEqualTo("join-1");
		}
		finally {
			session.close();
		}
		awaitConnectedPeers(0);

		String matchingPath = "/rooms/" + ROOM_ID + "/signal";
		assertWebSocketRejected(matchingPath, null, ALLOWED_ORIGIN, "401");
		assertWebSocketRejected(matchingPath, INVALID_TOKEN, ALLOWED_ORIGIN, "401");
		assertWebSocketRejected(matchingPath, MATCHING_TOKEN, null, "403");
		assertWebSocketRejected(
				matchingPath,
				MATCHING_TOKEN,
				"https://attacker.example",
				"403");
		assertWebSocketRejected(
				"/rooms/" + OTHER_ROOM_ID + "/signal",
				MATCHING_TOKEN,
				ALLOWED_ORIGIN,
				"403");
	}

	@Test
	void rejectsRoomJoinOutsideTheSignedGrantWithoutCreatingRoomState() throws Exception {
		CompletableFuture<String> responseMessage = new CompletableFuture<>();
		TextWebSocketHandler handler = new TextWebSocketHandler() {
			@Override
			protected void handleTextMessage(
					WebSocketSession session,
					TextMessage message) {
				responseMessage.complete(message.getPayload());
			}
		};

		WebSocketSession session = connect(
				handler,
				"/rooms/" + ROOM_ID + "/signal",
				MATCHING_TOKEN);
		try {
			session.sendMessage(new TextMessage("""
					{"v":3,"type":"room.join","roomId":"%s","requestId":"join-wrong-room","payload":{"displayName":"스터디원"}}
					""".formatted(OTHER_ROOM_ID).trim()));

			JsonNode rejected = objectMapper.readTree(
					responseMessage.get(2, TimeUnit.SECONDS));
			assertThat(rejected.get("type").asString()).isEqualTo("error");
			assertThat(rejected.get("roomId").asString()).isEqualTo(OTHER_ROOM_ID);
			assertThat(rejected.get("requestId").asString())
					.isEqualTo("join-wrong-room");
			assertThat(rejected.at("/payload/code").asString())
					.isEqualTo("ROOM_MISMATCH");
			assertThat(signalingService.roomCount()).isZero();
		}
		finally {
			session.close();
		}
		awaitConnectedPeers(0);
	}

	@Test
	void rejectsParticipationTokenReplayAndCapsFreshGrantReconnectOverlap()
			throws Exception {
		String path = "/rooms/" + ROOM_ID + "/signal";
		WebSocketSession initial = connect(
				new TextWebSocketHandler(),
				path,
				MATCHING_TOKEN);
		try {
			awaitConnectedPeers(1);
			assertWebSocketRejected(
					path,
					MATCHING_TOKEN,
					ALLOWED_ORIGIN,
					"429");
		}
		finally {
			initial.close();
		}
		awaitConnectedPeers(0);

		WebSocketSession current = connect(
				new TextWebSocketHandler(),
				path,
				MATCHING_TOKEN);
		WebSocketSession reconnect = connect(
				new TextWebSocketHandler(),
				path,
				RECONNECT_TOKEN);
		try {
			awaitConnectedPeers(2);
			assertWebSocketRejected(
					path,
					EXCESS_TOKEN,
					ALLOWED_ORIGIN,
					"429");
		}
		finally {
			current.close();
			reconnect.close();
		}
		awaitConnectedPeers(0);

		WebSocketSession replacement = connect(
				new TextWebSocketHandler(),
				path,
				EXCESS_TOKEN);
		try {
			awaitConnectedPeers(1);
		}
		finally {
			replacement.close();
		}
		awaitConnectedPeers(0);
	}

	private HttpResponse<String> get(String path, String token) throws Exception {
		HttpRequest.Builder request = HttpRequest.newBuilder()
				.uri(URI.create(origin() + path))
				.GET();
		addCookie(request, token);
		return httpClient.send(request.build(), HttpResponse.BodyHandlers.ofString());
	}

	private HttpResponse<String> post(
			String path,
			String token,
			String requestOrigin,
			String fetchSite) throws Exception {
		HttpRequest.Builder request = HttpRequest.newBuilder()
				.uri(URI.create(origin() + path))
				.header(HttpHeaders.ORIGIN, requestOrigin)
				.header("Sec-Fetch-Site", fetchSite)
				.POST(HttpRequest.BodyPublishers.noBody());
		addCookie(request, token);
		return httpClient.send(request.build(), HttpResponse.BodyHandlers.ofString());
	}

	private WebSocketSession connect(
			TextWebSocketHandler handler,
			String path,
			String token) throws Exception {
		return connect(handler, path, token, ALLOWED_ORIGIN);
	}

	private WebSocketSession connect(
			TextWebSocketHandler handler,
			String path,
			String token,
			String requestOrigin) throws Exception {
		WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
		if (requestOrigin != null) {
			headers.setOrigin(requestOrigin);
		}
		if (token != null) {
			headers.add(HttpHeaders.COOKIE, COOKIE_NAME + "=" + token);
		}
		return new StandardWebSocketClient()
				.execute(handler, headers, URI.create(webSocketOrigin() + path))
				.get(2, TimeUnit.SECONDS);
	}

	private void assertWebSocketRejected(
			String path,
			String token,
			String requestOrigin,
			String expectedStatus) {
		assertThatThrownBy(() -> connect(
				new TextWebSocketHandler(),
				path,
				token,
				requestOrigin))
				.hasStackTraceContaining(expectedStatus);
	}

	private static void addCookie(HttpRequest.Builder request, String token) {
		if (token != null) {
			request.header(HttpHeaders.COOKIE, COOKIE_NAME + "=" + token);
		}
	}

	private void awaitConnectedPeers(int expected) {
		await().atMost(Duration.ofSeconds(2))
				.untilAsserted(() -> assertThat(signalingService.connectedPeerCount())
						.isEqualTo(expected));
	}

	private String origin() {
		return "http://127.0.0.1:" + port;
	}

	private String webSocketOrigin() {
		return "ws://127.0.0.1:" + port;
	}

	private static final class TestBatonIssuer implements AutoCloseable {

		private static final String KEY_ID = "baton-integration-key";

		private final HttpServer server;
		private final KeyPair signingKey;
		private final String issuer;
		private final AtomicInteger jwkRequestCount = new AtomicInteger();

		private TestBatonIssuer(
				HttpServer server,
				KeyPair signingKey,
				String issuer) {
			this.server = server;
			this.signingKey = signingKey;
			this.issuer = issuer;
		}

		static TestBatonIssuer start() {
			try {
				KeyPair signingKey = rsaKeyPair();
				RSAKey publicJwk = new RSAKey.Builder(
						(RSAPublicKey) signingKey.getPublic())
						.keyID(KEY_ID)
						.algorithm(JWSAlgorithm.RS256)
						.build();
				byte[] jwkSet = new JWKSet(publicJwk)
						.toString()
						.getBytes(StandardCharsets.UTF_8);
				HttpServer server = HttpServer.create(
						new InetSocketAddress("127.0.0.1", 0),
						0);
				String issuer = "http://127.0.0.1:"
						+ server.getAddress().getPort()
						+ "/oauth2";
				TestBatonIssuer testIssuer =
						new TestBatonIssuer(server, signingKey, issuer);
				server.createContext("/oauth2/jwks", exchange -> {
					testIssuer.jwkRequestCount.incrementAndGet();
					exchange.getResponseHeaders().set(
							HttpHeaders.CONTENT_TYPE,
							"application/json");
					exchange.sendResponseHeaders(200, jwkSet.length);
					try (var responseBody = exchange.getResponseBody()) {
						responseBody.write(jwkSet);
					}
				});
				server.start();
				return testIssuer;
			}
			catch (Exception exception) {
				throw new IllegalStateException(
						"Could not start the BATON test issuer",
						exception);
			}
		}

		String issuer() {
			return issuer;
		}

		String jwkSetUri() {
			return issuer + "/jwks";
		}

		int jwkRequestCount() {
			return jwkRequestCount.get();
		}

		String issueParticipationGrant(String roomId, String tokenId) {
			return issueParticipationGrant(roomId, tokenId, KEY_ID);
		}

		String issueParticipationGrant(
				String roomId,
				String tokenId,
				List<String> audiences) {
			return issueParticipationGrant(roomId, tokenId, KEY_ID, audiences);
		}

		String issueParticipationGrant(String roomId, String tokenId, String keyId) {
			return issueParticipationGrant(roomId, tokenId, keyId, List.of("round"));
		}

		String issueParticipationGrant(
				String roomId,
				String tokenId,
				String keyId,
				List<String> audiences) {
			try {
				Instant now = Instant.now();
				JWTClaimsSet claims = new JWTClaimsSet.Builder()
						.issuer(issuer)
						.subject(ACCOUNT_ID)
						.audience(audiences)
						.issueTime(Date.from(now.minusSeconds(30)))
						.expirationTime(Date.from(now.plusSeconds(240)))
						.jwtID(tokenId)
						.claim("study_id", "study-7")
						.claim("room_id", roomId)
						.claim("role", "participant")
						.build();
				SignedJWT token = new SignedJWT(
						new JWSHeader.Builder(JWSAlgorithm.RS256)
								.type(JOSEObjectType.JWT)
								.keyID(keyId)
								.build(),
						claims);
				token.sign(new RSASSASigner(signingKey.getPrivate()));
				return token.serialize();
			}
			catch (Exception exception) {
				throw new IllegalStateException(
						"Could not sign a BATON participation grant",
						exception);
			}
		}

		private static KeyPair rsaKeyPair() throws Exception {
			KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
			generator.initialize(2_048);
			return generator.generateKeyPair();
		}

		@Override
		public void close() {
			server.stop(0);
		}
	}
}

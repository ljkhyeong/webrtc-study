package com.personal.round;

import static org.awaitility.Awaitility.await;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.signaling.SignalingWebSocketHandler;
import com.personal.round.signaling.SignalingService;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
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
			"round.auth.issuer=https://baton.example/oauth2",
			"round.auth.audience=round",
			"round.auth.jwk-set-uri=https://baton.example/oauth2/jwks",
			"round.auth.max-grant-lifetime=5m",
			"round.signaling.allowed-origins=http://localhost:5173",
			"round.signaling.heartbeat-interval=60s",
			"round.turn.urls=turn:turn.example.com:3478",
			"round.turn.shared-secret=integration-shared-secret",
			"round.turn.credential-ttl=1h",
			"round.turn.rate-limit-window=60s",
			"round.turn.rate-limit-max-requests=20",
			"round.turn.rate-limit-global-max-requests=40"
		})
class BatonAuthBoundaryIntegrationTest {

	private static final String COOKIE_NAME = "__Secure-round_access";
	private static final String ALLOWED_ORIGIN = "http://localhost:5173";
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final String OTHER_ROOM_ID = "qrst-uvwx-yz23";
	private static final String MATCHING_TOKEN = "matching-room-ticket";
	private static final String RECONNECT_TOKEN = "reconnect-room-ticket";
	private static final String EXCESS_TOKEN = "excess-room-ticket";
	private static final String OTHER_ROOM_TOKEN = "other-room-ticket";
	private static final String INVALID_TOKEN = "invalid-ticket";

	private final HttpClient httpClient = HttpClient.newHttpClient();
	private final ObjectMapper objectMapper = new ObjectMapper();

	@LocalServerPort
	private int port;

	@MockitoBean
	private JwtDecoder jwtDecoder;

	@MockitoSpyBean
	private SignalingWebSocketHandler signalingWebSocketHandler;

	@Autowired
	private SignalingService signalingService;

	@BeforeEach
	void setUpDecoder() {
		when(jwtDecoder.decode(MATCHING_TOKEN))
				.thenReturn(participationJwt(
						MATCHING_TOKEN,
						ROOM_ID,
						"ticket-1"));
		when(jwtDecoder.decode(RECONNECT_TOKEN))
				.thenReturn(participationJwt(
						RECONNECT_TOKEN,
						ROOM_ID,
						"ticket-2"));
		when(jwtDecoder.decode(EXCESS_TOKEN))
				.thenReturn(participationJwt(
						EXCESS_TOKEN,
						ROOM_ID,
						"ticket-3"));
		when(jwtDecoder.decode(OTHER_ROOM_TOKEN))
				.thenReturn(participationJwt(
						OTHER_ROOM_TOKEN,
						OTHER_ROOM_ID,
						"ticket-other-room"));
		when(jwtDecoder.decode(INVALID_TOKEN))
				.thenThrow(new BadJwtException("invalid test participation ticket"));
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

		assertThat(missingCookie.statusCode()).isEqualTo(401);
		assertThat(missingCookie.headers().firstValue("cache-control")).contains("no-store");
		assertThat(otherRoom.statusCode()).isEqualTo(403);
		assertThat(otherRoom.headers().firstValue("cache-control")).contains("no-store");
		assertThat(crossOrigin.statusCode()).isEqualTo(403);
		assertThat(crossOrigin.headers().firstValue("cache-control")).contains("no-store");

		assertThat(issued.statusCode()).isEqualTo(200);
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
					.isEqualTo("member-42");
			assertThat(nativeSession.getUserPrincipal().toString())
					.doesNotContain(MATCHING_TOKEN, "member-42");

			session.sendMessage(new TextMessage("""
					{"v":2,"type":"room.join","roomId":"%s","requestId":"join-1","payload":{"displayName":"스터디원"}}
					""".formatted(ROOM_ID).trim()));

			JsonNode joined = objectMapper.readTree(responseMessage.get(2, TimeUnit.SECONDS));
			assertThat(joined.get("type").asString()).isEqualTo("room.joined");
			assertThat(joined.get("roomId").asString()).isEqualTo(ROOM_ID);
			assertThat(joined.get("requestId").asString()).isEqualTo("join-1");
		}
		finally {
			session.close();
		}

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

	private static Jwt participationJwt(
			String tokenValue,
			String roomId,
			String tokenId) {
		Instant now = Instant.now();
		return Jwt.withTokenValue(tokenValue)
				.header("alg", "RS256")
				.issuer("https://baton.example/oauth2")
				.subject("member-42")
				.audience(List.of("round"))
				.issuedAt(now.minusSeconds(30))
				.expiresAt(now.plusSeconds(240))
				.claim("jti", tokenId)
				.claim("study_id", "study-7")
				.claim("room_id", roomId)
				.claim("role", "participant")
				.build();
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
}

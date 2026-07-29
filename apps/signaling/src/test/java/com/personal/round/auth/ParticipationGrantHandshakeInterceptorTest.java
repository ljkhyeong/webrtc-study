package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.OTHER_ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.authentication;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.security.Principal;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;

class ParticipationGrantHandshakeInterceptorTest {

	private final ParticipationGrantHandshakeInterceptor interceptor =
			new ParticipationGrantHandshakeInterceptor(new ParticipationGrantResolver());

	@Test
	void carriesTheVerifiedGrantIntoTheMatchingRoomSession() {
		Map<String, Object> attributes = new HashMap<>();
		ServerHttpRequest request = request(
				"/rooms/" + ROOM_ID + "/signal",
				authentication());

		assertThat(handshake(request, mock(ServerHttpResponse.class), attributes)).isTrue();
		assertThat(attributes)
				.containsEntry(
						ParticipationGrant.SESSION_ATTRIBUTE,
						ParticipationGrantTestFixtures.grant());
	}

	@Test
	void rejectsAValidGrantForAnotherRoom() {
		Map<String, Object> attributes = new HashMap<>();
		ServerHttpResponse response = response();

		assertThat(handshake(
				request("/rooms/" + OTHER_ROOM_ID + "/signal", authentication()),
				response,
				attributes)).isFalse();
		verify(response).setStatusCode(HttpStatus.FORBIDDEN);
		assertThat(attributes).doesNotContainKey(ParticipationGrant.SESSION_ATTRIBUTE);
	}

	@Test
	void rejectsMissingPrincipalAndNonSignalingPaths() {
		ServerHttpResponse missingPrincipalResponse = response();
		assertThat(handshake(
				request("/rooms/" + ROOM_ID + "/signal", null),
				missingPrincipalResponse,
				new HashMap<>())).isFalse();
		verify(missingPrincipalResponse).setStatusCode(HttpStatus.FORBIDDEN);

		ServerHttpResponse wrongPathResponse = response();
		assertThat(handshake(
				request("/signal", authentication()),
				wrongPathResponse,
				new HashMap<>())).isFalse();
		verify(wrongPathResponse).setStatusCode(HttpStatus.FORBIDDEN);
	}

	private static ServerHttpRequest request(String path, Principal principal) {
		ServerHttpRequest request = mock(ServerHttpRequest.class);
		when(request.getURI()).thenReturn(URI.create("https://round.example" + path));
		when(request.getPrincipal()).thenReturn(principal);
		return request;
	}

	private static ServerHttpResponse response() {
		ServerHttpResponse response = mock(ServerHttpResponse.class);
		when(response.getHeaders()).thenReturn(new HttpHeaders());
		return response;
	}

	private boolean handshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			Map<String, Object> attributes) {
		return interceptor.beforeHandshake(
				request,
				response,
				mock(WebSocketHandler.class),
				attributes);
	}
}

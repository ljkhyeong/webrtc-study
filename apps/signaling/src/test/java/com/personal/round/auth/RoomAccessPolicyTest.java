package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.OTHER_ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.ROOM_ID;
import static com.personal.round.auth.ParticipationGrantTestFixtures.batonProperties;
import static com.personal.round.auth.ParticipationGrantTestFixtures.grant;
import static com.personal.round.auth.ParticipationGrantTestFixtures.standaloneProperties;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

class RoomAccessPolicyTest {

	@Test
	void standaloneModeAllowsAnyRoomWithoutSessionAuthenticationAttributes() {
		RoomAccessPolicy policy = new RoomAccessPolicy(standaloneProperties());
		WebSocketSession session = mock(WebSocketSession.class);
		when(session.getAttributes()).thenReturn(null);

		RoomAccess access = policy.resolve(session).orElseThrow();

		assertThat(access.allows(ROOM_ID)).isTrue();
		assertThat(access.allows(OTHER_ROOM_ID)).isTrue();
	}

	@Test
	void batonModeAllowsOnlyTheRoomCarriedByTheVerifiedGrant() {
		RoomAccessPolicy policy = new RoomAccessPolicy(batonProperties());
		WebSocketSession session = sessionWith(Map.of(
				ParticipationGrant.SESSION_ATTRIBUTE,
				grant()));

		RoomAccess access = policy.resolve(session).orElseThrow();

		assertThat(access.allows(ROOM_ID)).isTrue();
		assertThat(access.allows(OTHER_ROOM_ID)).isFalse();
	}

	@Test
	void batonModeFailsClosedForMissingOrWronglyTypedGrantAttributes() {
		RoomAccessPolicy policy = new RoomAccessPolicy(batonProperties());

		assertThat(policy.resolve(sessionWith(new HashMap<>()))).isEmpty();
		assertThat(policy.resolve(sessionWith(Map.of(
				ParticipationGrant.SESSION_ATTRIBUTE,
				"unverified")))).isEmpty();

		WebSocketSession nullAttributes = mock(WebSocketSession.class);
		when(nullAttributes.getAttributes()).thenReturn(null);
		assertThat(policy.resolve(nullAttributes)).isEmpty();
	}

	private static WebSocketSession sessionWith(Map<String, Object> attributes) {
		WebSocketSession session = mock(WebSocketSession.class);
		when(session.getAttributes()).thenReturn(attributes);
		return session;
	}
}

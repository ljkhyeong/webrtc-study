package com.personal.round.auth;

import static com.personal.round.auth.ParticipationGrantTestFixtures.EXPIRES_AT;
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
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

class RoomAccessPolicyTest {
	private static final String HOST_TOKEN =
			"round-test-only-host-capability-not-a-secret";
	private static final String HOST_TOKEN_SHA256 =
			"de7ca4487720742a8acf93c4bd14b590f2753d370b5c2f13cc0cc09590e183ef";

	@Test
	void standaloneModeAllowsAnyRoomWithoutSessionAuthenticationAttributes() {
		RoomAccessPolicy policy = new RoomAccessPolicy(standaloneProperties());
		WebSocketSession session = mock(WebSocketSession.class);

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
	}

	@Test
	void batonLeaseTreatsExpirationAsExclusiveAndKeepsItsOriginalDuration() {
		long expiresAtMillis = EXPIRES_AT.toEpochMilli();
		long connectedAtNanos = 100;
		RoomAccess.Lease lease = grant().openLease(
				expiresAtMillis - 1,
				connectedAtNanos);

		assertThat(lease.isExpired(expiresAtMillis - 1, connectedAtNanos)).isFalse();
		assertThat(lease.isExpired(expiresAtMillis, connectedAtNanos)).isTrue();
		assertThat(lease.isExpired(
				expiresAtMillis - 10_000,
				connectedAtNanos + TimeUnit.MILLISECONDS.toNanos(1))).isTrue();
	}

	@Test
	void standaloneLeaseNeverExpires() {
		RoomAccess access = new RoomAccessPolicy(standaloneProperties())
				.resolve(sessionWith(new HashMap<>()))
				.orElseThrow();
		RoomAccess.Lease lease = access.openLease(0, 0);

		assertThat(lease.isExpired(Long.MAX_VALUE, Long.MAX_VALUE)).isFalse();
	}

	@Test
	void standaloneRoleRequiresTheConfiguredHighEntropyHostCapability() {
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.STANDALONE,
				"round_access",
				null,
				"round",
				null,
				HOST_TOKEN_SHA256,
				Duration.ofMinutes(5));
		RoomAccess access = new RoomAccessPolicy(properties)
				.resolve(sessionWith(new HashMap<>()))
				.orElseThrow();

		assertThat(access.roleFor(null)).contains(ParticipationGrant.Role.PARTICIPANT);
		assertThat(access.roleFor(HOST_TOKEN)).contains(ParticipationGrant.Role.HOST);
		assertThat(access.roleFor("too-short")).isEmpty();
		assertThat(access.roleFor("f".repeat(64))).isEmpty();
	}

	@Test
	void batonRoleComesOnlyFromTheVerifiedGrant() {
		RoomAccess access = new RoomAccessPolicy(batonProperties())
				.resolve(sessionWith(Map.of(
						ParticipationGrant.SESSION_ATTRIBUTE,
						grant())))
				.orElseThrow();

		assertThat(access.roleFor(null)).contains(ParticipationGrant.Role.PARTICIPANT);
		assertThat(access.roleFor(HOST_TOKEN)).isEmpty();
	}

	private static WebSocketSession sessionWith(Map<String, Object> attributes) {
		WebSocketSession session = mock(WebSocketSession.class);
		when(session.getAttributes()).thenReturn(attributes);
		return session;
	}
}

package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

final class TurnIssuanceLimiter {

	private final Map<String, IssuanceWindow> clientWindows = new HashMap<>();
	private final Map<ParticipantRoomKey, IssuanceWindow> participantWindows =
			new HashMap<>();
	private final long windowMillis;
	private final int maxRequestsPerClient;
	private final int maxRequestsPerParticipant;
	private final int maxRequestsGlobal;
	private final int maxTrackedClients;
	private final int maxTrackedParticipants;
	private IssuanceWindow globalWindow;

	TurnIssuanceLimiter(TurnProperties properties) {
		this.windowMillis = properties.rateLimitWindow().toMillis();
		this.maxRequestsPerClient = properties.rateLimitMaxRequests();
		this.maxRequestsPerParticipant =
				properties.rateLimitParticipantMaxRequests();
		this.maxRequestsGlobal = properties.rateLimitGlobalMaxRequests();
		this.maxTrackedClients = properties.rateLimitMaxClients();
		this.maxTrackedParticipants = properties.rateLimitMaxParticipants();
	}

	synchronized Acquisition tryAcquire(
			String clientKey,
			ParticipantRoomKey participantKey,
			long nowMillis) {
		Objects.requireNonNull(clientKey, "clientKey must not be null");
		removeExpiredWindows(clientWindows, nowMillis);
		removeExpiredWindows(participantWindows, nowMillis);
		if (globalWindow != null && globalWindow.isExpired(nowMillis, windowMillis)) {
			globalWindow = null;
		}

		IssuanceWindow clientWindow = clientWindows.get(clientKey);
		IssuanceWindow participantWindow = participantKey == null
				? null
				: participantWindows.get(participantKey);
		Rejected rejection = null;

		if (participantWindow != null
				&& participantWindow.issued >= maxRequestsPerParticipant) {
			rejection = laterRejection(
					rejection,
					participantWindow.retryAfterMillis(nowMillis, windowMillis),
					TurnCredentialRateLimitScope.PARTICIPANT);
		}
		if (clientWindow != null && clientWindow.issued >= maxRequestsPerClient) {
			rejection = laterRejection(
					rejection,
					clientWindow.retryAfterMillis(nowMillis, windowMillis),
					TurnCredentialRateLimitScope.CLIENT);
		}
		if (globalWindow != null && globalWindow.issued >= maxRequestsGlobal) {
			rejection = laterRejection(
					rejection,
					globalWindow.retryAfterMillis(nowMillis, windowMillis),
					TurnCredentialRateLimitScope.GLOBAL);
		}
		if (participantKey != null
				&& participantWindow == null
				&& participantWindows.size() >= maxTrackedParticipants) {
			rejection = laterRejection(
					rejection,
					retryAfterCapacityMillis(participantWindows, nowMillis),
					TurnCredentialRateLimitScope.PARTICIPANT_STATE_CAPACITY);
		}
		if (clientWindow == null && clientWindows.size() >= maxTrackedClients) {
			rejection = laterRejection(
					rejection,
					retryAfterCapacityMillis(clientWindows, nowMillis),
					TurnCredentialRateLimitScope.CLIENT_STATE_CAPACITY);
		}
		if (rejection != null) {
			return rejection;
		}

		if (clientWindow == null) {
			clientWindow = new IssuanceWindow(nowMillis);
			clientWindows.put(clientKey, clientWindow);
		}
		if (participantKey != null && participantWindow == null) {
			participantWindow = new IssuanceWindow(nowMillis);
			participantWindows.put(participantKey, participantWindow);
		}
		if (globalWindow == null) {
			globalWindow = new IssuanceWindow(nowMillis);
		}
		clientWindow.issued++;
		if (participantWindow != null) {
			participantWindow.issued++;
		}
		globalWindow.issued++;
		return Acquired.INSTANCE;
	}

	synchronized int trackedClientCount() {
		return clientWindows.size();
	}

	synchronized int trackedParticipantCount() {
		return participantWindows.size();
	}

	private <K> void removeExpiredWindows(
			Map<K, IssuanceWindow> windows,
			long nowMillis) {
		windows.values().removeIf(window -> window.isExpired(nowMillis, windowMillis));
	}

	private <K> long retryAfterCapacityMillis(
			Map<K, IssuanceWindow> windows,
			long nowMillis) {
		return windows.values().stream()
				.mapToLong(window -> window.retryAfterMillis(nowMillis, windowMillis))
				.min()
				.orElseThrow();
	}

	private static Rejected laterRejection(
			Rejected current,
			long retryAfterMillis,
			TurnCredentialRateLimitScope scope) {
		if (current == null
				|| retryAfterMillis > current.retryAfterMillis()
				|| (retryAfterMillis == current.retryAfterMillis()
						&& scope.priority() > current.scope().priority())) {
			return new Rejected(retryAfterMillis, scope);
		}
		return current;
	}

	sealed interface Acquisition permits Acquired, Rejected {
	}

	enum Acquired implements Acquisition {
		INSTANCE
	}

	record Rejected(
			long retryAfterMillis,
			TurnCredentialRateLimitScope scope)
			implements Acquisition {

		Rejected {
			if (retryAfterMillis < 1) {
				throw new IllegalArgumentException("retryAfterMillis must be positive");
			}
			Objects.requireNonNull(scope, "scope must not be null");
		}

		long retryAfterSeconds() {
			return Math.max(1, Math.ceilDiv(retryAfterMillis, 1_000));
		}
	}

	private static final class IssuanceWindow {

		private final long startedAtMillis;
		private int issued;

		private IssuanceWindow(long startedAtMillis) {
			this.startedAtMillis = startedAtMillis;
		}

		private boolean isExpired(long nowMillis, long windowMillis) {
			return nowMillis >= startedAtMillis
					&& nowMillis - startedAtMillis >= windowMillis;
		}

		private long retryAfterMillis(long nowMillis, long windowMillis) {
			long elapsedMillis = Math.max(0, nowMillis - startedAtMillis);
			return Math.max(1, windowMillis - elapsedMillis);
		}
	}
}

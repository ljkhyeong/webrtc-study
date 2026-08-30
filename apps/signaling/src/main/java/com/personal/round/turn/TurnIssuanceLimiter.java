package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.util.HashMap;
import java.util.Map;

final class TurnIssuanceLimiter {

	private static final long NANOS_PER_SECOND = 1_000_000_000L;

	private final Map<String, IssuanceWindow> clientWindows = new HashMap<>();
	private final Map<ParticipantRoomKey, IssuanceWindow> participantWindows =
			new HashMap<>();
	private final long windowNanos;
	private final int maxRequestsPerClient;
	private final int maxRequestsPerParticipant;
	private final int maxRequestsGlobal;
	private final int maxTrackedClients;
	private final int maxTrackedParticipants;
	private IssuanceWindow globalWindow;

	TurnIssuanceLimiter(TurnProperties properties) {
		this.windowNanos = properties.rateLimitWindow().toNanos();
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
			long nowNanos) {
		removeExpiredWindows(clientWindows, nowNanos);
		removeExpiredWindows(participantWindows, nowNanos);
		if (globalWindow != null && globalWindow.isExpired(nowNanos, windowNanos)) {
			globalWindow = null;
		}

		IssuanceWindow clientWindow = clientWindows.get(clientKey);
		IssuanceWindow participantWindow = participantKey == null
				? null
				: participantWindows.get(participantKey);
		Rejected rejection = null;

		if (participantWindow != null
				&& participantWindow.attempts >= maxRequestsPerParticipant) {
			rejection = laterRejection(
					rejection,
					participantWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.PARTICIPANT);
		}
		if (clientWindow != null && clientWindow.attempts >= maxRequestsPerClient) {
			rejection = laterRejection(
					rejection,
					clientWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.CLIENT);
		}
		if (globalWindow != null && globalWindow.attempts >= maxRequestsGlobal) {
			rejection = laterRejection(
					rejection,
					globalWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.GLOBAL);
		}
		if (participantKey != null
				&& participantWindow == null
				&& participantWindows.size() >= maxTrackedParticipants) {
			rejection = laterRejection(
					rejection,
					retryAfterCapacityNanos(participantWindows, nowNanos),
					TurnCredentialRateLimitScope.PARTICIPANT_STATE_CAPACITY);
		}
		if (clientWindow == null && clientWindows.size() >= maxTrackedClients) {
			rejection = laterRejection(
					rejection,
					retryAfterCapacityNanos(clientWindows, nowNanos),
					TurnCredentialRateLimitScope.CLIENT_STATE_CAPACITY);
		}
		if (rejection != null) {
			return rejection;
		}

		clientWindow = clientWindows.computeIfAbsent(
				clientKey,
				ignored -> new IssuanceWindow(nowNanos));
		if (participantKey != null) {
			participantWindow = participantWindows.computeIfAbsent(
					participantKey,
					ignored -> new IssuanceWindow(nowNanos));
		}
		if (globalWindow == null) {
			globalWindow = new IssuanceWindow(nowNanos);
		}
		clientWindow.attempts++;
		if (participantWindow != null) {
			participantWindow.attempts++;
		}
		globalWindow.attempts++;
		return Acquired.INSTANCE;
	}

	private <K> void removeExpiredWindows(
			Map<K, IssuanceWindow> windows,
			long nowNanos) {
		windows.values().removeIf(window -> window.isExpired(nowNanos, windowNanos));
	}

	private <K> long retryAfterCapacityNanos(
			Map<K, IssuanceWindow> windows,
			long nowNanos) {
		return windows.values().stream()
				.mapToLong(window -> window.retryAfterNanos(nowNanos, windowNanos))
				.min()
				.orElseThrow();
	}

	private static Rejected laterRejection(
			Rejected current,
			long retryAfterNanos,
			TurnCredentialRateLimitScope scope) {
		if (current == null
				|| retryAfterNanos > current.retryAfterNanos()
				|| (retryAfterNanos == current.retryAfterNanos()
						&& scope.priority() > current.scope().priority())) {
			return new Rejected(retryAfterNanos, scope);
		}
		return current;
	}

	sealed interface Acquisition permits Acquired, Rejected {
	}

	enum Acquired implements Acquisition {
		INSTANCE
	}

	record Rejected(
			long retryAfterNanos,
			TurnCredentialRateLimitScope scope)
			implements Acquisition {

		long retryAfterSeconds() {
			return Math.max(1, Math.ceilDiv(retryAfterNanos, NANOS_PER_SECOND));
		}
	}

	private static final class IssuanceWindow {

		private final long startedAtNanos;
		private int attempts;

		private IssuanceWindow(long startedAtNanos) {
			this.startedAtNanos = startedAtNanos;
		}

		private boolean isExpired(long nowNanos, long windowNanos) {
			return nowNanos - startedAtNanos >= windowNanos;
		}

		private long retryAfterNanos(long nowNanos, long windowNanos) {
			long elapsedNanos = Math.max(0, nowNanos - startedAtNanos);
			return Math.max(1, windowNanos - elapsedNanos);
		}
	}
}

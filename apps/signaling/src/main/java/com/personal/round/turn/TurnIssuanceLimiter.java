package com.personal.round.turn;

import com.personal.round.auth.ParticipantRoomKey;
import com.personal.round.config.TurnProperties;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class TurnIssuanceLimiter {

	private static final long NANOS_PER_SECOND = 1_000_000_000L;
	// 가장 늦게 풀리는 거부를 고르고, 해제 시점이 같으면 enum 선언 순서가 뒤인 범위를 고른다.
	private static final Comparator<Rejected> LATEST_RELEASE =
			Comparator.comparingLong(Rejected::retryAfterNanos)
					.thenComparing(Rejected::scope);

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

	/** 허용하면 집계하고 빈 값을, 거부하면 집계 없이 보고할 거부 사유를 돌려준다. */
	synchronized Optional<Rejected> tryAcquire(
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
		List<Rejected> rejections = new ArrayList<>();
		if (participantWindow != null
				&& participantWindow.attempts >= maxRequestsPerParticipant) {
			rejections.add(new Rejected(
					participantWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.PARTICIPANT));
		}
		if (clientWindow != null && clientWindow.attempts >= maxRequestsPerClient) {
			rejections.add(new Rejected(
					clientWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.CLIENT));
		}
		if (globalWindow != null && globalWindow.attempts >= maxRequestsGlobal) {
			rejections.add(new Rejected(
					globalWindow.retryAfterNanos(nowNanos, windowNanos),
					TurnCredentialRateLimitScope.GLOBAL));
		}
		if (participantKey != null
				&& participantWindow == null
				&& participantWindows.size() >= maxTrackedParticipants) {
			rejections.add(new Rejected(
					retryAfterCapacityNanos(participantWindows, nowNanos),
					TurnCredentialRateLimitScope.PARTICIPANT_STATE_CAPACITY));
		}
		if (clientWindow == null && clientWindows.size() >= maxTrackedClients) {
			rejections.add(new Rejected(
					retryAfterCapacityNanos(clientWindows, nowNanos),
					TurnCredentialRateLimitScope.CLIENT_STATE_CAPACITY));
		}
		if (!rejections.isEmpty()) {
			return rejections.stream().max(LATEST_RELEASE);
		}

		clientWindows.computeIfAbsent(clientKey, ignored -> new IssuanceWindow(nowNanos)).attempts++;
		if (participantKey != null) {
			participantWindows.computeIfAbsent(
					participantKey,
					ignored -> new IssuanceWindow(nowNanos)).attempts++;
		}
		if (globalWindow == null) {
			globalWindow = new IssuanceWindow(nowNanos);
		}
		globalWindow.attempts++;
		return Optional.empty();
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

	record Rejected(long retryAfterNanos, TurnCredentialRateLimitScope scope) {

		// retryAfterNanos는 항상 1 이상이라 Retry-After도 1초 이상이다.
		long retryAfterSeconds() {
			return Math.ceilDiv(retryAfterNanos, NANOS_PER_SECOND);
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

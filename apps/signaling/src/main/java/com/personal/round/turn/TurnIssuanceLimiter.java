package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.util.HashMap;
import java.util.Map;

final class TurnIssuanceLimiter {

	private final Map<String, IssuanceWindow> clientWindows = new HashMap<>();
	private final long windowMillis;
	private final int maxRequestsPerClient;
	private final int maxRequestsGlobal;
	private final int maxTrackedClients;
	private IssuanceWindow globalWindow;

	TurnIssuanceLimiter(TurnProperties properties) {
		this.windowMillis = properties.rateLimitWindow().toMillis();
		this.maxRequestsPerClient = properties.rateLimitMaxRequests();
		this.maxRequestsGlobal = properties.rateLimitGlobalMaxRequests();
		this.maxTrackedClients = properties.rateLimitMaxClients();
	}

	synchronized Acquisition tryAcquire(String clientKey, long nowMillis) {
		removeExpiredClientWindows(nowMillis);
		if (globalWindow != null && globalWindow.isExpired(nowMillis, windowMillis)) {
			globalWindow = null;
		}

		IssuanceWindow clientWindow = clientWindows.get(clientKey);
		long retryAfterSeconds = 0;
		if (clientWindow != null && clientWindow.issued >= maxRequestsPerClient) {
			retryAfterSeconds = clientWindow.retryAfterSeconds(nowMillis, windowMillis);
		}
		if (globalWindow != null && globalWindow.issued >= maxRequestsGlobal) {
			retryAfterSeconds = Math.max(
					retryAfterSeconds,
					globalWindow.retryAfterSeconds(nowMillis, windowMillis));
		}
		if (clientWindow == null && clientWindows.size() >= maxTrackedClients) {
			retryAfterSeconds = Math.max(
					retryAfterSeconds,
					retryAfterClientCapacitySeconds(nowMillis));
		}
		if (retryAfterSeconds > 0) {
			return new Rejected(retryAfterSeconds);
		}

		if (clientWindow == null) {
			clientWindow = new IssuanceWindow(nowMillis);
			clientWindows.put(clientKey, clientWindow);
		}
		if (globalWindow == null) {
			globalWindow = new IssuanceWindow(nowMillis);
		}
		clientWindow.issued++;
		globalWindow.issued++;
		return Acquired.INSTANCE;
	}

	synchronized int trackedClientCount() {
		return clientWindows.size();
	}

	private void removeExpiredClientWindows(long nowMillis) {
		clientWindows.values()
				.removeIf(window -> window.isExpired(nowMillis, windowMillis));
	}

	private long retryAfterClientCapacitySeconds(long nowMillis) {
		return clientWindows.values().stream()
				.mapToLong(window -> window.retryAfterSeconds(nowMillis, windowMillis))
				.min()
				.orElseThrow();
	}

	sealed interface Acquisition permits Acquired, Rejected {
	}

	enum Acquired implements Acquisition {
		INSTANCE
	}

	record Rejected(long retryAfterSeconds) implements Acquisition {

		Rejected {
			if (retryAfterSeconds < 1) {
				throw new IllegalArgumentException("retryAfterSeconds must be positive");
			}
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

		private long retryAfterSeconds(long nowMillis, long windowMillis) {
			long elapsedMillis = Math.max(0, nowMillis - startedAtMillis);
			long remainingMillis = Math.max(1, windowMillis - elapsedMillis);
			return Math.max(1, Math.ceilDiv(remainingMillis, 1_000));
		}
	}
}

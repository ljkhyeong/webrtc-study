package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import java.util.LinkedHashMap;

/**
 * 시그널링 수신량의 세션·클라이언트·서버 전체 고정 구간과 클라이언트 상태 보관을 소유한다.
 *
 * <p>호출자는 SignalingService의 단일 monitor 안에서 이 객체를 사용한다.
 */
final class SignalingInboundLimiter {

	private static final long UNSET_NANOS = Long.MIN_VALUE;

	private final LinkedHashMap<String, ClientState> clients =
			new LinkedHashMap<>(16, 0.75f, true);
	private final UsageWindow globalWindow = new UsageWindow();
	private final int maximumTrackedClients;
	private final long windowNanos;
	private final int maximumSessionFrames;
	private final int maximumClientFrames;
	private final int maximumGlobalFrames;
	private final long maximumSessionBytes;
	private final long maximumClientBytes;
	private final long maximumGlobalBytes;

	SignalingInboundLimiter(SignalingProperties properties) {
		this.maximumTrackedClients = properties.maxConnections();
		this.windowNanos = properties.abuseWindow().toNanos();
		this.maximumSessionFrames = properties.maxFramesPerSessionWindow();
		this.maximumClientFrames = properties.maxFramesPerClientWindow();
		this.maximumGlobalFrames = properties.maxFramesGlobalWindow();
		this.maximumSessionBytes = properties.maxBytesPerSessionWindow();
		this.maximumClientBytes = properties.maxBytesPerClientWindow();
		this.maximumGlobalBytes = properties.maxBytesGlobalWindow();
	}

	Connection retain(String clientKey) {
		ClientState state = clients.get(clientKey);
		if (state == null) {
			evictInactiveForCapacity();
			if (clients.size() >= maximumTrackedClients) {
				return null;
			}
			state = new ClientState();
			clients.put(clientKey, state);
		}
		state.activeConnections++;
		return new Connection(clientKey, state);
	}

	void release(Connection connection) {
		if (!connection.active) {
			return;
		}
		connection.active = false;
		connection.clientState.activeConnections--;
	}

	void touch(Connection connection) {
		if (connection.active) {
			// 접근 순서를 사용해 활성 트래픽 항목을 비활성 LRU 항목 뒤로 보낸다.
			clients.get(connection.clientKey);
		}
	}

	Decision tryAcquire(Connection connection, long nowNanos, int payloadBytes) {
		WindowDecision session = connection.sessionWindow.tryAcquire(
				nowNanos,
				windowNanos,
				maximumSessionFrames,
				maximumSessionBytes,
				payloadBytes);
		if (session == WindowDecision.FRAME_LIMITED) {
			return Decision.SESSION_FRAME_LIMITED;
		}
		if (session == WindowDecision.BYTE_LIMITED) {
			return Decision.SESSION_BYTE_LIMITED;
		}

		WindowDecision client = connection.clientState.window.tryAcquire(
				nowNanos,
				windowNanos,
				maximumClientFrames,
				maximumClientBytes,
				payloadBytes);
		if (client == WindowDecision.FRAME_LIMITED) {
			return Decision.CLIENT_FRAME_LIMITED;
		}
		if (client == WindowDecision.BYTE_LIMITED) {
			return Decision.CLIENT_BYTE_LIMITED;
		}

		WindowDecision global = globalWindow.tryAcquire(
				nowNanos,
				windowNanos,
				maximumGlobalFrames,
				maximumGlobalBytes,
				payloadBytes);
		if (global == WindowDecision.FRAME_LIMITED) {
			return Decision.GLOBAL_FRAME_LIMITED;
		}
		if (global == WindowDecision.BYTE_LIMITED) {
			return Decision.GLOBAL_BYTE_LIMITED;
		}
		return Decision.ACCEPTED;
	}

	void removeExpiredInactive(long nowNanos) {
		clients.entrySet().removeIf(entry -> {
			ClientState state = entry.getValue();
			return state.activeConnections == 0
					&& state.window.isExpired(nowNanos, windowNanos);
		});
	}

	int trackedClientCount() {
		return clients.size();
	}

	boolean isEmpty() {
		return clients.isEmpty();
	}

	void clear() {
		clients.clear();
		globalWindow.reset();
	}

	private void evictInactiveForCapacity() {
		var iterator = clients.entrySet().iterator();
		while (clients.size() >= maximumTrackedClients && iterator.hasNext()) {
			if (iterator.next().getValue().activeConnections == 0) {
				iterator.remove();
			}
		}
	}

	enum Decision {
		ACCEPTED,
		SESSION_FRAME_LIMITED,
		SESSION_BYTE_LIMITED,
		CLIENT_FRAME_LIMITED,
		CLIENT_BYTE_LIMITED,
		GLOBAL_FRAME_LIMITED,
		GLOBAL_BYTE_LIMITED
	}

	static final class Connection {

		private final String clientKey;
		private final ClientState clientState;
		private final UsageWindow sessionWindow = new UsageWindow();
		private boolean active = true;

		private Connection(String clientKey, ClientState clientState) {
			this.clientKey = clientKey;
			this.clientState = clientState;
		}
	}

	private static final class ClientState {

		private final UsageWindow window = new UsageWindow();
		private int activeConnections;
	}

	private enum WindowDecision {
		ACCEPTED,
		FRAME_LIMITED,
		BYTE_LIMITED
	}

	private static final class UsageWindow {

		private long startedAtNanos = UNSET_NANOS;
		private int frameCount;
		private long payloadBytes;

		private WindowDecision tryAcquire(
				long nowNanos,
				long durationNanos,
				int maximumFrames,
				long maximumBytes,
				int nextPayloadBytes) {
			if (startedAtNanos == UNSET_NANOS
					|| nowNanos - startedAtNanos >= durationNanos) {
				startedAtNanos = nowNanos;
				frameCount = 0;
				payloadBytes = 0;
			}
			if (frameCount < Integer.MAX_VALUE) {
				frameCount++;
			}
			payloadBytes = saturatedAdd(payloadBytes, nextPayloadBytes);
			if (frameCount > maximumFrames) {
				return WindowDecision.FRAME_LIMITED;
			}
			if (payloadBytes > maximumBytes) {
				return WindowDecision.BYTE_LIMITED;
			}
			return WindowDecision.ACCEPTED;
		}

		private boolean isExpired(long nowNanos, long durationNanos) {
			return startedAtNanos == UNSET_NANOS
					|| nowNanos - startedAtNanos >= durationNanos;
		}

		private void reset() {
			startedAtNanos = UNSET_NANOS;
			frameCount = 0;
			payloadBytes = 0;
		}

		private static long saturatedAdd(long current, int increment) {
			if (Long.MAX_VALUE - current < increment) {
				return Long.MAX_VALUE;
			}
			return current + increment;
		}
	}
}

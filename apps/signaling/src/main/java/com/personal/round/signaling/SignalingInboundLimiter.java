package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import java.util.LinkedHashMap;
import org.springframework.util.Assert;

/**
 * 세션·클라이언트·서버 전체의 고정 집계 구간과 수신량 상태를 관리한다.
 *
 * <p>호출자는 SignalingService의 단일 monitor 안에서 이 객체를 사용한다. 활성 클라이언트 수는
 * {@link ConnectionAdmissionPolicy}의 연결 예약 수를 넘지 않으므로 상한도 같은 최대 연결 수를 쓴다.
 */
final class SignalingInboundLimiter {

	private static final long UNSET_NANOS = Long.MIN_VALUE;

	private final LinkedHashMap<String, ClientState> clients =
			new LinkedHashMap<>(16, 0.75f, true);
	private final UsageWindow globalWindow = new UsageWindow();
	private final int maximumTrackedClients;
	private final long windowNanos;
	private final Limit sessionLimit;
	private final Limit clientLimit;
	private final Limit globalLimit;

	SignalingInboundLimiter(SignalingProperties properties) {
		this.maximumTrackedClients = properties.maxConnections();
		this.windowNanos = properties.abuseWindow().toNanos();
		this.sessionLimit = new Limit(
				properties.maxFramesPerSessionWindow(),
				properties.maxBytesPerSessionWindow(),
				Decision.SESSION_FRAME_LIMITED,
				Decision.SESSION_BYTE_LIMITED);
		this.clientLimit = new Limit(
				properties.maxFramesPerClientWindow(),
				properties.maxBytesPerClientWindow(),
				Decision.CLIENT_FRAME_LIMITED,
				Decision.CLIENT_BYTE_LIMITED);
		this.globalLimit = new Limit(
				properties.maxFramesGlobalWindow(),
				properties.maxBytesGlobalWindow(),
				Decision.GLOBAL_FRAME_LIMITED,
				Decision.GLOBAL_BYTE_LIMITED);
	}

	Connection retain(String clientKey) {
		ClientState state = clients.get(clientKey);
		if (state == null) {
			evictInactiveForCapacity();
			Assert.state(
					clients.size() < maximumTrackedClients,
					"Inbound limiter capacity must follow connection admission");
			state = new ClientState();
			clients.put(clientKey, state);
		}
		state.activeConnections++;
		return new Connection(clientKey, state);
	}

	void release(Connection connection) {
		connection.clientState.activeConnections--;
	}

	Decision tryAcquire(Connection connection, long nowNanos, int payloadBytes) {
		// 접근 순서를 사용해 활성 트래픽 항목을 비활성 LRU 항목 뒤로 보낸다.
		clients.get(connection.clientKey);
		// 앞 단계에서 거부한 프레임은 다음 단계 집계에 넣지 않는다.
		Decision decision = connection.sessionWindow.tryAcquire(nowNanos, windowNanos, sessionLimit, payloadBytes);
		if (decision == Decision.ACCEPTED) {
			decision = connection.clientState.window.tryAcquire(nowNanos, windowNanos, clientLimit, payloadBytes);
		}
		if (decision == Decision.ACCEPTED) {
			decision = globalWindow.tryAcquire(nowNanos, windowNanos, globalLimit, payloadBytes);
		}
		return decision;
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

		private Connection(String clientKey, ClientState clientState) {
			this.clientKey = clientKey;
			this.clientState = clientState;
		}
	}

	private static final class ClientState {

		private final UsageWindow window = new UsageWindow();
		private int activeConnections;
	}

	private record Limit(int frames, long bytes, Decision frameLimited, Decision byteLimited) {
	}

	private static final class UsageWindow {

		private long startedAtNanos = UNSET_NANOS;
		private int frameCount;
		private long payloadBytes;

		private Decision tryAcquire(
				long nowNanos,
				long durationNanos,
				Limit limit,
				int nextPayloadBytes) {
			if (isExpired(nowNanos, durationNanos)) {
				startedAtNanos = nowNanos;
				frameCount = 0;
				payloadBytes = 0;
			}
			frameCount++;
			payloadBytes += nextPayloadBytes;
			if (frameCount > limit.frames()) {
				return limit.frameLimited();
			}
			if (payloadBytes > limit.bytes()) {
				return limit.byteLimited();
			}
			return Decision.ACCEPTED;
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
	}
}

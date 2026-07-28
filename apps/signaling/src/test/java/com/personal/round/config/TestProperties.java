package com.personal.round.config;

import java.time.Duration;
import java.util.List;

public final class TestProperties {

	private static final List<String> DEFAULT_ALLOWED_ORIGINS = List.of(
			"http://localhost:5173",
			"http://127.0.0.1:5173");
	private static final int DEFAULT_MAX_ROOM_SIZE = 6;
	private static final int DEFAULT_MAX_CONNECTIONS = 1_000;
	private static final int DEFAULT_MAX_CONNECTIONS_PER_CLIENT = 12;
	private static final Duration DEFAULT_HEARTBEAT_INTERVAL = Duration.ofSeconds(30);
	private static final Duration DEFAULT_UNJOINED_TIMEOUT = Duration.ofSeconds(15);
	private static final Duration DEFAULT_UNJOINED_SWEEP_INTERVAL = Duration.ofSeconds(1);
	private static final Duration DEFAULT_ABUSE_WINDOW = Duration.ofSeconds(10);
	private static final int DEFAULT_MAX_FRAMES_PER_SESSION_WINDOW = 600;
	private static final int DEFAULT_MAX_FRAMES_GLOBAL_WINDOW = 3_600;
	private static final int DEFAULT_MAX_TEXT_PAYLOAD_BYTES = 64 * 1024;

	private static final Duration DEFAULT_TURN_CREDENTIAL_TTL = Duration.ofMinutes(10);
	private static final Duration DEFAULT_TURN_RATE_LIMIT_WINDOW = Duration.ofMinutes(1);
	private static final int DEFAULT_TURN_RATE_LIMIT_MAX_REQUESTS = 12;
	private static final int DEFAULT_TURN_RATE_LIMIT_GLOBAL_MAX_REQUESTS = 8;
	private static final int DEFAULT_TURN_RATE_LIMIT_MAX_CLIENTS = 10_000;

	private TestProperties() {
	}

	public static SignalingProperties signaling() {
		return signaling(DEFAULT_MAX_ROOM_SIZE);
	}

	public static SignalingProperties signaling(int maxRoomSize) {
		return signalingWithConnectionLimits(
				maxRoomSize,
				DEFAULT_MAX_CONNECTIONS,
				DEFAULT_MAX_CONNECTIONS_PER_CLIENT);
	}

	public static SignalingProperties signalingWithConnectionLimits(
			int maxRoomSize,
			int maxConnections,
			int maxConnectionsPerClient) {
		return new SignalingProperties(
				DEFAULT_ALLOWED_ORIGINS,
				maxRoomSize,
				maxConnections,
				maxConnectionsPerClient,
				DEFAULT_HEARTBEAT_INTERVAL,
				DEFAULT_UNJOINED_TIMEOUT,
				DEFAULT_UNJOINED_SWEEP_INTERVAL,
				DEFAULT_ABUSE_WINDOW,
				DEFAULT_MAX_FRAMES_PER_SESSION_WINDOW,
				DEFAULT_MAX_FRAMES_GLOBAL_WINDOW,
				DEFAULT_MAX_TEXT_PAYLOAD_BYTES);
	}

	public static SignalingProperties signalingWithFrameLimits(
			int maxRoomSize,
			int maxFramesPerSessionWindow,
			int maxFramesGlobalWindow) {
		return new SignalingProperties(
				DEFAULT_ALLOWED_ORIGINS,
				maxRoomSize,
				DEFAULT_MAX_CONNECTIONS,
				DEFAULT_MAX_CONNECTIONS_PER_CLIENT,
				DEFAULT_HEARTBEAT_INTERVAL,
				DEFAULT_UNJOINED_TIMEOUT,
				DEFAULT_UNJOINED_SWEEP_INTERVAL,
				DEFAULT_ABUSE_WINDOW,
				maxFramesPerSessionWindow,
				maxFramesGlobalWindow,
				DEFAULT_MAX_TEXT_PAYLOAD_BYTES);
	}

	public static TurnProperties turn(List<String> urls, String sharedSecret) {
		return turnWithRateLimits(
				urls,
				sharedSecret,
				DEFAULT_TURN_RATE_LIMIT_MAX_REQUESTS,
				DEFAULT_TURN_RATE_LIMIT_GLOBAL_MAX_REQUESTS,
				DEFAULT_TURN_RATE_LIMIT_MAX_CLIENTS);
	}

	public static TurnProperties turnWithRateLimits(
			List<String> urls,
			String sharedSecret,
			int rateLimitMaxRequests,
			int rateLimitGlobalMaxRequests,
			int rateLimitMaxClients) {
		return new TurnProperties(
				urls,
				sharedSecret,
				DEFAULT_TURN_CREDENTIAL_TTL,
				DEFAULT_TURN_RATE_LIMIT_WINDOW,
				rateLimitMaxRequests,
				rateLimitGlobalMaxRequests,
				rateLimitMaxClients);
	}
}

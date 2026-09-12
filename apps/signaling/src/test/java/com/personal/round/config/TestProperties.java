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
	private static final Duration DEFAULT_SHUTDOWN_CLOSE_TIMEOUT = Duration.ofSeconds(5);
	private static final Duration DEFAULT_ABUSE_WINDOW = Duration.ofSeconds(10);
	private static final int DEFAULT_MAX_FRAMES_PER_SESSION_WINDOW = 600;
	private static final int DEFAULT_MAX_FRAMES_PER_CLIENT_WINDOW = 1_200;
	private static final int DEFAULT_MAX_FRAMES_GLOBAL_WINDOW = 3_600;
	private static final long DEFAULT_MAX_BYTES_PER_SESSION_WINDOW = 4L * 1024 * 1024;
	private static final long DEFAULT_MAX_BYTES_PER_CLIENT_WINDOW = 8L * 1024 * 1024;
	private static final long DEFAULT_MAX_BYTES_GLOBAL_WINDOW = 24L * 1024 * 1024;
	private static final long DEFAULT_MAX_OUTBOUND_QUEUE_BYTES = 2L * 1024 * 1024;
	private static final long DEFAULT_MAX_OUTBOUND_QUEUE_BYTES_GLOBAL = 64L * 1024 * 1024;
	private static final Duration DEFAULT_TURN_CREDENTIAL_TTL = Duration.ofMinutes(10);
	private static final Duration DEFAULT_TURN_RATE_LIMIT_WINDOW = Duration.ofMinutes(10);
	private static final int DEFAULT_TURN_RATE_LIMIT_MAX_REQUESTS = 12;
	private static final int DEFAULT_TURN_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS = 6;
	private static final int DEFAULT_TURN_RATE_LIMIT_GLOBAL_MAX_REQUESTS = 24;
	private static final int DEFAULT_TURN_RATE_LIMIT_MAX_CLIENTS = 10_000;
	private static final int DEFAULT_TURN_RATE_LIMIT_MAX_PARTICIPANTS = 10_000;

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

	public static SignalingProperties signalingWithShutdownCloseTimeout(Duration timeout) {
		SignalingProperties defaults = signaling();
		return new SignalingProperties(
				defaults.allowedOrigins(),
				defaults.maxRoomSize(),
				defaults.maxConnections(),
				defaults.maxConnectionsPerClient(),
				defaults.heartbeatInterval(),
				defaults.unjoinedTimeout(),
				defaults.unjoinedSweepInterval(),
				timeout,
				defaults.abuseWindow(),
				defaults.maxFramesPerSessionWindow(),
				defaults.maxFramesPerClientWindow(),
				defaults.maxFramesGlobalWindow(),
				defaults.maxBytesPerSessionWindow(),
				defaults.maxBytesPerClientWindow(),
				defaults.maxBytesGlobalWindow(),
				defaults.maxOutboundQueueBytes(),
				defaults.maxOutboundQueueBytesGlobal());
	}

	public static SignalingProperties signalingWithConnectionLimits(
			int maxRoomSize,
			int maxConnections,
			int maxConnectionsPerClient) {
		return signalingWithConnectionAndFrameLimits(
				maxRoomSize,
				maxConnections,
				maxConnectionsPerClient,
				DEFAULT_MAX_FRAMES_PER_SESSION_WINDOW,
				DEFAULT_MAX_FRAMES_PER_CLIENT_WINDOW,
				DEFAULT_MAX_FRAMES_GLOBAL_WINDOW);
	}

	public static SignalingProperties signalingWithConnectionAndFrameLimits(
			int maxRoomSize,
			int maxConnections,
			int maxConnectionsPerClient,
			int maxFramesPerSessionWindow,
			int maxFramesPerClientWindow,
			int maxFramesGlobalWindow) {
		return signalingWithConnectionFrameAndByteLimits(
				maxRoomSize,
				maxConnections,
				maxConnectionsPerClient,
				maxFramesPerSessionWindow,
				maxFramesPerClientWindow,
				maxFramesGlobalWindow,
				DEFAULT_MAX_BYTES_PER_SESSION_WINDOW,
				DEFAULT_MAX_BYTES_PER_CLIENT_WINDOW,
				DEFAULT_MAX_BYTES_GLOBAL_WINDOW,
				DEFAULT_MAX_OUTBOUND_QUEUE_BYTES,
				DEFAULT_MAX_OUTBOUND_QUEUE_BYTES_GLOBAL);
	}

	public static SignalingProperties signalingWithConnectionFrameAndByteLimits(
			int maxRoomSize,
			int maxConnections,
			int maxConnectionsPerClient,
			int maxFramesPerSessionWindow,
			int maxFramesPerClientWindow,
			int maxFramesGlobalWindow,
			long maxBytesPerSessionWindow,
			long maxBytesPerClientWindow,
			long maxBytesGlobalWindow,
			long maxOutboundQueueBytes,
			long maxOutboundQueueBytesGlobal) {
		return new SignalingProperties(
				DEFAULT_ALLOWED_ORIGINS,
				maxRoomSize,
				maxConnections,
				maxConnectionsPerClient,
				DEFAULT_HEARTBEAT_INTERVAL,
				DEFAULT_UNJOINED_TIMEOUT,
				DEFAULT_UNJOINED_SWEEP_INTERVAL,
				DEFAULT_SHUTDOWN_CLOSE_TIMEOUT,
				DEFAULT_ABUSE_WINDOW,
				maxFramesPerSessionWindow,
				maxFramesPerClientWindow,
				maxFramesGlobalWindow,
				maxBytesPerSessionWindow,
				maxBytesPerClientWindow,
				maxBytesGlobalWindow,
				maxOutboundQueueBytes,
				maxOutboundQueueBytesGlobal);
	}

	public static SignalingProperties signalingWithFrameLimits(
			int maxRoomSize,
			int maxFramesPerSessionWindow,
			int maxFramesPerClientWindow,
			int maxFramesGlobalWindow) {
		return signalingWithConnectionAndFrameLimits(
				maxRoomSize,
				DEFAULT_MAX_CONNECTIONS,
				DEFAULT_MAX_CONNECTIONS_PER_CLIENT,
				maxFramesPerSessionWindow,
				maxFramesPerClientWindow,
				maxFramesGlobalWindow);
	}

	public static SignalingProperties signalingWithFrameAndByteLimits(
			int maxRoomSize,
			int maxFramesPerSessionWindow,
			int maxFramesPerClientWindow,
			int maxFramesGlobalWindow,
			long maxBytesPerSessionWindow,
			long maxBytesPerClientWindow,
			long maxBytesGlobalWindow,
			long maxOutboundQueueBytes) {
		return signalingWithFrameAndByteLimits(
				maxRoomSize,
				maxFramesPerSessionWindow,
				maxFramesPerClientWindow,
				maxFramesGlobalWindow,
				maxBytesPerSessionWindow,
				maxBytesPerClientWindow,
				maxBytesGlobalWindow,
				maxOutboundQueueBytes,
				DEFAULT_MAX_OUTBOUND_QUEUE_BYTES_GLOBAL);
	}

	public static SignalingProperties signalingWithFrameAndByteLimits(
			int maxRoomSize,
			int maxFramesPerSessionWindow,
			int maxFramesPerClientWindow,
			int maxFramesGlobalWindow,
			long maxBytesPerSessionWindow,
			long maxBytesPerClientWindow,
			long maxBytesGlobalWindow,
			long maxOutboundQueueBytes,
			long maxOutboundQueueBytesGlobal) {
		return signalingWithConnectionFrameAndByteLimits(
				maxRoomSize,
				DEFAULT_MAX_CONNECTIONS,
				DEFAULT_MAX_CONNECTIONS_PER_CLIENT,
				maxFramesPerSessionWindow,
				maxFramesPerClientWindow,
				maxFramesGlobalWindow,
				maxBytesPerSessionWindow,
				maxBytesPerClientWindow,
				maxBytesGlobalWindow,
				maxOutboundQueueBytes,
				maxOutboundQueueBytesGlobal);
	}

	public static TurnProperties turn(String cloudflareKeyId, String cloudflareApiToken) {
		return turnWithRateLimits(
				cloudflareKeyId,
				cloudflareApiToken,
				DEFAULT_TURN_RATE_LIMIT_MAX_REQUESTS,
				DEFAULT_TURN_RATE_LIMIT_GLOBAL_MAX_REQUESTS,
				DEFAULT_TURN_RATE_LIMIT_MAX_CLIENTS);
	}

	public static TurnProperties turnWithRateLimits(
			String cloudflareKeyId,
			String cloudflareApiToken,
			int rateLimitMaxRequests,
			int rateLimitGlobalMaxRequests,
			int rateLimitMaxClients) {
		return turnWithRateLimits(
				cloudflareKeyId,
				cloudflareApiToken,
				rateLimitMaxRequests,
				DEFAULT_TURN_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS,
				rateLimitGlobalMaxRequests,
				rateLimitMaxClients,
				DEFAULT_TURN_RATE_LIMIT_MAX_PARTICIPANTS);
	}

	public static TurnProperties turnWithRateLimits(
			String cloudflareKeyId,
			String cloudflareApiToken,
			int rateLimitMaxRequests,
			int rateLimitParticipantMaxRequests,
			int rateLimitGlobalMaxRequests,
			int rateLimitMaxClients,
			int rateLimitMaxParticipants) {
		return new TurnProperties(
				cloudflareKeyId.isBlank() && cloudflareApiToken.isBlank()
						? TurnProperties.Provider.DISABLED
						: TurnProperties.Provider.CLOUDFLARE,
				cloudflareKeyId,
				cloudflareApiToken,
				List.of(),
				"",
				DEFAULT_TURN_CREDENTIAL_TTL,
				DEFAULT_TURN_RATE_LIMIT_WINDOW,
				rateLimitMaxRequests,
				rateLimitParticipantMaxRequests,
				rateLimitGlobalMaxRequests,
				rateLimitMaxClients,
				rateLimitMaxParticipants);
	}
}

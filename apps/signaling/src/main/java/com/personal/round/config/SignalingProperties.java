package com.personal.round.config;

import com.personal.round.protocol.ProtocolParser;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import java.util.List;
import org.hibernate.validator.constraints.time.DurationMin;
import org.hibernate.validator.constraints.time.DurationMax;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.signaling")
public record SignalingProperties(
		@NotEmpty(message = "round.signaling.allowed-origins must not be empty")
		List<@NotBlank(message = "round.signaling.allowed-origins must not contain blank values") String>
				allowedOrigins,
		@Min(value = 1, message = "round.signaling.max-room-size must be at least 1")
		@Max(
				value = MAX_SUPPORTED_ROOM_SIZE,
				message = "round.signaling.max-room-size must be at most 6")
		int maxRoomSize,
		@Min(value = 1, message = "round.signaling.max-connections must be at least 1")
		@Max(value = 5_000, message = "round.signaling.max-connections must be at most 5000")
		int maxConnections,
		@Min(value = 1, message = "round.signaling.max-connections-per-client must be at least 1")
		@Max(
				value = 5_000,
				message = "round.signaling.max-connections-per-client must be at most 5000")
		int maxConnectionsPerClient,
		@NotNull(message = "round.signaling.heartbeat-interval must be configured")
		@DurationMin(
				millis = 1,
				message = "round.signaling.heartbeat-interval must be at least 1ms")
		Duration heartbeatInterval,
		@NotNull(message = "round.signaling.unjoined-timeout must be configured")
		@DurationMin(
				seconds = 1,
				message = "round.signaling.unjoined-timeout must be at least 1s")
		Duration unjoinedTimeout,
		@NotNull(message = "round.signaling.unjoined-sweep-interval must be configured")
		@DurationMin(
				millis = 100,
				message = "round.signaling.unjoined-sweep-interval must be at least 100ms")
		@DurationMax(
				seconds = 1,
				message =
						"round.signaling.unjoined-sweep-interval must be at most 1s "
								+ "for authorization expiry enforcement")
		Duration unjoinedSweepInterval,
		@NotNull(message = "round.signaling.shutdown-close-timeout must be configured")
		@DurationMin(
				millis = 100,
				message = "round.signaling.shutdown-close-timeout must be at least 100ms")
		@DurationMax(
				seconds = 9,
				message = "round.signaling.shutdown-close-timeout must be at most 9s")
		Duration shutdownCloseTimeout,
		@NotNull(message = "round.signaling.abuse-window must be configured")
		@DurationMin(
				seconds = 1,
				message = "round.signaling.abuse-window must be at least 1s")
		Duration abuseWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-frames-per-session-window must be at least 1")
		int maxFramesPerSessionWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-frames-per-client-window must be at least 1")
		int maxFramesPerClientWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-frames-global-window must be at least 1")
		int maxFramesGlobalWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-bytes-per-session-window must be at least 1")
		@Max(
				value = 1_073_741_824,
				message =
						"round.signaling.max-bytes-per-session-window must be at most 1073741824")
		long maxBytesPerSessionWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-bytes-per-client-window must be at least 1")
		@Max(
				value = 1_073_741_824,
				message =
						"round.signaling.max-bytes-per-client-window must be at most 1073741824")
		long maxBytesPerClientWindow,
		@Min(
				value = 1,
				message = "round.signaling.max-bytes-global-window must be at least 1")
		@Max(
				value = 1_073_741_824,
				message =
						"round.signaling.max-bytes-global-window must be at most 1073741824")
		long maxBytesGlobalWindow,
		@Min(
				value = ProtocolParser.MAX_SIGNALING_FRAME_BYTES,
				message = "round.signaling.max-outbound-queue-bytes는 시그널링 프레임 한도인 {value}바이트 이상이어야 합니다")
		@Max(
				value = 16_777_216,
				message = "round.signaling.max-outbound-queue-bytes must be at most 16777216")
		long maxOutboundQueueBytes,
		@Min(
				value = 1,
				message = "round.signaling.max-outbound-queue-bytes-global must be at least 1")
		@Max(
				value = 134_217_728,
				message =
						"round.signaling.max-outbound-queue-bytes-global must be at most 134217728")
		long maxOutboundQueueBytesGlobal) {

	public static final int MAX_SUPPORTED_ROOM_SIZE = 6;

	public SignalingProperties {
		allowedOrigins = allowedOrigins == null ? List.of() : List.copyOf(allowedOrigins);
	}

	@AssertTrue(
			message = "round.signaling.max-connections must not be lower than max-room-size")
	public boolean isMaxConnectionsAtLeastRoomSize() {
		return maxConnections >= maxRoomSize;
	}

	@AssertTrue(
			message =
					"round.signaling.max-connections-per-client must not exceed max-connections")
	public boolean isPerClientConnectionLimitWithinGlobalLimit() {
		return maxConnectionsPerClient <= maxConnections;
	}

	@AssertTrue(
			message =
					"round.signaling.max-frames-per-client-window must not be lower than "
							+ "max-frames-per-session-window")
	public boolean isClientFrameLimitAtLeastSessionLimit() {
		return maxFramesPerClientWindow >= maxFramesPerSessionWindow;
	}

	@AssertTrue(
			message =
					"round.signaling.max-frames-global-window must be at least twice "
							+ "max-frames-per-client-window")
	public boolean isGlobalFrameLimitAtLeastTwiceClientLimit() {
		return (long) maxFramesGlobalWindow >= 2L * maxFramesPerClientWindow;
	}

	@AssertTrue(
			message =
					"round.signaling.max-bytes-per-client-window must not be lower than "
							+ "max-bytes-per-session-window")
	public boolean isClientByteLimitAtLeastSessionLimit() {
		return maxBytesPerClientWindow >= maxBytesPerSessionWindow;
	}

	@AssertTrue(
			message =
					"round.signaling.max-bytes-global-window must be at least twice "
							+ "max-bytes-per-client-window")
	public boolean isGlobalByteLimitAtLeastTwiceClientLimit() {
		return maxBytesGlobalWindow >= 2L * maxBytesPerClientWindow;
	}

	@AssertTrue(
			message =
					"round.signaling.max-outbound-queue-bytes-global must not be lower than "
							+ "max-outbound-queue-bytes")
	public boolean isGlobalOutboundQueueAtLeastPeerQueue() {
		return maxOutboundQueueBytesGlobal >= maxOutboundQueueBytes;
	}
}

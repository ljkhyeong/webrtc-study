package com.personal.round.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import java.util.List;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "round.signaling")
public record SignalingProperties(
		@NotEmpty(message = "round.signaling.allowed-origins must not be empty")
		List<@NotBlank(message = "round.signaling.allowed-origins must not contain blank values") String>
				allowedOrigins,
		@Min(value = 1, message = "round.signaling.max-room-size must be at least 1")
		@Max(value = 100, message = "round.signaling.max-room-size must be at most 100")
		int maxRoomSize,
		@Min(value = 1, message = "round.signaling.max-connections must be at least 1")
		@Max(value = 100_000, message = "round.signaling.max-connections must be at most 100000")
		int maxConnections,
		@Min(value = 1, message = "round.signaling.max-connections-per-client must be at least 1")
		@Max(
				value = 100_000,
				message = "round.signaling.max-connections-per-client must be at most 100000")
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
		Duration unjoinedSweepInterval,
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
		@Min(value = 1, message = "round.signaling.max-text-payload-bytes must be at least 1")
		int maxTextPayloadBytes) {

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
					"round.signaling.unjoined-sweep-interval must not exceed unjoined-timeout")
	public boolean isUnjoinedSweepWithinTimeout() {
		return unjoinedSweepInterval == null
				|| unjoinedTimeout == null
				|| unjoinedSweepInterval.compareTo(unjoinedTimeout) <= 0;
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
}

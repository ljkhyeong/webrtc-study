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
		@NotEmpty List<@NotBlank String> allowedOrigins,
		@Min(1) @Max(MAX_SUPPORTED_ROOM_SIZE) int maxRoomSize,
		@Min(1) @Max(5_000) int maxConnections,
		@Min(1) @Max(5_000) int maxConnectionsPerClient,
		@NotNull @DurationMin(millis = 1) Duration heartbeatInterval,
		@NotNull @DurationMin(seconds = 1) Duration unjoinedTimeout,
		// 참여권 만료를 1초 안에 적용하려면 미입장 세션 점검 주기도 1초 이하여야 한다.
		@NotNull @DurationMin(millis = 100) @DurationMax(seconds = 1) Duration unjoinedSweepInterval,
		// 연결 종료는 spring.lifecycle.timeout-per-shutdown-phase(10초) 안에 끝나야 한다.
		@NotNull @DurationMin(millis = 100) @DurationMax(seconds = 9) Duration shutdownCloseTimeout,
		@NotNull @DurationMin(seconds = 1) Duration abuseWindow,
		@Min(1) int maxFramesPerSessionWindow,
		@Min(1) int maxFramesPerClientWindow,
		@Min(1) int maxFramesGlobalWindow,
		@Min(1) @Max(1_073_741_824) long maxBytesPerSessionWindow,
		@Min(1) @Max(1_073_741_824) long maxBytesPerClientWindow,
		@Min(1) @Max(1_073_741_824) long maxBytesGlobalWindow,
		// 피어별 송신 대기열에는 최대 크기의 시그널링 프레임 하나가 들어가야 한다.
		@Min(ProtocolParser.MAX_SIGNALING_FRAME_BYTES) @Max(16_777_216) long maxOutboundQueueBytes,
		@Min(1) @Max(134_217_728) long maxOutboundQueueBytesGlobal) {

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

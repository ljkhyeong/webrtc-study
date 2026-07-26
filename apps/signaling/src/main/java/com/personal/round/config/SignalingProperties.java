package com.personal.round.config;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "round.signaling")
public class SignalingProperties {

	private List<String> allowedOrigins = new ArrayList<>(
			List.of("http://localhost:5173", "http://127.0.0.1:5173"));
	private int maxRoomSize = 6;
	private int maxConnections = 1_000;
	private long heartbeatIntervalMs = 30_000;
	private long unjoinedTimeoutMs = 15_000;
	private long unjoinedSweepIntervalMs = 1_000;
	private long abuseWindowMs = 10_000;
	private int maxFramesPerSessionWindow = 600;
	private int maxFramesGlobalWindow = 3_600;
	private int maxTextPayloadBytes = 64 * 1024;

	public List<String> getAllowedOrigins() {
		return List.copyOf(allowedOrigins);
	}

	public void setAllowedOrigins(List<String> allowedOrigins) {
		this.allowedOrigins = new ArrayList<>(allowedOrigins);
	}

	public int getMaxRoomSize() {
		return maxRoomSize;
	}

	public void setMaxRoomSize(int maxRoomSize) {
		this.maxRoomSize = maxRoomSize;
	}

	public int getMaxConnections() {
		return maxConnections;
	}

	public void setMaxConnections(int maxConnections) {
		this.maxConnections = maxConnections;
	}

	public long getHeartbeatIntervalMs() {
		return heartbeatIntervalMs;
	}

	public void setHeartbeatIntervalMs(long heartbeatIntervalMs) {
		this.heartbeatIntervalMs = heartbeatIntervalMs;
	}

	public long getUnjoinedTimeoutMs() {
		return unjoinedTimeoutMs;
	}

	public void setUnjoinedTimeoutMs(long unjoinedTimeoutMs) {
		this.unjoinedTimeoutMs = unjoinedTimeoutMs;
	}

	public long getUnjoinedSweepIntervalMs() {
		return unjoinedSweepIntervalMs;
	}

	public void setUnjoinedSweepIntervalMs(long unjoinedSweepIntervalMs) {
		this.unjoinedSweepIntervalMs = unjoinedSweepIntervalMs;
	}

	public long getAbuseWindowMs() {
		return abuseWindowMs;
	}

	public void setAbuseWindowMs(long abuseWindowMs) {
		this.abuseWindowMs = abuseWindowMs;
	}

	public int getMaxFramesPerSessionWindow() {
		return maxFramesPerSessionWindow;
	}

	public void setMaxFramesPerSessionWindow(int maxFramesPerSessionWindow) {
		this.maxFramesPerSessionWindow = maxFramesPerSessionWindow;
	}

	public int getMaxFramesGlobalWindow() {
		return maxFramesGlobalWindow;
	}

	public void setMaxFramesGlobalWindow(int maxFramesGlobalWindow) {
		this.maxFramesGlobalWindow = maxFramesGlobalWindow;
	}

	public int getMaxTextPayloadBytes() {
		return maxTextPayloadBytes;
	}

	public void setMaxTextPayloadBytes(int maxTextPayloadBytes) {
		this.maxTextPayloadBytes = maxTextPayloadBytes;
	}

	public void validate() {
		if (allowedOrigins.isEmpty()) {
			throw new IllegalArgumentException("round.signaling.allowed-origins must not be empty");
		}
		if (maxRoomSize < 1 || maxRoomSize > 100) {
			throw new IllegalArgumentException("round.signaling.max-room-size must be between 1 and 100");
		}
		if (maxConnections < maxRoomSize || maxConnections > 100_000) {
			throw new IllegalArgumentException(
					"round.signaling.max-connections must be between max-room-size and 100000");
		}
		if (heartbeatIntervalMs < 1) {
			throw new IllegalArgumentException(
					"round.signaling.heartbeat-interval-ms must be a positive integer");
		}
		if (unjoinedTimeoutMs < 1_000) {
			throw new IllegalArgumentException(
					"round.signaling.unjoined-timeout-ms must be at least 1000");
		}
		if (unjoinedSweepIntervalMs < 100 || unjoinedSweepIntervalMs > unjoinedTimeoutMs) {
			throw new IllegalArgumentException(
					"round.signaling.unjoined-sweep-interval-ms must be between 100 and unjoined-timeout-ms");
		}
		if (abuseWindowMs < 1_000) {
			throw new IllegalArgumentException(
					"round.signaling.abuse-window-ms must be at least 1000");
		}
		if (maxFramesPerSessionWindow < 1) {
			throw new IllegalArgumentException(
					"round.signaling.max-frames-per-session-window must be positive");
		}
		if (maxFramesGlobalWindow < maxFramesPerSessionWindow) {
			throw new IllegalArgumentException(
					"round.signaling.max-frames-global-window must not be lower than the per-session limit");
		}
		if (maxTextPayloadBytes < 1) {
			throw new IllegalArgumentException(
					"round.signaling.max-text-payload-bytes must be a positive integer");
		}
	}
}

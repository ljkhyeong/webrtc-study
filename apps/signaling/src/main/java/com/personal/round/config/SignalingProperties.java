package com.personal.round.config;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "round.signaling")
public class SignalingProperties {

	private List<String> allowedOrigins = new ArrayList<>(
			List.of("http://localhost:5173", "http://127.0.0.1:5173"));
	private int maxRoomSize = 6;
	private long heartbeatIntervalMs = 30_000;
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

	public long getHeartbeatIntervalMs() {
		return heartbeatIntervalMs;
	}

	public void setHeartbeatIntervalMs(long heartbeatIntervalMs) {
		this.heartbeatIntervalMs = heartbeatIntervalMs;
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
		if (heartbeatIntervalMs < 1) {
			throw new IllegalArgumentException(
					"round.signaling.heartbeat-interval-ms must be a positive integer");
		}
		if (maxTextPayloadBytes < 1) {
			throw new IllegalArgumentException(
					"round.signaling.max-text-payload-bytes must be a positive integer");
		}
	}
}

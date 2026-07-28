package com.personal.round.signaling;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

@Component
public final class SignalingMetrics {

	private final AtomicInteger activeRooms = new AtomicInteger();
	private final AtomicInteger connectedPeers = new AtomicInteger();
	private final AtomicInteger joinedPeers = new AtomicInteger();
	private final Counter roomFullRejections;
	private final Counter alreadyJoinedRejections;
	private final Counter invalidFrames;
	private final Counter rateLimitedFrames;
	private final Counter overloadedFrames;
	private final Counter serverCapacityRejections;
	private final Counter clientCapacityRejections;
	private final Counter queueOverflows;
	private final Counter heartbeatCloses;

	public SignalingMetrics(MeterRegistry registry) {
		Gauge.builder("round.signaling.rooms.active", activeRooms, AtomicInteger::get)
				.description("Current number of non-empty signaling rooms")
				.register(registry);
		Gauge.builder("round.signaling.peers.connected", connectedPeers, AtomicInteger::get)
				.description("Current number of connected WebSocket peers")
				.register(registry);
		Gauge.builder("round.signaling.peers.joined", joinedPeers, AtomicInteger::get)
				.description("Current number of peers joined to a room")
				.register(registry);
		roomFullRejections = Counter.builder("round.signaling.joins.rejected")
				.tag("reason", "room_full")
				.description("Room join requests rejected by the signaling service")
				.register(registry);
		alreadyJoinedRejections = Counter.builder("round.signaling.joins.rejected")
				.tag("reason", "already_joined")
				.description("Room join requests rejected by the signaling service")
				.register(registry);
		invalidFrames = Counter.builder("round.signaling.frames.invalid")
				.description("Malformed, unsupported, or oversized inbound WebSocket frames")
				.register(registry);
		rateLimitedFrames = Counter.builder("round.signaling.frames.rate_limited")
				.description("Inbound WebSocket frames rejected by per-session abuse limits")
				.register(registry);
		overloadedFrames = Counter.builder("round.signaling.frames.overloaded")
				.description("Inbound WebSocket frames dropped by the global overload guard")
				.register(registry);
		serverCapacityRejections = Counter.builder("round.signaling.connections.rejected")
				.tag("reason", "server_capacity")
				.description("WebSocket handshakes rejected by connection admission")
				.register(registry);
		clientCapacityRejections = Counter.builder("round.signaling.connections.rejected")
				.tag("reason", "client_capacity")
				.description("WebSocket handshakes rejected by connection admission")
				.register(registry);
		queueOverflows = Counter.builder("round.signaling.outbound.queue.overflows")
				.description("Peers closed because their outbound queue overflowed")
				.register(registry);
		heartbeatCloses = Counter.builder("round.signaling.heartbeat.closes")
				.description("Peers closed after failing the heartbeat check")
				.register(registry);
	}

	void updateState(int rooms, int connected, int joined) {
		activeRooms.set(rooms);
		connectedPeers.set(connected);
		joinedPeers.set(joined);
	}

	void recordJoinRejectedRoomFull() {
		roomFullRejections.increment();
	}

	void recordJoinRejectedAlreadyJoined() {
		alreadyJoinedRejections.increment();
	}

	void recordInvalidFrame() {
		invalidFrames.increment();
	}

	void recordRateLimitedFrame() {
		rateLimitedFrames.increment();
	}

	void recordOverloadedFrame() {
		overloadedFrames.increment();
	}

	void recordConnectionRejectedServerCapacity() {
		serverCapacityRejections.increment();
	}

	void recordConnectionRejectedClientCapacity() {
		clientCapacityRejections.increment();
	}

	void recordQueueOverflow() {
		queueOverflows.increment();
	}

	void recordHeartbeatClose() {
		heartbeatCloses.increment();
	}
}

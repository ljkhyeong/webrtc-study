package com.personal.round.signaling;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.Meter.MeterProvider;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

@Component
public final class SignalingMetrics {

	private final AtomicInteger activeRooms = new AtomicInteger();
	private final AtomicInteger connectedPeers = new AtomicInteger();
	private final AtomicInteger joinedPeers = new AtomicInteger();
	private final AtomicLong outboundQueuedBytes = new AtomicLong();
	private final Counter roomFullRejections;
	private final Counter alreadyJoinedRejections;
	private final Counter unauthorizedRoomRejections;
	private final Counter invalidHostCapabilityRejections;
	private final Counter invalidFrames;
	private final Counter rateLimitedFrames;
	private final Counter clientRateLimitedFrames;
	private final Counter overloadedFrames;
	private final Counter sessionByteLimitedFrames;
	private final Counter clientByteLimitedFrames;
	private final Counter globalByteLimitedFrames;
	private final Counter serverCapacityRejections;
	private final Counter clientCapacityRejections;
	private final Counter participationTokenCapacityRejections;
	private final Counter participantRoomCapacityRejections;
	private final Counter missingReservationRejections;
	private final Counter missingRoomAccessRejections;
	private final Counter queueOverflows;
	private final Counter globalQueueOverflows;
	private final Counter heartbeatCloses;
	private final Counter authorizationCloses;

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
		Gauge.builder(
						"round.signaling.outbound.queue.bytes",
						outboundQueuedBytes,
						AtomicLong::get)
				.description("Current signaling bytes queued or in flight across all peers")
				.register(registry);
		MeterProvider<Counter> joinRejections = Counter.builder("round.signaling.joins.rejected")
				.description("Room join requests rejected by the signaling service")
				.withRegistry(registry);
		roomFullRejections = joinRejections.withTag("reason", "room_full");
		alreadyJoinedRejections = joinRejections.withTag("reason", "already_joined");
		unauthorizedRoomRejections = joinRejections.withTag("reason", "unauthorized_room");
		invalidHostCapabilityRejections = joinRejections.withTag("reason", "invalid_host_capability");
		invalidFrames = Counter.builder("round.signaling.frames.invalid")
				.description("Malformed, unsupported, or oversized inbound WebSocket frames")
				.register(registry);
		rateLimitedFrames = Counter.builder("round.signaling.frames.rate_limited")
				.description("Inbound WebSocket frames rejected by per-session abuse limits")
				.register(registry);
		clientRateLimitedFrames = Counter.builder(
						"round.signaling.frames.client_rate_limited")
				.description("Inbound WebSocket frames dropped by per-client abuse limits")
				.register(registry);
		overloadedFrames = Counter.builder("round.signaling.frames.overloaded")
				.description("Inbound WebSocket frames dropped by the global overload guard")
				.register(registry);
		sessionByteLimitedFrames = byteLimitCounter(registry, "session");
		clientByteLimitedFrames = byteLimitCounter(registry, "client");
		globalByteLimitedFrames = byteLimitCounter(registry, "global");
		MeterProvider<Counter> connectionRejections = Counter.builder("round.signaling.connections.rejected")
				.description("WebSocket handshakes rejected by connection admission")
				.withRegistry(registry);
		serverCapacityRejections = connectionRejections.withTag("reason", "server_capacity");
		clientCapacityRejections = connectionRejections.withTag("reason", "client_capacity");
		participationTokenCapacityRejections =
				connectionRejections.withTag("reason", "participation_token_capacity");
		participantRoomCapacityRejections =
				connectionRejections.withTag("reason", "participant_room_capacity");
		missingReservationRejections = connectionRejections.withTag("reason", "missing_reservation");
		missingRoomAccessRejections = connectionRejections.withTag("reason", "missing_room_access");
		queueOverflows = Counter.builder("round.signaling.outbound.queue.overflows")
				.description("Peers closed by per-peer or server-wide outbound queue limits")
				.register(registry);
		globalQueueOverflows = Counter.builder(
						"round.signaling.outbound.queue.global_overflows")
				.description("Outbound frames that encountered the server-wide byte budget")
				.register(registry);
		heartbeatCloses = Counter.builder("round.signaling.heartbeat.closes")
				.description("Peers closed after failing the heartbeat check")
				.register(registry);
		authorizationCloses = Counter.builder("round.signaling.authorization.closes")
				.description("WebSocket sessions closed because room authorization expired")
				.register(registry);
	}

	void updateState(int rooms, int connected, int joined) {
		activeRooms.set(rooms);
		connectedPeers.set(connected);
		joinedPeers.set(joined);
	}

	void updateOutboundQueuedBytes(long bytes) {
		outboundQueuedBytes.set(bytes);
	}

	void recordJoinRejectedRoomFull() {
		roomFullRejections.increment();
	}

	void recordJoinRejectedAlreadyJoined() {
		alreadyJoinedRejections.increment();
	}

	void recordJoinRejectedUnauthorizedRoom() {
		unauthorizedRoomRejections.increment();
	}

	void recordJoinRejectedInvalidHostCapability() {
		invalidHostCapabilityRejections.increment();
	}

	void recordInvalidFrame() {
		invalidFrames.increment();
	}

	void recordRateLimitedFrame() {
		rateLimitedFrames.increment();
	}

	void recordClientRateLimitedFrame() {
		clientRateLimitedFrames.increment();
	}

	void recordOverloadedFrame() {
		overloadedFrames.increment();
	}

	void recordSessionByteLimitedFrame() {
		sessionByteLimitedFrames.increment();
	}

	void recordClientByteLimitedFrame() {
		clientByteLimitedFrames.increment();
	}

	void recordGlobalByteLimitedFrame() {
		globalByteLimitedFrames.increment();
	}

	void recordConnectionRejectedServerCapacity() {
		serverCapacityRejections.increment();
	}

	void recordConnectionRejectedClientCapacity() {
		clientCapacityRejections.increment();
	}

	void recordConnectionRejectedParticipationTokenCapacity() {
		participationTokenCapacityRejections.increment();
	}

	void recordConnectionRejectedParticipantRoomCapacity() {
		participantRoomCapacityRejections.increment();
	}

	void recordConnectionRejectedMissingReservation() {
		missingReservationRejections.increment();
	}

	void recordConnectionRejectedMissingRoomAccess() {
		missingRoomAccessRejections.increment();
	}

	void recordQueueOverflow() {
		queueOverflows.increment();
	}

	void recordGlobalQueueOverflow() {
		globalQueueOverflows.increment();
	}

	void recordHeartbeatClose() {
		heartbeatCloses.increment();
	}

	void recordAuthorizationClose() {
		authorizationCloses.increment();
	}

	private static Counter byteLimitCounter(MeterRegistry registry, String scope) {
		return Counter.builder("round.signaling.frames.byte_limited")
				.tag("scope", scope)
				.description("Inbound WebSocket frames rejected by payload byte budgets")
				.register(registry);
	}
}

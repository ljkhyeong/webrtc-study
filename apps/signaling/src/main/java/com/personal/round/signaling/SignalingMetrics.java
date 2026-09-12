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
				.description("현재 참가자가 있는 시그널링 방 수")
				.register(registry);
		Gauge.builder("round.signaling.peers.connected", connectedPeers, AtomicInteger::get)
				.description("현재 연결된 WebSocket 참가자 수")
				.register(registry);
		Gauge.builder("round.signaling.peers.joined", joinedPeers, AtomicInteger::get)
				.description("현재 방에 입장한 참가자 수")
				.register(registry);
		Gauge.builder(
						"round.signaling.outbound.queue.bytes",
						outboundQueuedBytes,
						AtomicLong::get)
				.description("현재 전송 대기 중이거나 전송 중인 전체 시그널링 바이트 수")
				.register(registry);
		MeterProvider<Counter> joinRejections = Counter.builder("round.signaling.joins.rejected")
				.description("시그널링 서버가 거부한 방 입장 요청 수")
				.withRegistry(registry);
		roomFullRejections = joinRejections.withTag("reason", "room_full");
		alreadyJoinedRejections = joinRejections.withTag("reason", "already_joined");
		unauthorizedRoomRejections = joinRejections.withTag("reason", "unauthorized_room");
		invalidHostCapabilityRejections = joinRejections.withTag("reason", "invalid_host_capability");
		invalidFrames = Counter.builder("round.signaling.frames.invalid")
				.description("형식 오류, 미지원 또는 크기 초과로 거부한 수신 WebSocket 프레임 수")
				.register(registry);
		rateLimitedFrames = Counter.builder("round.signaling.frames.rate_limited")
				.description("세션별 수신량 제한으로 거부한 WebSocket 프레임 수")
				.register(registry);
		clientRateLimitedFrames = Counter.builder(
						"round.signaling.frames.client_rate_limited")
				.description("클라이언트별 수신량 제한으로 버린 WebSocket 프레임 수")
				.register(registry);
		overloadedFrames = Counter.builder("round.signaling.frames.overloaded")
				.description("서버 전체 수신량 제한으로 버린 WebSocket 프레임 수")
				.register(registry);
		MeterProvider<Counter> byteLimitedFrames = Counter.builder("round.signaling.frames.byte_limited")
				.description("본문 크기 한도로 거부한 수신 WebSocket 프레임 수")
				.withRegistry(registry);
		sessionByteLimitedFrames = byteLimitedFrames.withTag("scope", "session");
		clientByteLimitedFrames = byteLimitedFrames.withTag("scope", "client");
		globalByteLimitedFrames = byteLimitedFrames.withTag("scope", "global");
		MeterProvider<Counter> connectionRejections = Counter.builder("round.signaling.connections.rejected")
				.description("연결 한도 검사에서 거부한 WebSocket 연결 요청 수")
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
				.description("참가자별 또는 서버 전체 송신 큐 제한으로 종료한 연결 수")
				.register(registry);
		globalQueueOverflows = Counter.builder(
						"round.signaling.outbound.queue.global_overflows")
				.description("서버 전체 송신 바이트 한도를 초과한 프레임 수")
				.register(registry);
		heartbeatCloses = Counter.builder("round.signaling.heartbeat.closes")
				.description("연결 확인 실패로 종료한 참가자 연결 수")
				.register(registry);
		authorizationCloses = Counter.builder("round.signaling.authorization.closes")
				.description("방 참여 권한 만료로 종료한 WebSocket 세션 수")
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
}

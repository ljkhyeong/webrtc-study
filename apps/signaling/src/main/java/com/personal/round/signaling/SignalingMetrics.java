package com.personal.round.signaling;

import static com.personal.round.signaling.SignalingInboundLimiter.Decision.CLIENT_BYTE_LIMITED;
import static com.personal.round.signaling.SignalingInboundLimiter.Decision.CLIENT_FRAME_LIMITED;
import static com.personal.round.signaling.SignalingInboundLimiter.Decision.GLOBAL_BYTE_LIMITED;
import static com.personal.round.signaling.SignalingInboundLimiter.Decision.GLOBAL_FRAME_LIMITED;
import static com.personal.round.signaling.SignalingInboundLimiter.Decision.SESSION_BYTE_LIMITED;
import static com.personal.round.signaling.SignalingInboundLimiter.Decision.SESSION_FRAME_LIMITED;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Meter.MeterProvider;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

/** 시그널링 카운터를 등록한다. 방·연결 수 게이지는 {@link SignalingService}가 상태를 직접 읽어 등록한다. */
@Component
public final class SignalingMetrics {

	private final Map<JoinRejection, Counter> joinRejections = new EnumMap<>(JoinRejection.class);
	private final Counter invalidFrames;
	private final Map<SignalingInboundLimiter.Decision, Counter> limitedFrames =
			new EnumMap<>(SignalingInboundLimiter.Decision.class);
	private final Map<ConnectionAdmissionPolicy.Rejection, Counter> capacityRejections =
			new EnumMap<>(ConnectionAdmissionPolicy.Rejection.class);
	private final Counter missingReservationRejections;
	private final Counter missingRoomAccessRejections;
	private final Counter queueOverflows;
	private final Counter globalQueueOverflows;
	private final Counter heartbeatCloses;
	private final Counter authorizationCloses;

	public SignalingMetrics(MeterRegistry registry) {
		MeterProvider<Counter> joinRejectionCounters = Counter.builder("round.signaling.joins.rejected")
				.description("시그널링 서버가 거부한 방 입장 요청 수")
				.withRegistry(registry);
		for (JoinRejection rejection : JoinRejection.values()) {
			joinRejections.put(
					rejection,
					joinRejectionCounters.withTag("reason", rejection.name().toLowerCase(Locale.ROOT)));
		}
		invalidFrames = Counter.builder("round.signaling.frames.invalid")
				.description("형식 오류, 미지원 또는 크기 초과로 거부한 수신 WebSocket 프레임 수")
				.register(registry);
		MeterProvider<Counter> frameLimits = Counter.builder("round.signaling.frames.limited")
				.description("세션·클라이언트·서버 전체 수신 한도로 거부하거나 버린 WebSocket 프레임 수")
				.withRegistry(registry);
		limitedFrames.put(SESSION_FRAME_LIMITED, frameLimits.withTags("scope", "session", "limit", "frames"));
		limitedFrames.put(SESSION_BYTE_LIMITED, frameLimits.withTags("scope", "session", "limit", "bytes"));
		limitedFrames.put(CLIENT_FRAME_LIMITED, frameLimits.withTags("scope", "client", "limit", "frames"));
		limitedFrames.put(CLIENT_BYTE_LIMITED, frameLimits.withTags("scope", "client", "limit", "bytes"));
		limitedFrames.put(GLOBAL_FRAME_LIMITED, frameLimits.withTags("scope", "global", "limit", "frames"));
		limitedFrames.put(GLOBAL_BYTE_LIMITED, frameLimits.withTags("scope", "global", "limit", "bytes"));
		MeterProvider<Counter> connectionRejections = Counter.builder("round.signaling.connections.rejected")
				.description("연결 한도 검사에서 거부한 WebSocket 연결 요청 수")
				.withRegistry(registry);
		for (ConnectionAdmissionPolicy.Rejection rejection : ConnectionAdmissionPolicy.Rejection.values()) {
			capacityRejections.put(
					rejection,
					connectionRejections.withTag("reason", rejection.name().toLowerCase(Locale.ROOT)));
		}
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

	void recordJoinRejected(JoinRejection rejection) {
		joinRejections.get(rejection).increment();
	}

	void recordInvalidFrame() {
		invalidFrames.increment();
	}

	void recordInboundLimited(SignalingInboundLimiter.Decision decision) {
		limitedFrames.get(decision).increment();
	}

	void recordConnectionRejected(ConnectionAdmissionPolicy.Rejection rejection) {
		capacityRejections.get(rejection).increment();
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

	/** 소문자 상수 이름이 round.signaling.joins.rejected 지표의 reason 태그다. */
	enum JoinRejection {
		ROOM_FULL,
		ALREADY_JOINED,
		UNAUTHORIZED_ROOM,
		INVALID_HOST_CAPABILITY
	}
}

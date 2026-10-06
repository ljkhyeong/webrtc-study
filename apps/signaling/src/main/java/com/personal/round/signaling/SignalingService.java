package com.personal.round.signaling;

import com.personal.round.auth.RoomAccess;
import com.personal.round.auth.RoomAccessPolicy;
import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.SignalingExecutionConfig;
import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ServerMessageEncoder;
import com.personal.round.protocol.ServerMessageEncoder.Participant;
import com.personal.round.protocol.SignalingErrorCode;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.binder.MeterBinder;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.crypto.keygen.BytesKeyGenerator;
import org.springframework.security.crypto.keygen.KeyGenerators;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

@Service
public class SignalingService implements SmartLifecycle, MeterBinder {

	private static final Logger log = LoggerFactory.getLogger(SignalingService.class);
	private static final String CLOSE_DECISION_ATTRIBUTE =
			SignalingService.class.getName() + ".closeDecision";
	private static final CloseStatus HEARTBEAT_TIMEOUT =
			new CloseStatus(4000, "Heartbeat timeout");
	private static final CloseStatus SERVER_SHUTDOWN =
			CloseStatus.GOING_AWAY.withReason("Server shutting down");
	private static final CloseStatus OUTBOUND_QUEUE_OVERFLOW =
			CloseStatus.SERVER_ERROR.withReason("Outbound queue overflow");
	private static final CloseStatus JOIN_TIMEOUT =
			CloseStatus.POLICY_VIOLATION.withReason("Room join timeout");
	private static final CloseStatus RATE_LIMITED =
			CloseStatus.POLICY_VIOLATION.withReason("Inbound frame rate exceeded");
	private static final CloseStatus ADMISSION_REQUIRED =
			CloseStatus.SERVER_ERROR.withReason("Connection admission required");
	private static final CloseStatus ROOM_ACCESS_REQUIRED =
			CloseStatus.POLICY_VIOLATION.withReason("Room authorization required");
	private static final CloseStatus PARTICIPATION_GRANT_EXPIRED =
			new CloseStatus(4001, "Participation grant expired");
	private static final CloseStatus PARTICIPATION_SESSION_SUPERSEDED =
			new CloseStatus(4002, "Participation session superseded");
	private static final long UNSET_NANOS = Long.MIN_VALUE;
	private static final BytesKeyGenerator HEARTBEAT_CHALLENGE_GENERATOR =
			KeyGenerators.secureRandom(2 * Long.BYTES);

	private final Object monitor = new Object();
	private final Map<String, Peer> connectedPeers = new HashMap<>();
	private final Map<String, LinkedHashMap<String, Peer>> rooms = new HashMap<>();
	private final Map<String, RoomStudyState> studyStates = new HashMap<>();
	private final Map<String, RoomHandQueue> handQueues = new HashMap<>();
	// 대체된 피어는 방 상태에서 즉시 제거하지만 close가 반환될 때까지 입장 예약은 유지한다.
	private final Map<String, Peer> pendingTerminalCleanup = new HashMap<>();
	private final SignalingOutboundDispatcher<Peer> outboundDispatcher;
	private final ServerMessageEncoder serverMessageEncoder;
	private final SignalingMetrics metrics;
	private final RoomAccessPolicy roomAccessPolicy;
	private final Clock clock;
	private final LongSupplier monotonicTicker;
	private final int maxRoomSize;
	private final long heartbeatIntervalNanos;
	private final long unjoinedTimeoutNanos;
	private final long shutdownCloseTimeoutMs;
	private final SignalingInboundLimiter inboundLimiter;
	private long nextConnectionSequence;
	private volatile boolean running;

	public SignalingService(
			ServerMessageEncoder serverMessageEncoder,
			SignalingProperties properties,
			SignalingMetrics metrics,
			RoomAccessPolicy roomAccessPolicy,
			@Qualifier(SignalingExecutionConfig.OUTBOUND_EXECUTOR_BEAN)
			ExecutorService outboundExecutor,
			Clock clock,
			LongSupplier monotonicTicker) {
		this.serverMessageEncoder = serverMessageEncoder;
		this.metrics = metrics;
		this.roomAccessPolicy = roomAccessPolicy;
		this.clock = clock;
		this.monotonicTicker = monotonicTicker;
		this.maxRoomSize = properties.maxRoomSize();
		this.heartbeatIntervalNanos = properties.heartbeatInterval().toNanos();
		this.unjoinedTimeoutNanos = properties.unjoinedTimeout().toNanos();
		this.shutdownCloseTimeoutMs = properties.shutdownCloseTimeout().toMillis();
		this.inboundLimiter = new SignalingInboundLimiter(properties);
		this.outboundDispatcher = new SignalingOutboundDispatcher<>(
				monitor,
				outboundExecutor,
				monotonicTicker,
				properties.maxOutboundQueueBytes(),
				properties.maxOutboundQueueBytesGlobal(),
				this::handleOutboundSendFailure);
	}

	public boolean connect(WebSocketSession session) {
		ConnectionAdmissionPolicy.Reservation reservation = takeReservation(session);
		boolean reservationTransferred = false;
		try {
			WorkPlan workPlan = new WorkPlan();
			if (reservation == null) {
				log.error("WebSocket connection reached signaling without an admission reservation");
				metrics.recordConnectionRejectedMissingReservation();
				workPlan.close(session, ADMISSION_REQUIRED);
				execute(workPlan);
				return false;
			}
			RoomAccess roomAccess = roomAccessPolicy.resolve(session).orElse(null);
			if (roomAccess == null) {
				log.warn("WebSocket connection reached signaling without verified room access");
				metrics.recordConnectionRejectedMissingRoomAccess();
				workPlan.close(session, ROOM_ACCESS_REQUIRED);
				execute(workPlan);
				return false;
			}

			boolean accepted;
			synchronized (monitor) {
				long nowMillis = clock.millis();
				long nowNanos = monotonicTicker.getAsLong();
				RoomAccess.Lease accessLease = roomAccess.openLease(nowMillis, nowNanos);
				inboundLimiter.removeExpiredInactive(nowNanos);
				if (accessLease.isExpired(nowMillis, nowNanos)) {
					metrics.recordAuthorizationClose();
					workPlan.close(session, PARTICIPATION_GRANT_EXPIRED);
					accepted = false;
				}
				else if (!running) {
					workPlan.close(session, SERVER_SHUTDOWN);
					accepted = false;
				}
				else {
					SessionCloseDecision closeDecision = new SessionCloseDecision();
					session.getAttributes().put(CLOSE_DECISION_ATTRIBUTE, closeDecision);
					connectedPeers.put(
							session.getId(),
							new Peer(
									UUID.randomUUID().toString(),
									session,
									nowNanos,
									nextConnectionSequence++,
									reservation,
									roomAccess,
									accessLease,
									closeDecision,
									inboundLimiter.retain(reservation.clientKey())));
					reservationTransferred = true;
					accepted = true;
				}
			}
			execute(workPlan);
			return accepted;
		}
		finally {
			if (reservation != null && !reservationTransferred) {
				reservation.close();
			}
		}
	}

	public boolean acceptInboundFrame(WebSocketSession session, int payloadBytes) {
		WorkPlan workPlan = new WorkPlan();
		boolean accepted = false;
		synchronized (monitor) {
			long nowMillis = clock.millis();
			long nowNanos = monotonicTicker.getAsLong();
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null
					&& !closeForExpiredAuthorizationLocked(peer, nowMillis, nowNanos, workPlan, null)) {
				SignalingInboundLimiter.Decision decision =
						inboundLimiter.tryAcquire(peer.inboundLimit, nowNanos, payloadBytes);
				switch (decision) {
					case ACCEPTED -> accepted = true;
					case SESSION_FRAME_LIMITED, SESSION_BYTE_LIMITED -> {
						metrics.recordInboundLimited(decision);
						disconnectAndCloseLocked(peer, RATE_LIMITED, workPlan);
					}
					case CLIENT_FRAME_LIMITED,
							CLIENT_BYTE_LIMITED,
							GLOBAL_FRAME_LIMITED,
							GLOBAL_BYTE_LIMITED -> metrics.recordInboundLimited(decision);
				}
			}
		}
		execute(workPlan);
		return accepted;
	}

	public void handle(WebSocketSession session, ClientMessage message) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer == null) {
				scheduleCloseLocked(session, CloseStatus.SERVER_ERROR, workPlan);
			}
			else if (!closeForExpiredAuthorizationLocked(peer, workPlan)) {
				switch (message) {
					case ClientMessage.Join join -> join(peer, join, workPlan);
					case ClientMessage.Leave leave -> leave(peer, leave, workPlan);
					case ClientMessage.Relay relay -> relay(peer, relay, workPlan);
					case ClientMessage.Reconnect reconnect -> reconnect(peer, reconnect, workPlan);
					case ClientMessage.Study study -> study(peer, study, workPlan);
					case ClientMessage.Hand hand -> hand(peer, hand, workPlan);
					case ClientMessage.Moderation moderation -> moderate(peer, moderation, workPlan);
				}
			}
		}
		execute(workPlan);
	}

	public void sendInvalidMessage(WebSocketSession session, String detail) {
		metrics.recordInvalidFrame();
		sendSessionError(session, SignalingErrorCode.INVALID_MESSAGE, detail);
	}

	public void recordInvalidFrame() {
		metrics.recordInvalidFrame();
	}

	public void sendInternalError(WebSocketSession session) {
		sendSessionError(
				session,
				SignalingErrorCode.INTERNAL_ERROR,
				"The signaling server could not process this message.");
	}

	private void sendSessionError(
			WebSocketSession session,
			SignalingErrorCode code,
			String detail) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null) {
				sendError(peer, code, detail, peer.roomId, null, workPlan);
			}
		}
		execute(workPlan);
	}

	// 기대 응답값은 ping 대기 상태에서만 있다. 같은 연결에 평문으로 보낸 값이라 상수 시간 비교가 필요 없다.
	public void markAlive(WebSocketSession session, ByteBuffer pongPayload) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null
					&& !closeForExpiredAuthorizationLocked(peer, workPlan)
					&& peer.expectedPongPayload != null
					&& ByteBuffer.wrap(peer.expectedPongPayload).equals(pongPayload)) {
				peer.heartbeatState = HeartbeatState.READY;
				peer.expectedPongPayload = null;
			}
		}
		execute(workPlan);
	}

	@Scheduled(fixedDelayString = "${round.signaling.heartbeat-interval}")
	public void heartbeatSweep() {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			long nowMillis = clock.millis();
			long nowNanos = monotonicTicker.getAsLong();
			for (Peer peer : new ArrayList<>(connectedPeers.values())) {
				if (!peer.connected) {
					continue;
				}
				if (closeForExpiredAuthorizationLocked(peer, nowMillis, nowNanos, workPlan, null)) {
					continue;
				}
				switch (peer.heartbeatState) {
					case READY -> {
						byte[] challenge = HEARTBEAT_CHALLENGE_GENERATOR.generateKey();
						if (enqueue(
								peer,
								new PingMessage(ByteBuffer.wrap(challenge)),
								workPlan)) {
							peer.heartbeatState = HeartbeatState.PING_QUEUED;
							peer.heartbeatPhaseStartedAtNanos = nowNanos;
							peer.expectedPongPayload = challenge;
						}
					}
					case PING_QUEUED, AWAITING_PONG -> {
						if (elapsedAtLeast(
								nowNanos,
								peer.heartbeatPhaseStartedAtNanos,
								heartbeatIntervalNanos)) {
							metrics.recordHeartbeatClose();
							disconnectAndCloseLocked(peer, HEARTBEAT_TIMEOUT, workPlan);
						}
					}
				}
			}
		}
		execute(workPlan);
	}

	@Scheduled(fixedDelayString = "${round.signaling.unjoined-sweep-interval}")
	public void expireUnjoinedSessions() {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			long nowMillis = clock.millis();
			long nowNanos = monotonicTicker.getAsLong();
			for (Peer peer : new ArrayList<>(connectedPeers.values())) {
				if (!peer.connected) {
					continue;
				}
				if (closeForExpiredAuthorizationLocked(peer, nowMillis, nowNanos, workPlan, null)) {
					continue;
				}
				if (elapsedAtLeast(
						nowNanos,
						peer.unjoinedSinceNanos,
						unjoinedTimeoutNanos)) {
					disconnectAndCloseLocked(peer, JOIN_TIMEOUT, workPlan);
				}
			}
			inboundLimiter.removeExpiredInactive(nowNanos);
		}
		execute(workPlan);
	}

	public void disconnect(WebSocketSession session) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			disconnectLocked(session.getId(), workPlan, true, null);
		}
		execute(workPlan);
	}

	public void disconnectAndClose(WebSocketSession session, CloseStatus requestedStatus) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer == null) {
				scheduleCloseLocked(session, requestedStatus, workPlan);
			}
			else {
				disconnectAndCloseLocked(peer, requestedStatus, workPlan);
			}
		}
		execute(workPlan);
	}

	int participantCount(String roomId) {
		synchronized (monitor) {
			Map<String, Peer> room = rooms.get(roomId);
			return room == null ? 0 : room.size();
		}
	}

	public int roomCount() {
		synchronized (monitor) {
			return rooms.size();
		}
	}

	public int connectedPeerCount() {
		synchronized (monitor) {
			return connectedPeers.size();
		}
	}

	private int joinedPeerCount() {
		synchronized (monitor) {
			return rooms.values().stream().mapToInt(Map::size).sum();
		}
	}

	private long outboundQueuedBytes() {
		synchronized (monitor) {
			return outboundDispatcher.queuedBytesLocked();
		}
	}

	@Override
	public void bindTo(MeterRegistry registry) {
		Gauge.builder("round.signaling.rooms.active", this, SignalingService::roomCount)
				.description("현재 참가자가 있는 시그널링 방 수")
				.register(registry);
		Gauge.builder("round.signaling.peers.connected", this, SignalingService::connectedPeerCount)
				.description("현재 연결된 WebSocket 참가자 수")
				.register(registry);
		Gauge.builder("round.signaling.peers.joined", this, SignalingService::joinedPeerCount)
				.description("현재 방에 입장한 참가자 수")
				.register(registry);
		Gauge.builder("round.signaling.outbound.queue.bytes", this, SignalingService::outboundQueuedBytes)
				.description("현재 전송 대기 중이거나 전송 중인 전체 시그널링 바이트 수")
				.register(registry);
	}

	int trackedInboundClientCount() {
		synchronized (monitor) {
			return inboundLimiter.trackedClientCount();
		}
	}

	private void join(Peer peer, ClientMessage.Join message, WorkPlan workPlan) {
		if (peer.roomId != null) {
			metrics.recordJoinRejected(SignalingMetrics.JoinRejection.ALREADY_JOINED);
			sendError(
					peer,
					SignalingErrorCode.ALREADY_JOINED,
					"Leave the current room before joining another room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomAccess.allows(message.roomId())) {
			metrics.recordJoinRejected(SignalingMetrics.JoinRejection.UNAUTHORIZED_ROOM);
			sendError(
					peer,
					SignalingErrorCode.ROOM_MISMATCH,
					"The requested room is outside this connection's authorization.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		Optional<ParticipationGrant.Role> resolvedRole =
				peer.roomAccess.roleFor(message.hostCapability());
		if (resolvedRole.isEmpty()) {
			metrics.recordJoinRejected(SignalingMetrics.JoinRejection.INVALID_HOST_CAPABILITY);
			sendError(
					peer,
					SignalingErrorCode.FORBIDDEN,
					"The supplied host capability is not valid for this connection.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}

		Peer existingParticipationSession = findSameBatonParticipant(peer, rooms.get(message.roomId()));
		if (existingParticipationSession != null) {
			if (peer.connectionSequence < existingParticipationSession.connectionSequence) {
				disconnectAndCloseLocked(peer, PARTICIPATION_SESSION_SUPERSEDED, workPlan);
				return;
			}
			// 단독 참가자를 교체하면 방이 비워져 스터디 상태도 지워지므로 이어서 쓸 상태를 먼저 잡아 둔다.
			RoomStudyState previousStudy = studyStates.get(message.roomId());
			disconnectAndCloseLocked(existingParticipationSession, PARTICIPATION_SESSION_SUPERSEDED, workPlan);
			if (!peer.connected) {
				return;
			}
			if (previousStudy != null) {
				studyStates.putIfAbsent(message.roomId(), previousStudy);
			}
		}
		LinkedHashMap<String, Peer> room = rooms.computeIfAbsent(
				message.roomId(), ignored -> new LinkedHashMap<>());
		if (room.size() >= maxRoomSize) {
			metrics.recordJoinRejected(SignalingMetrics.JoinRejection.ROOM_FULL);
			sendError(
					peer,
					SignalingErrorCode.ROOM_FULL,
					"This room is limited to " + maxRoomSize + " participants.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}

		List<Participant> participants = room.values().stream()
				.map(existing -> new Participant(existing.peerId, existing.displayName, existing.role))
				.toList();
		peer.roomId = message.roomId();
		peer.displayName = message.displayName();
		peer.role = resolvedRole.orElseThrow();
		peer.unjoinedSinceNanos = UNSET_NANOS;
		room.put(peer.peerId, peer);

		TextMessage joined = serverMessageEncoder.roomJoined(
				message.roomId(),
				message.requestId(),
				peer.peerId,
				peer.role,
				participants);
		if (!enqueue(peer, joined, workPlan)) {
			return;
		}
		peer.announced = true;

		TextMessage peerJoined = serverMessageEncoder.peerJoined(
				message.roomId(),
				new Participant(peer.peerId, peer.displayName, peer.role));
		broadcast(room, peerJoined, peer.peerId, workPlan);
	}

	private static Peer findSameBatonParticipant(
			Peer joiningPeer,
			Map<String, Peer> room) {
		if (room == null || !(joiningPeer.roomAccess instanceof ParticipationGrant joiningGrant)) {
			return null;
		}
		return room.values().stream()
				.filter(existing ->
						existing.roomAccess instanceof ParticipationGrant existingGrant
								&& existingGrant.subject().equals(joiningGrant.subject()))
				.findFirst()
				.orElse(null);
	}

	private void leave(Peer peer, ClientMessage.Leave message, WorkPlan workPlan) {
		if (!requireJoinedRoom(peer, message,
				"Join a room before leaving it.",
				"The message room does not match the joined room.", workPlan)) {
			return;
		}
		removePeerFromRoom(peer, workPlan, null);
	}

	private void relay(Peer peer, ClientMessage.Relay message, WorkPlan workPlan) {
		Peer target = negotiationTarget(peer, message, message.to(), workPlan);
		if (target == null) {
			return;
		}

		enqueue(
				target,
				serverMessageEncoder.relay(
						message.type(),
						peer.roomId,
						peer.peerId,
						message.payload()),
				workPlan);
	}

	private void reconnect(Peer peer, ClientMessage.Reconnect message, WorkPlan workPlan) {
		Peer target = negotiationTarget(peer, message, message.to(), workPlan);
		if (target == null) {
			return;
		}

		if (closeForExpiredAuthorizationLocked(target, workPlan)) {
			sendError(peer, SignalingErrorCode.TARGET_NOT_FOUND, "상대가 방을 나갔습니다.",
					peer.roomId, message.requestId(), workPlan);
			return;
		}
		String connectionId = UUID.randomUUID().toString();
		boolean initiator = peer.peerId.compareTo(target.peerId) < 0;
		// 같은 작업 계획에서 양쪽에 새 연결 번호를 보내 동시 재연결 순서를 맞춘다.
		if (enqueue(target, serverMessageEncoder.peerReconnect(
				peer.roomId, peer.peerId, connectionId, !initiator), workPlan)) {
			enqueue(peer, serverMessageEncoder.peerReconnect(
					peer.roomId, target.peerId, connectionId, initiator), workPlan);
		}
	}

	private Peer negotiationTarget(
			Peer peer,
			ClientMessage message,
			String targetPeerId,
			WorkPlan workPlan) {
		if (!requireJoinedRoom(peer, message,
				"Join a room before sending negotiation messages.",
				"The message room does not match the joined room.", workPlan)) {
			return null;
		}
		return findTargetInRoom(peer, message, targetPeerId,
				"A peer cannot relay a negotiation message to itself.", workPlan);
	}

	private void hand(Peer peer, ClientMessage.Hand message, WorkPlan workPlan) {
		if (!requireJoinedRoom(peer, message,
				"방에 먼저 입장해 주세요.",
				"입장한 방과 요청한 방이 다릅니다.", workPlan)) {
			return;
		}
		RoomHandQueue queue = handQueues.computeIfAbsent(peer.roomId, ignored -> new RoomHandQueue());
		boolean changed = message.raised() != null && queue.update(peer.peerId, message.raised());
		TextMessage state = serverMessageEncoder.handState(peer.roomId, message.requestId(), queue.snapshot());
		if (changed) broadcast(rooms.get(peer.roomId), state, null, workPlan);
		else enqueue(peer, state, workPlan);
	}

	private void study(Peer peer, ClientMessage.Study message, WorkPlan workPlan) {
		if (!requireJoinedRoom(peer, message,
				"방에 먼저 입장해 주세요.",
				"입장한 방과 요청한 방이 다릅니다.", workPlan)) {
			return;
		}
		if (message.command() != null && peer.role != ParticipationGrant.Role.HOST) {
			sendError(peer, SignalingErrorCode.FORBIDDEN, "방장만 타이머와 주제를 변경할 수 있습니다.", peer.roomId, message.requestId(), workPlan);
			return;
		}
		RoomStudyState state = studyStates.computeIfAbsent(peer.roomId, ignored -> new RoomStudyState());
		long now = monotonicTicker.getAsLong();
		boolean applied = message.command() != null && state.apply(message.command(), now);
		boolean conflict = message.command() != null && !applied;
		TextMessage response = serverMessageEncoder.studyState(peer.roomId, message.requestId(), state.snapshot(now), conflict);
		if (applied) broadcast(rooms.get(peer.roomId), response, null, workPlan);
		else enqueue(peer, response, workPlan);
	}

	private void moderate(
			Peer peer,
			ClientMessage.Moderation message,
			WorkPlan workPlan) {
		if (!requireJoinedRoom(peer, message,
				"Join a room before moderating participant media.",
				"The message room does not match the joined room.", workPlan)) {
			return;
		}
		if (peer.role != ParticipationGrant.Role.HOST) {
			sendError(
					peer,
					SignalingErrorCode.FORBIDDEN,
					"Only a room host may disable participant media.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		Peer target = findTargetInRoom(peer, message, message.to(),
				"A host cannot moderate its own media through a remote command.", workPlan);
		if (target == null) {
			return;
		}

		if (target.role != ParticipationGrant.Role.PARTICIPANT) {
			sendError(
					peer,
					SignalingErrorCode.FORBIDDEN,
					"A host cannot disable another host's media.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}

		TextMessage disabled = serverMessageEncoder.moderationMediaDisabled(
				peer.roomId,
				message.requestId(),
				peer.peerId,
				target.peerId,
				message.kind());
		enqueue(target, disabled, workPlan);
	}

	private boolean requireJoinedRoom(
			Peer peer,
			ClientMessage message,
			String notInRoomMessage,
			String roomMismatchMessage,
			WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(peer, SignalingErrorCode.NOT_IN_ROOM, notInRoomMessage,
					message.roomId(), message.requestId(), workPlan);
			return false;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(peer, SignalingErrorCode.ROOM_MISMATCH, roomMismatchMessage,
					peer.roomId, message.requestId(), workPlan);
			return false;
		}
		return true;
	}

	private Peer findTargetInRoom(
			Peer peer,
			ClientMessage message,
			String targetPeerId,
			String selfTargetMessage,
			WorkPlan workPlan) {
		if (peer.peerId.equals(targetPeerId)) {
			sendError(peer, SignalingErrorCode.TARGET_SELF, selfTargetMessage,
					peer.roomId, message.requestId(), workPlan);
			return null;
		}
		Map<String, Peer> room = rooms.get(peer.roomId);
		Peer target = room == null ? null : room.get(targetPeerId);
		if (target == null) {
			sendError(peer, SignalingErrorCode.TARGET_NOT_FOUND,
					"The target peer is not in this room.",
					peer.roomId, message.requestId(), workPlan);
		}
		return target;
	}

	private boolean closeForExpiredAuthorizationLocked(Peer peer, WorkPlan workPlan) {
		return closeForExpiredAuthorizationLocked(
				peer,
				clock.millis(),
				monotonicTicker.getAsLong(),
				workPlan,
				null);
	}

	private boolean closeForExpiredAuthorizationLocked(
			Peer peer,
			long currentEpochMillis,
			long currentMonotonicNanos,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		if (!peer.accessLease.isExpired(currentEpochMillis, currentMonotonicNanos)) {
			return false;
		}
		if (disconnectAndCloseLocked(
				peer,
				PARTICIPATION_GRANT_EXPIRED,
				workPlan,
				pendingOutbound)) {
			metrics.recordAuthorizationClose();
		}
		return true;
	}

	private boolean disconnectLocked(
			String sessionId,
			WorkPlan workPlan,
			boolean releaseReservation,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		Peer peer = connectedPeers.remove(sessionId);
		if (peer != null) {
			peer.connected = false;
			if (releaseReservation) {
				peer.reservation.close();
			}
			else {
				pendingTerminalCleanup.put(sessionId, peer);
			}
			inboundLimiter.release(peer.inboundLimit);
			outboundDispatcher.clearLocked(peer);
			removePeerFromRoom(peer, workPlan, pendingOutbound);
			return true;
		}
		return false;
	}

	private boolean disconnectAndCloseLocked(
			Peer peer,
			CloseStatus requestedStatus,
			WorkPlan workPlan) {
		return disconnectAndCloseLocked(peer, requestedStatus, workPlan, null);
	}

	private boolean disconnectAndCloseLocked(
			Peer peer,
			CloseStatus requestedStatus,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		boolean terminalSupersession = PARTICIPATION_SESSION_SUPERSEDED.equals(requestedStatus);
		if (terminalSupersession) {
			peer.closeDecision.terminalStatus = PARTICIPATION_SESSION_SUPERSEDED;
		}
		boolean disconnected = disconnectLocked(
				peer.session.getId(),
				workPlan,
				!terminalSupersession,
				pendingOutbound);
		scheduleCloseLocked(peer.session, requestedStatus, workPlan);
		return disconnected;
	}

	private void scheduleCloseLocked(
			WebSocketSession session,
			CloseStatus requestedStatus,
			WorkPlan workPlan) {
		SessionCloseDecision closeDecision = closeDecision(session);
		if (closeDecision != null && closeDecision.closeInProgress) {
			return;
		}
		if (closeDecision != null) {
			closeDecision.closeInProgress = true;
		}
		workPlan.close(session, requestedStatus, closeDecision);
	}

	private static SessionCloseDecision closeDecision(WebSocketSession session) {
		Object candidate = session.getAttributes().get(CLOSE_DECISION_ATTRIBUTE);
		return candidate instanceof SessionCloseDecision closeDecision
				? closeDecision
				: null;
	}

	private void removePeerFromRoom(
			Peer peer,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		if (peer.roomId == null) {
			return;
		}

		String roomId = peer.roomId;
		boolean wasAnnounced = peer.announced;
		peer.roomId = null;
		peer.displayName = null;
		peer.role = null;
		peer.announced = false;
		if (peer.connected) {
			peer.unjoinedSinceNanos = monotonicTicker.getAsLong();
		}
		LinkedHashMap<String, Peer> room = rooms.get(roomId);
		if (room == null || room.remove(peer.peerId) == null) {
			return;
		}
		if (room.isEmpty()) {
			rooms.remove(roomId, room);
			studyStates.remove(roomId);
			handQueues.remove(roomId);
			return;
		}
		if (!wasAnnounced) {
			return;
		}

		TextMessage left = serverMessageEncoder.peerLeft(roomId, peer.peerId);
		ArrayDeque<PendingOutbound> pending = pendingOutbound == null ? new ArrayDeque<>() : pendingOutbound;
		appendBroadcast(room, left, null, pending);
		RoomHandQueue queue = handQueues.get(roomId);
		if (queue != null && queue.update(peer.peerId, false)) {
			appendBroadcast(room, serverMessageEncoder.handState(roomId, null, queue.snapshot()), null, pending);
		}
		if (pendingOutbound == null) enqueueAllLocked(pending, workPlan);
	}

	private void broadcast(
			Map<String, Peer> room,
			TextMessage message,
			String excludedPeerId,
			WorkPlan workPlan) {
		ArrayDeque<PendingOutbound> pendingOutbound = new ArrayDeque<>();
		appendBroadcast(room, message, excludedPeerId, pendingOutbound);
		enqueueAllLocked(pendingOutbound, workPlan);
	}

	private static void appendBroadcast(
			Map<String, Peer> room,
			WebSocketMessage<?> message,
			String excludedPeerId,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		for (Peer target : room.values()) {
			if (!target.peerId.equals(excludedPeerId)) {
				pendingOutbound.addLast(new PendingOutbound(target, message));
			}
		}
	}

	private void sendError(
			Peer peer,
			SignalingErrorCode code,
			String message,
			String roomId,
			String requestId,
			WorkPlan workPlan) {
		enqueue(peer, serverMessageEncoder.error(code, message, roomId, requestId), workPlan);
	}

	private boolean enqueue(
			Peer peer,
			WebSocketMessage<?> message,
			WorkPlan workPlan) {
		PendingOutbound outbound = new PendingOutbound(peer, message);
		ArrayDeque<PendingOutbound> pendingOutbound = new ArrayDeque<>();
		pendingOutbound.addLast(outbound);
		enqueueAllLocked(pendingOutbound, workPlan);
		return outbound.accepted && peer.connected;
	}

	private void enqueueAllLocked(
			ArrayDeque<PendingOutbound> pendingOutbound,
			WorkPlan workPlan) {
		// 송신 큐 초과로 생긴 추가 퇴장은 원래 메시지 다음에 처리한다.
		// 재귀 호출 없이 순서대로 처리해 퇴장 알림의 순서를 유지한다.
		while (!pendingOutbound.isEmpty()) {
			PendingOutbound outbound = pendingOutbound.removeFirst();
			outbound.accepted = enqueueOneLocked(
					outbound.peer,
					outbound.message,
					workPlan,
					pendingOutbound);
		}
	}

	private boolean enqueueOneLocked(
			Peer peer,
			WebSocketMessage<?> message,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		if (!peer.connected
				|| closeForExpiredAuthorizationLocked(
						peer,
						clock.millis(),
						monotonicTicker.getAsLong(),
						workPlan,
						pendingOutbound)) {
			return false;
		}

		int messageBytes = message.getPayloadLength();
		boolean overflow = outboundDispatcher.peerLimitExceededLocked(peer, messageBytes);
		if (!overflow && outboundDispatcher.globalLimitExceededLocked(messageBytes)) {
			metrics.recordGlobalQueueOverflow();
			for (Peer victim : outboundDispatcher.globalPressureVictimsLocked(
					connectedPeers.values(),
					messageBytes)) {
				closeForOutboundOverflowLocked(victim, workPlan, pendingOutbound);
				if (!peer.connected) {
					return false;
				}
			}
			overflow = outboundDispatcher.globalLimitExceededLocked(messageBytes);
		}
		if (overflow) {
			closeForOutboundOverflowLocked(peer, workPlan, pendingOutbound);
			return false;
		}

		if (outboundDispatcher.enqueueLocked(peer, message)) {
			workPlan.drain(peer);
		}
		return true;
	}

	private void closeForOutboundOverflowLocked(
			Peer peer,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		if (disconnectAndCloseLocked(peer, OUTBOUND_QUEUE_OVERFLOW, workPlan, pendingOutbound)) {
			metrics.recordQueueOverflow();
		}
	}

	private void execute(WorkPlan workPlan) {
		for (Peer peer : workPlan.drains) {
			outboundDispatcher.dispatch(() -> outboundDispatcher.drain(peer));
		}
		for (CloseAction closeAction : workPlan.closes) {
			outboundDispatcher.dispatch(() -> executeClose(closeAction));
		}
	}

	private void executeClose(CloseAction closeAction) {
		CloseStatus closeStatus;
		synchronized (monitor) {
			SessionCloseDecision closeDecision = closeAction.closeDecision();
			closeStatus = closeDecision != null && closeDecision.terminalStatus != null
					? closeDecision.terminalStatus
					: closeAction.requestedStatus();
		}
		try {
			closeQuietly(closeAction.session(), closeStatus);
		}
		finally {
			completeCloseAttempt(closeAction);
		}
	}

	private void completeCloseAttempt(CloseAction closeAction) {
		synchronized (monitor) {
			if (closeAction.closeDecision() != null) {
				closeAction.closeDecision().closeInProgress = false;
			}
			Peer pendingPeer = pendingTerminalCleanup.remove(
					closeAction.session().getId());
			if (pendingPeer != null) {
				pendingPeer.reservation.close();
			}
			monitor.notifyAll();
		}
	}

	private void handleOutboundSendFailure(Peer peer, Exception exception) {
		log.debug(
				"시그널링 프레임 송신에 실패하여 연결을 종료합니다 ({})",
				exception.getClass().getSimpleName());
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			disconnectAndCloseLocked(peer, CloseStatus.SERVER_ERROR, workPlan);
		}
		execute(workPlan);
	}

	private static void closeQuietly(WebSocketSession session, CloseStatus status) {
		try {
			session.close(status);
		}
		catch (IOException ignored) {
			// 전송 계층이 이미 사라졌더라도 아래 정리 절차가 최종 기준이다.
		}
	}

	@Override
	public void start() {
		synchronized (monitor) {
			running = true;
		}
	}

	@Override
	public void stop() {
		long closeDeadlineNanos = System.nanoTime()
				+ TimeUnit.MILLISECONDS.toNanos(shutdownCloseTimeoutMs);
		List<WebSocketSession> sessions;
		synchronized (monitor) {
			if (!running) {
				return;
			}
			running = false;
			sessions = connectedPeers.values().stream()
					.map(peer -> peer.session)
					.toList();
			connectedPeers.values().forEach(peer -> {
				peer.connected = false;
				peer.reservation.close();
				outboundDispatcher.clearLocked(peer);
			});
			connectedPeers.clear();
			inboundLimiter.clear();
			rooms.clear();
			studyStates.clear();
			handQueues.clear();
		}
		closeSessionsConcurrently(sessions, closeDeadlineNanos);
		awaitPendingTerminalCleanup(closeDeadlineNanos);
	}

	private void awaitPendingTerminalCleanup(long deadlineNanos) {
		synchronized (monitor) {
			while (!pendingTerminalCleanup.isEmpty()) {
				long remainingNanos = deadlineNanos - System.nanoTime();
				if (remainingNanos <= 0) {
					break;
				}
				try {
					TimeUnit.NANOSECONDS.timedWait(monitor, remainingNanos);
				}
				catch (InterruptedException exception) {
					Thread.currentThread().interrupt();
					break;
				}
			}
			if (!pendingTerminalCleanup.isEmpty()) {
				log.warn(
						"Signaling shutdown still has {} terminal close attempts in progress; "
								+ "their reservations remain held until close returns",
						pendingTerminalCleanup.size());
			}
		}
	}

	@Override
	public boolean isRunning() {
		return running;
	}

	private static ConnectionAdmissionPolicy.Reservation takeReservation(
			WebSocketSession session) {
		Object candidate = session.getAttributes().remove(
				ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		return candidate instanceof ConnectionAdmissionPolicy.Reservation reservation
				? reservation
				: null;
	}

	private static final class Peer implements SignalingOutboundDispatcher.Target {

		private final String peerId;
		private final WebSocketSession session;
		private final long connectionSequence;
		private boolean announced;
		private boolean connected = true;
		private HeartbeatState heartbeatState = HeartbeatState.READY;
		private long heartbeatPhaseStartedAtNanos = UNSET_NANOS;
		private byte[] expectedPongPayload;
		private String roomId;
		private String displayName;
		private ParticipationGrant.Role role;
		private long unjoinedSinceNanos;
		private final ConnectionAdmissionPolicy.Reservation reservation;
		private final RoomAccess roomAccess;
		private final RoomAccess.Lease accessLease;
		private final SessionCloseDecision closeDecision;
		private final SignalingInboundLimiter.Connection inboundLimit;

		private Peer(
				String peerId,
				WebSocketSession session,
				long connectedAtNanos,
				long connectionSequence,
				ConnectionAdmissionPolicy.Reservation reservation,
				RoomAccess roomAccess,
				RoomAccess.Lease accessLease,
				SessionCloseDecision closeDecision,
				SignalingInboundLimiter.Connection inboundLimit) {
			this.peerId = peerId;
			this.session = session;
			this.connectionSequence = connectionSequence;
			this.unjoinedSinceNanos = connectedAtNanos;
			this.reservation = reservation;
			this.roomAccess = roomAccess;
			this.accessLease = accessLease;
			this.closeDecision = closeDecision;
			this.inboundLimit = inboundLimit;
		}

		@Override
		public WebSocketSession session() {
			return session;
		}

		@Override
		public boolean connected() {
			return connected;
		}

		@Override
		public long connectionSequence() {
			return connectionSequence;
		}

		@Override
		public void markPingSending(long nowNanos) {
			if (heartbeatState == HeartbeatState.PING_QUEUED) {
				heartbeatState = HeartbeatState.AWAITING_PONG;
				heartbeatPhaseStartedAtNanos = nowNanos;
			}
		}
	}

	private enum HeartbeatState {
		READY,
		PING_QUEUED,
		AWAITING_PONG
	}

	private static boolean elapsedAtLeast(
			long nowNanos,
			long startedAtNanos,
			long durationNanos) {
		return startedAtNanos != UNSET_NANOS
				&& nowNanos - startedAtNanos >= durationNanos;
	}

	private void closeSessionsConcurrently(
			List<WebSocketSession> sessions,
			long deadlineNanos) {
		if (sessions.isEmpty()) {
			return;
		}

		List<Callable<Object>> closeTasks = sessions.stream()
				.map(session -> Executors.callable(() -> closeQuietly(session, SERVER_SHUTDOWN)))
				.toList();
		ExecutorService closeExecutor = Executors.newVirtualThreadPerTaskExecutor();
		try {
			long remainingNanos = Math.max(0, deadlineNanos - System.nanoTime());
			// 기한이 지나면 invokeAll이 끝나지 않은 작업을 취소한다.
			long unfinished = closeExecutor.invokeAll(closeTasks, remainingNanos, TimeUnit.NANOSECONDS)
					.stream()
					.filter(Future::isCancelled)
					.count();
			if (unfinished > 0) {
				log.warn(
						"Signaling shutdown close deadline elapsed with {} sessions remaining",
						unfinished);
			}
		}
		catch (InterruptedException exception) {
			Thread.currentThread().interrupt();
			log.warn(
					"Signaling shutdown was interrupted while closing {} sessions",
					sessions.size());
		}
		finally {
			closeExecutor.shutdownNow();
		}
	}

	private static final class WorkPlan {

		private final List<Peer> drains = new ArrayList<>();
		private final List<CloseAction> closes = new ArrayList<>();

		private void drain(Peer peer) {
			drains.add(peer);
		}

		private void close(WebSocketSession session, CloseStatus status) {
			close(session, status, null);
		}

		private void close(
				WebSocketSession session,
				CloseStatus status,
				SessionCloseDecision closeDecision) {
			closes.add(new CloseAction(session, status, closeDecision));
		}
	}

	private static final class SessionCloseDecision {

		private CloseStatus terminalStatus;
		private boolean closeInProgress;
	}

	private static final class PendingOutbound {

		private final Peer peer;
		private final WebSocketMessage<?> message;
		private boolean accepted;

		private PendingOutbound(Peer peer, WebSocketMessage<?> message) {
			this.peer = peer;
			this.message = message;
		}
	}

	private record CloseAction(
			WebSocketSession session,
			CloseStatus requestedStatus,
			SessionCloseDecision closeDecision) {
	}

}

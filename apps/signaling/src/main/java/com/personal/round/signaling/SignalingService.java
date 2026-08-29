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
import java.io.IOException;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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
public class SignalingService implements SmartLifecycle {

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
	private static final CloseStatus CONNECTION_LIMIT =
			CloseStatus.SERVICE_OVERLOAD.withReason("Server connection limit reached");
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
	static final int MAX_OUTBOUND_QUEUE_SIZE = 256;

	private final Object monitor = new Object();
	private final Object lifecycleMonitor = new Object();
	private final Map<String, Peer> connectedPeers = new HashMap<>();
	private final LinkedHashMap<String, ClientInboundState> inboundClients =
			new LinkedHashMap<>(16, 0.75f, true);
	private final Map<String, LinkedHashMap<String, Peer>> rooms = new HashMap<>();
	// 대체된 피어는 방 상태에서 즉시 제거하지만 close가 반환될 때까지 입장 예약은 유지한다.
	private final Map<String, Peer> pendingTerminalCleanup = new HashMap<>();
	private final ExecutorService outboundExecutor;
	private final ServerMessageEncoder serverMessageEncoder;
	private final SignalingMetrics metrics;
	private final RoomAccessPolicy roomAccessPolicy;
	private final Clock clock;
	private final LongSupplier monotonicTicker;
	private final int maxRoomSize;
	private final int maxConnections;
	private final long heartbeatIntervalNanos;
	private final long unjoinedTimeoutNanos;
	private final long abuseWindowNanos;
	private final int maxFramesPerSessionWindow;
	private final int maxFramesPerClientWindow;
	private final int maxFramesGlobalWindow;
	private final long maxBytesPerSessionWindow;
	private final long maxBytesPerClientWindow;
	private final long maxBytesGlobalWindow;
	private final long maxOutboundQueueBytes;
	private final long maxOutboundQueueBytesGlobal;
	private final long shutdownCloseTimeoutMs;
	private final UsageWindow globalInboundWindow = new UsageWindow();
	private long globalOutboundBytes;
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
		this.outboundExecutor = outboundExecutor;
		this.clock = clock;
		this.monotonicTicker = monotonicTicker;
		this.maxRoomSize = properties.maxRoomSize();
		this.maxConnections = properties.maxConnections();
		this.heartbeatIntervalNanos = properties.heartbeatInterval().toNanos();
		this.unjoinedTimeoutNanos = properties.unjoinedTimeout().toNanos();
		this.abuseWindowNanos = properties.abuseWindow().toNanos();
		this.maxFramesPerSessionWindow = properties.maxFramesPerSessionWindow();
		this.maxFramesPerClientWindow = properties.maxFramesPerClientWindow();
		this.maxFramesGlobalWindow = properties.maxFramesGlobalWindow();
		this.maxBytesPerSessionWindow = properties.maxBytesPerSessionWindow();
		this.maxBytesPerClientWindow = properties.maxBytesPerClientWindow();
		this.maxBytesGlobalWindow = properties.maxBytesGlobalWindow();
		this.maxOutboundQueueBytes = properties.maxOutboundQueueBytes();
		this.maxOutboundQueueBytesGlobal = properties.maxOutboundQueueBytesGlobal();
		this.shutdownCloseTimeoutMs = properties.shutdownCloseTimeout().toMillis();
		metrics.updateState(0, 0, 0);
		metrics.updateOutboundQueuedBytes(0);
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
				removeExpiredInactiveClientStatesLocked(nowNanos);
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
					String clientKey = reservation.clientKey();
					ClientInboundState clientInboundState =
							retainClientInboundStateLocked(clientKey);
					if (clientInboundState == null) {
						metrics.recordConnectionRejectedServerCapacity();
						workPlan.close(session, CONNECTION_LIMIT);
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
										clientKey,
										clientInboundState));
						reservationTransferred = true;
						refreshMetricsLocked();
						accepted = true;
					}
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

	public boolean isAcceptingConnections() {
		return running;
	}

	public boolean acceptInboundFrame(WebSocketSession session, int payloadBytes) {
		WorkPlan workPlan = new WorkPlan();
		boolean accepted = false;
		synchronized (monitor) {
			long nowMillis = clock.millis();
			long nowNanos = monotonicTicker.getAsLong();
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null) {
				if (closeForExpiredAuthorizationLocked(
						peer,
						nowMillis,
						nowNanos,
						workPlan)) {
					peer = null;
				}
			}
			if (peer != null) {
				touchClientInboundStateLocked(peer);
				WindowDecision sessionDecision = peer.inboundWindow.tryAcquire(
						nowNanos,
						abuseWindowNanos,
						maxFramesPerSessionWindow,
						maxBytesPerSessionWindow,
						payloadBytes);
				if (sessionDecision != WindowDecision.ACCEPTED) {
					if (sessionDecision == WindowDecision.BYTE_LIMITED) {
						metrics.recordSessionByteLimitedFrame();
					}
					else {
						metrics.recordRateLimitedFrame();
					}
					disconnectAndCloseLocked(peer, RATE_LIMITED, workPlan);
				}
				else {
					WindowDecision clientDecision =
							peer.clientInboundState.inboundWindow.tryAcquire(
									nowNanos,
									abuseWindowNanos,
									maxFramesPerClientWindow,
									maxBytesPerClientWindow,
									payloadBytes);
					if (clientDecision != WindowDecision.ACCEPTED) {
						if (clientDecision == WindowDecision.BYTE_LIMITED) {
							metrics.recordClientByteLimitedFrame();
						}
						else {
							metrics.recordClientRateLimitedFrame();
						}
					}
					else {
						WindowDecision globalDecision = globalInboundWindow.tryAcquire(
								nowNanos,
								abuseWindowNanos,
								maxFramesGlobalWindow,
								maxBytesGlobalWindow,
								payloadBytes);
						if (globalDecision == WindowDecision.ACCEPTED) {
							accepted = true;
						}
						else if (globalDecision == WindowDecision.BYTE_LIMITED) {
							metrics.recordGlobalByteLimitedFrame();
						}
						else {
							metrics.recordOverloadedFrame();
						}
					}
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
					case ClientMessage.Moderation moderation -> moderate(peer, moderation, workPlan);
				}
			}
		}
		execute(workPlan);
	}

	public void sendInvalidMessage(WebSocketSession session, String detail) {
		metrics.recordInvalidFrame();
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null) {
				sendError(
						peer,
						SignalingErrorCode.INVALID_MESSAGE,
						detail,
						peer.roomId,
						null,
						workPlan);
			}
		}
		execute(workPlan);
	}

	public void recordInvalidFrame() {
		metrics.recordInvalidFrame();
	}

	public void sendInternalError(WebSocketSession session) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null) {
				sendError(
						peer,
						SignalingErrorCode.INTERNAL_ERROR,
						"The signaling server could not process this message.",
						peer.roomId,
						null,
						workPlan);
			}
		}
		execute(workPlan);
	}

	public void markAlive(WebSocketSession session, byte[] pongPayload) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null
					&& !closeForExpiredAuthorizationLocked(peer, workPlan)
					&& peer.expectedPongPayload != null
					&& (peer.heartbeatState == HeartbeatState.PING_QUEUED
							|| peer.heartbeatState == HeartbeatState.AWAITING_PONG)
					&& MessageDigest.isEqual(peer.expectedPongPayload, pongPayload)) {
				peer.heartbeatState = HeartbeatState.READY;
				peer.pingQueuedAtNanos = UNSET_NANOS;
				peer.pingSentAtNanos = UNSET_NANOS;
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
				if (closeForExpiredAuthorizationLocked(
						peer,
						nowMillis,
						nowNanos,
						workPlan)) {
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
							peer.pingQueuedAtNanos = nowNanos;
							peer.pingSentAtNanos = UNSET_NANOS;
							peer.expectedPongPayload = challenge;
						}
					}
					case PING_QUEUED -> {
						if (elapsedAtLeast(
								nowNanos,
								peer.pingQueuedAtNanos,
								heartbeatIntervalNanos)) {
							closeForHeartbeatTimeoutLocked(peer, workPlan);
						}
					}
					case AWAITING_PONG -> {
						if (elapsedAtLeast(
								nowNanos,
								peer.pingSentAtNanos,
								heartbeatIntervalNanos)) {
							closeForHeartbeatTimeoutLocked(peer, workPlan);
						}
					}
				}
			}
		}
		execute(workPlan);
	}

	private void closeForHeartbeatTimeoutLocked(Peer peer, WorkPlan workPlan) {
		metrics.recordHeartbeatClose();
		disconnectAndCloseLocked(peer, HEARTBEAT_TIMEOUT, workPlan);
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
				if (closeForExpiredAuthorizationLocked(
						peer,
						nowMillis,
						nowNanos,
						workPlan)) {
					continue;
				}
				if (peer.unjoinedSinceNanos == UNSET_NANOS) {
					continue;
				}
				if (elapsedAtLeast(
						nowNanos,
						peer.unjoinedSinceNanos,
						unjoinedTimeoutNanos)) {
					disconnectAndCloseLocked(peer, JOIN_TIMEOUT, workPlan);
				}
			}
			removeExpiredInactiveClientStatesLocked(nowNanos);
		}
		execute(workPlan);
	}

	public void disconnect(WebSocketSession session) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			disconnectLocked(session.getId(), workPlan);
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

	public int participantCount(String roomId) {
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

	int trackedInboundClientCount() {
		synchronized (monitor) {
			return inboundClients.size();
		}
	}

	private void join(Peer peer, ClientMessage.Join message, WorkPlan workPlan) {
		if (peer.roomId != null) {
			metrics.recordJoinRejectedAlreadyJoined();
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
			metrics.recordJoinRejectedUnauthorizedRoom();
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
			metrics.recordJoinRejectedInvalidHostCapability();
			sendError(
					peer,
					SignalingErrorCode.FORBIDDEN,
					"The supplied host capability is not valid for this connection.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}

		LinkedHashMap<String, Peer> room = rooms.computeIfAbsent(
				message.roomId(), ignored -> new LinkedHashMap<>());
		Peer existingParticipationSession = findSameBatonParticipant(peer, room);
		if (existingParticipationSession != null) {
			if (peer.connectionSequence < existingParticipationSession.connectionSequence) {
				closeSupersededParticipationSessionLocked(peer, workPlan);
				return;
			}
			closeSupersededParticipationSessionLocked(
					existingParticipationSession,
					workPlan);
			rooms.putIfAbsent(message.roomId(), room);
		}
		if (!peer.connected) {
			if (room.isEmpty()) {
				rooms.remove(message.roomId(), room);
			}
			return;
		}
		if (room.size() >= maxRoomSize) {
			metrics.recordJoinRejectedRoomFull();
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
		refreshMetricsLocked();

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
		if (!(joiningPeer.roomAccess instanceof ParticipationGrant joiningGrant)) {
			return null;
		}
		return room.values().stream()
				.filter(existing ->
						existing.roomAccess instanceof ParticipationGrant existingGrant
								&& existingGrant.subject().equals(joiningGrant.subject()))
				.findFirst()
				.orElse(null);
	}

	private void closeSupersededParticipationSessionLocked(
			Peer peer,
			WorkPlan workPlan) {
		disconnectAndCloseLocked(
				peer,
				PARTICIPATION_SESSION_SUPERSEDED,
				workPlan);
	}

	private void leave(Peer peer, ClientMessage.Leave message, WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(
					peer,
					SignalingErrorCode.NOT_IN_ROOM,
					"Join a room before leaving it.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(
					peer,
					SignalingErrorCode.ROOM_MISMATCH,
					"The message room does not match the joined room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		removePeerFromRoom(peer, workPlan, null);
	}

	private void relay(Peer peer, ClientMessage.Relay message, WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(
					peer,
					SignalingErrorCode.NOT_IN_ROOM,
					"Join a room before sending negotiation messages.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(
					peer,
					SignalingErrorCode.ROOM_MISMATCH,
					"The message room does not match the joined room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		if (peer.peerId.equals(message.to())) {
			sendError(
					peer,
					SignalingErrorCode.TARGET_SELF,
					"A peer cannot relay a negotiation message to itself.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}

		Map<String, Peer> room = rooms.get(peer.roomId);
		Peer target = room == null ? null : room.get(message.to());
		if (target == null) {
			sendError(
					peer,
					SignalingErrorCode.TARGET_NOT_FOUND,
					"The target peer is not in this room.",
					peer.roomId,
					message.requestId(),
					workPlan);
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

	private void moderate(
			Peer peer,
			ClientMessage.Moderation message,
			WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(
					peer,
					SignalingErrorCode.NOT_IN_ROOM,
					"Join a room before moderating participant media.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(
					peer,
					SignalingErrorCode.ROOM_MISMATCH,
					"The message room does not match the joined room.",
					peer.roomId,
					message.requestId(),
					workPlan);
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
		if (peer.peerId.equals(message.to())) {
			sendError(
					peer,
					SignalingErrorCode.TARGET_SELF,
					"A host cannot moderate its own media through a remote command.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}

		Map<String, Peer> room = rooms.get(peer.roomId);
		Peer target = room == null ? null : room.get(message.to());
		if (target == null) {
			sendError(
					peer,
					SignalingErrorCode.TARGET_NOT_FOUND,
					"The target peer is not in this room.",
					peer.roomId,
					message.requestId(),
					workPlan);
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
			WorkPlan workPlan) {
		return closeForExpiredAuthorizationLocked(
				peer,
				currentEpochMillis,
				currentMonotonicNanos,
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

	private boolean disconnectLocked(String sessionId, WorkPlan workPlan) {
		return disconnectLocked(sessionId, workPlan, true, null);
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
				peer.releaseReservation();
			}
			else {
				pendingTerminalCleanup.put(sessionId, peer);
			}
			releaseClientInboundStateLocked(peer);
			clearOutboundLocked(peer);
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

	private void releaseClientInboundStateLocked(Peer peer) {
		ClientInboundState state = peer.clientInboundState;
		state.activeConnections--;
	}

	private ClientInboundState retainClientInboundStateLocked(String clientKey) {
		ClientInboundState state = inboundClients.get(clientKey);
		if (state == null) {
			evictInactiveClientStatesForCapacityLocked();
			if (inboundClients.size() >= maxConnections) {
				return null;
			}
			state = new ClientInboundState();
			inboundClients.put(clientKey, state);
		}
		state.activeConnections++;
		return state;
	}

	private void touchClientInboundStateLocked(Peer peer) {
		// inboundClients는 접근 순서를 사용해 활성 트래픽 항목을 비활성 LRU 항목 뒤로 보낸다.
		inboundClients.get(peer.clientKey);
	}

	private void evictInactiveClientStatesForCapacityLocked() {
		var iterator = inboundClients.entrySet().iterator();
		while (inboundClients.size() >= maxConnections && iterator.hasNext()) {
			if (iterator.next().getValue().activeConnections == 0) {
				iterator.remove();
			}
		}
	}

	private void removeExpiredInactiveClientStatesLocked(long nowNanos) {
		inboundClients.entrySet().removeIf(entry -> {
			ClientInboundState state = entry.getValue();
			return state.activeConnections == 0
					&& state.inboundWindow.isExpired(nowNanos, abuseWindowNanos);
		});
	}

	private void removePeerFromRoom(
			Peer peer,
			WorkPlan workPlan,
			ArrayDeque<PendingOutbound> pendingOutbound) {
		if (peer.roomId == null) {
			refreshMetricsLocked();
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
			refreshMetricsLocked();
			return;
		}
		if (room.isEmpty()) {
			rooms.remove(roomId, room);
			refreshMetricsLocked();
			return;
		}
		refreshMetricsLocked();
		if (!wasAnnounced) {
			return;
		}

		TextMessage left = serverMessageEncoder.peerLeft(roomId, peer.peerId);
		if (pendingOutbound == null) {
			broadcast(room, left, null, workPlan);
		}
		else {
			appendBroadcast(room, left, null, pendingOutbound);
		}
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
		// 압력으로 발생한 퇴장 프레임은 원인 배치 뒤에 추가한다. 이 루프를 너비 우선으로
		// 처리하면 재귀적 퇴거를 방지하고 인과적 이벤트 순서를 보존할 수 있다.
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
		boolean peerOverflow = peer.outbound.size() + (peer.inFlightBytes == 0 ? 0 : 1)
				>= MAX_OUTBOUND_QUEUE_SIZE
				|| messageBytes > maxOutboundQueueBytes - peer.outboundBytes;
		if (peerOverflow) {
			if (disconnectAndCloseLocked(
						peer,
						OUTBOUND_QUEUE_OVERFLOW,
						workPlan,
						pendingOutbound)) {
				metrics.recordQueueOverflow();
			}
			return false;
		}
		if (messageBytes > maxOutboundQueueBytesGlobal - globalOutboundBytes) {
			metrics.recordGlobalQueueOverflow();
			for (Peer victim : globalPressureVictimsLocked(messageBytes)) {
				if (disconnectAndCloseLocked(
							victim,
							OUTBOUND_QUEUE_OVERFLOW,
							workPlan,
							pendingOutbound)) {
					metrics.recordQueueOverflow();
				}
				if (!peer.connected) {
					return false;
				}
			}
			if (messageBytes > maxOutboundQueueBytesGlobal - globalOutboundBytes) {
				if (disconnectAndCloseLocked(
							peer,
							OUTBOUND_QUEUE_OVERFLOW,
							workPlan,
							pendingOutbound)) {
					metrics.recordQueueOverflow();
				}
				return false;
			}
		}

		peer.outbound.addLast(new OutboundFrame(message, messageBytes));
		peer.outboundBytes += messageBytes;
		globalOutboundBytes += messageBytes;
		metrics.updateOutboundQueuedBytes(globalOutboundBytes);
		if (!peer.draining) {
			peer.draining = true;
			workPlan.drain(peer);
		}
		return true;
	}

	private void execute(WorkPlan workPlan) {
		for (Peer peer : workPlan.drains) {
			submit(() -> drain(peer));
		}
		for (CloseAction closeAction : workPlan.closes) {
			submit(() -> executeClose(closeAction));
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
				pendingPeer.releaseReservation();
			}
			monitor.notifyAll();
		}
	}

	private void submit(Runnable task) {
		try {
			outboundExecutor.execute(task);
		}
		catch (RejectedExecutionException exception) {
			log.debug("Outbound executor rejected work; executing signaling task inline");
			task.run();
		}
	}

	private void drain(Peer peer) {
		while (true) {
			OutboundFrame frame;
			synchronized (monitor) {
				if (!peer.connected) {
					clearOutboundLocked(peer);
					peer.draining = false;
					return;
				}
				frame = peer.outbound.pollFirst();
				if (frame == null) {
					peer.draining = false;
					return;
				}
				peer.inFlightBytes = frame.payloadBytes();
				if (frame.message() instanceof PingMessage
						&& peer.heartbeatState == HeartbeatState.PING_QUEUED) {
					peer.heartbeatState = HeartbeatState.AWAITING_PONG;
					peer.pingSentAtNanos = monotonicTicker.getAsLong();
				}
			}

			try {
				peer.session.sendMessage(frame.message());
			}
			catch (Exception exception) {
				log.debug(
						"Failed to send signaling frame; closing transport ({})",
						exception.getClass().getSimpleName());
				WorkPlan workPlan = new WorkPlan();
				synchronized (monitor) {
					disconnectAndCloseLocked(peer, CloseStatus.SERVER_ERROR, workPlan);
				}
				execute(workPlan);
				return;
			}
			finally {
				synchronized (monitor) {
					releaseInFlightLocked(peer, frame);
				}
			}
		}
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
		synchronized (lifecycleMonitor) {
			synchronized (monitor) {
				if (running || outboundExecutor.isShutdown()) {
					return;
				}
				running = true;
			}
		}
	}

	@Override
	public void stop() {
		synchronized (lifecycleMonitor) {
			long closeDeadlineNanos = System.nanoTime()
					+ TimeUnit.MILLISECONDS.toNanos(shutdownCloseTimeoutMs);
			List<WebSocketSession> sessions;
			synchronized (monitor) {
				if (!running
						&& connectedPeers.isEmpty()
						&& pendingTerminalCleanup.isEmpty()
						&& inboundClients.isEmpty()
						&& rooms.isEmpty()) {
					return;
				}
				running = false;
				sessions = connectedPeers.values().stream()
						.map(peer -> peer.session)
						.toList();
				connectedPeers.values().forEach(peer -> {
					peer.connected = false;
					peer.releaseReservation();
					clearOutboundLocked(peer);
				});
				connectedPeers.clear();
				inboundClients.clear();
				rooms.clear();
				globalInboundWindow.reset();
				refreshMetricsLocked();
			}
			closeSessionsConcurrently(sessions, closeDeadlineNanos);
			awaitPendingTerminalCleanup(closeDeadlineNanos);
		}
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
	public void stop(Runnable callback) {
		try {
			stop();
		}
		finally {
			callback.run();
		}
	}

	@Override
	public boolean isRunning() {
		return running;
	}

	private void refreshMetricsLocked() {
		int joined = rooms.values().stream().mapToInt(Map::size).sum();
		metrics.updateState(rooms.size(), connectedPeers.size(), joined);
	}

	private static ConnectionAdmissionPolicy.Reservation takeReservation(
			WebSocketSession session) {
		Object candidate = session.getAttributes().remove(
				ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		return candidate instanceof ConnectionAdmissionPolicy.Reservation reservation
				? reservation
				: null;
	}

	private static final class Peer {

		private final String peerId;
		private final WebSocketSession session;
		private final long connectionSequence;
		private final ArrayDeque<OutboundFrame> outbound = new ArrayDeque<>();
		private long outboundBytes;
		private long inFlightBytes;
		private boolean announced;
		private boolean connected = true;
		private boolean draining;
		private HeartbeatState heartbeatState = HeartbeatState.READY;
		private long pingQueuedAtNanos = UNSET_NANOS;
		private long pingSentAtNanos = UNSET_NANOS;
		private byte[] expectedPongPayload;
		private String roomId;
		private String displayName;
		private ParticipationGrant.Role role;
		private long unjoinedSinceNanos;
		private final UsageWindow inboundWindow = new UsageWindow();
		private final ConnectionAdmissionPolicy.Reservation reservation;
		private final RoomAccess roomAccess;
		private final RoomAccess.Lease accessLease;
		private final SessionCloseDecision closeDecision;
		private final String clientKey;
		private final ClientInboundState clientInboundState;

		private Peer(
				String peerId,
				WebSocketSession session,
				long connectedAtNanos,
				long connectionSequence,
				ConnectionAdmissionPolicy.Reservation reservation,
				RoomAccess roomAccess,
				RoomAccess.Lease accessLease,
				SessionCloseDecision closeDecision,
				String clientKey,
				ClientInboundState clientInboundState) {
			this.peerId = peerId;
			this.session = session;
			this.connectionSequence = connectionSequence;
			this.unjoinedSinceNanos = connectedAtNanos;
			this.reservation = reservation;
			this.roomAccess = roomAccess;
			this.accessLease = accessLease;
			this.closeDecision = closeDecision;
			this.clientKey = clientKey;
			this.clientInboundState = clientInboundState;
		}

		private void releaseReservation() {
			reservation.close();
		}
	}

	private static final class ClientInboundState {

		private final UsageWindow inboundWindow = new UsageWindow();
		private int activeConnections;
	}

	private enum HeartbeatState {
		READY,
		PING_QUEUED,
		AWAITING_PONG
	}

	private enum WindowDecision {
		ACCEPTED,
		FRAME_LIMITED,
		BYTE_LIMITED
	}

	private static final class UsageWindow {

		private long startedAtNanos = UNSET_NANOS;
		private int frameCount;
		private long payloadBytes;

		private WindowDecision tryAcquire(
				long nowNanos,
				long windowNanos,
				int maximumFrames,
				long maximumBytes,
				int nextPayloadBytes) {
			if (startedAtNanos == UNSET_NANOS
					|| elapsedAtLeast(nowNanos, startedAtNanos, windowNanos)) {
				startedAtNanos = nowNanos;
				frameCount = 0;
				payloadBytes = 0;
			}
			if (frameCount < Integer.MAX_VALUE) {
				frameCount++;
			}
			payloadBytes = saturatedAdd(payloadBytes, nextPayloadBytes);
			if (frameCount > maximumFrames) {
				return WindowDecision.FRAME_LIMITED;
			}
			if (payloadBytes > maximumBytes) {
				return WindowDecision.BYTE_LIMITED;
			}
			return WindowDecision.ACCEPTED;
		}

		private boolean isExpired(long nowNanos, long windowNanos) {
			return startedAtNanos == UNSET_NANOS
					|| elapsedAtLeast(nowNanos, startedAtNanos, windowNanos);
		}

		private void reset() {
			startedAtNanos = UNSET_NANOS;
			frameCount = 0;
			payloadBytes = 0;
		}
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

		AtomicInteger remainingSessions = new AtomicInteger(sessions.size());
		List<Callable<Void>> closeTasks = sessions.stream()
				.<Callable<Void>>map(session -> () -> {
					try {
						closeQuietly(session, SERVER_SHUTDOWN);
						return null;
					}
					finally {
						remainingSessions.decrementAndGet();
					}
				})
				.toList();
		ExecutorService closeExecutor = Executors.newVirtualThreadPerTaskExecutor();
		try {
			long remainingNanos = Math.max(0, deadlineNanos - System.nanoTime());
			closeExecutor.invokeAll(
					closeTasks,
					remainingNanos,
					TimeUnit.NANOSECONDS);
			if (remainingSessions.get() > 0) {
				log.warn(
						"Signaling shutdown close deadline elapsed with {} sessions remaining",
						remainingSessions.get());
			}
		}
		catch (InterruptedException exception) {
			Thread.currentThread().interrupt();
			log.warn(
					"Signaling shutdown was interrupted with {} sessions remaining",
					remainingSessions.get());
		}
		finally {
			closeExecutor.shutdownNow();
		}
	}

	private static long saturatedAdd(long current, int increment) {
		if (Long.MAX_VALUE - current < increment) {
			return Long.MAX_VALUE;
		}
		return current + increment;
	}

	private void clearOutboundLocked(Peer peer) {
		long queuedBytes = peer.outboundBytes - peer.inFlightBytes;
		globalOutboundBytes -= queuedBytes;
		peer.outbound.clear();
		peer.outboundBytes = peer.inFlightBytes;
		metrics.updateOutboundQueuedBytes(globalOutboundBytes);
	}

	private void releaseInFlightLocked(Peer peer, OutboundFrame frame) {
		peer.inFlightBytes = 0;
		peer.outboundBytes -= frame.payloadBytes();
		globalOutboundBytes -= frame.payloadBytes();
		metrics.updateOutboundQueuedBytes(globalOutboundBytes);
	}

	private List<Peer> globalPressureVictimsLocked(int messageBytes) {
		long bytesToRelease = messageBytes
				- (maxOutboundQueueBytesGlobal - globalOutboundBytes);
		// connectionSequence를 사용해 나머지 조건이 같은 큐 압력 결정을 재현 가능하게 만든다.
		List<Peer> candidates = connectedPeers.values().stream()
				.filter(candidate -> releasableOutboundBytes(candidate) > 0)
				.sorted(Comparator
						.<Peer>comparingLong(this::releasableOutboundBytes)
						.reversed()
						.thenComparing(
								Comparator.comparingLong((Peer peer) -> peer.outboundBytes)
										.reversed())
						.thenComparingLong(peer -> peer.connectionSequence))
				.toList();
		List<Peer> victims = new ArrayList<>();
		for (Peer candidate : candidates) {
			victims.add(candidate);
			bytesToRelease -= releasableOutboundBytes(candidate);
			if (bytesToRelease <= 0) {
				break;
			}
		}
		return victims;
	}

	private long releasableOutboundBytes(Peer peer) {
		return peer.outboundBytes - peer.inFlightBytes;
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

	private record OutboundFrame(WebSocketMessage<?> message, int payloadBytes) {
	}
}

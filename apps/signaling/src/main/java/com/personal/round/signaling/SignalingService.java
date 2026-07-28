package com.personal.round.signaling;

import com.personal.round.config.SignalingExecutionConfig;
import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ProtocolParser;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

@Service
public class SignalingService implements SmartLifecycle {

	private static final Logger log = LoggerFactory.getLogger(SignalingService.class);
	private static final CloseStatus HEARTBEAT_TIMEOUT =
			new CloseStatus(4000, "Heartbeat timeout");
	private static final CloseStatus SERVER_SHUTDOWN =
			new CloseStatus(1001, "Server shutting down");
	private static final CloseStatus OUTBOUND_QUEUE_OVERFLOW =
			new CloseStatus(1011, "Outbound queue overflow");
	private static final CloseStatus JOIN_TIMEOUT =
			new CloseStatus(1008, "Room join timeout");
	private static final CloseStatus RATE_LIMITED =
			new CloseStatus(1008, "Inbound frame rate exceeded");
	private static final CloseStatus CONNECTION_LIMIT =
			new CloseStatus(1013, "Server connection limit reached");
	private static final String UNRESERVED_CLIENT = "<unreserved>";
	static final int MAX_OUTBOUND_QUEUE_SIZE = 256;

	private final Object monitor = new Object();
	private final Object lifecycleMonitor = new Object();
	private final Map<String, Peer> connectedPeers = new HashMap<>();
	private final LinkedHashMap<String, ClientInboundState> inboundClients =
			new LinkedHashMap<>(16, 0.75f, true);
	private final Map<String, LinkedHashMap<String, Peer>> rooms = new HashMap<>();
	private final ExecutorService outboundExecutor;
	private final ObjectMapper objectMapper;
	private final SignalingMetrics metrics;
	private final Clock clock;
	private final int maxRoomSize;
	private final int maxConnections;
	private final long heartbeatIntervalMs;
	private final long unjoinedTimeoutMs;
	private final long abuseWindowMs;
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
	private volatile boolean acceptingConnections;
	private volatile boolean running;

	public SignalingService(
			ObjectMapper objectMapper,
			SignalingProperties properties,
			SignalingMetrics metrics,
			@Qualifier(SignalingExecutionConfig.OUTBOUND_EXECUTOR_BEAN)
			ExecutorService outboundExecutor,
			Clock clock) {
		this.objectMapper = objectMapper;
		this.metrics = metrics;
		this.outboundExecutor = outboundExecutor;
		this.clock = clock;
		this.maxRoomSize = properties.maxRoomSize();
		this.maxConnections = properties.maxConnections();
		this.heartbeatIntervalMs = properties.heartbeatInterval().toMillis();
		this.unjoinedTimeoutMs = properties.unjoinedTimeout().toMillis();
		this.abuseWindowMs = properties.abuseWindow().toMillis();
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
		WorkPlan workPlan = new WorkPlan();
		boolean accepted;
		boolean reservationTransferred = false;
		synchronized (monitor) {
			long nowMillis = clock.millis();
			removeExpiredInactiveClientStatesLocked(nowMillis);
			if (!acceptingConnections) {
				workPlan.close(session, SERVER_SHUTDOWN);
				accepted = false;
			}
			else if (connectedPeers.size() >= maxConnections
					&& !connectedPeers.containsKey(session.getId())) {
				workPlan.close(session, CONNECTION_LIMIT);
				accepted = false;
			}
			else {
				if (!connectedPeers.containsKey(session.getId())) {
					String clientKey = reservation == null
							? UNRESERVED_CLIENT
							: reservation.clientKey();
					ClientInboundState clientInboundState =
							retainClientInboundStateLocked(clientKey);
					if (clientInboundState == null) {
						metrics.recordConnectionRejectedServerCapacity();
						workPlan.close(session, CONNECTION_LIMIT);
						accepted = false;
					}
					else {
						connectedPeers.put(
								session.getId(),
								new Peer(
										UUID.randomUUID().toString(),
										session,
										nowMillis,
										reservation,
										clientKey,
										clientInboundState));
						reservationTransferred = true;
						refreshMetricsLocked();
						accepted = true;
					}
				}
				else {
					refreshMetricsLocked();
					accepted = true;
				}
			}
		}
		if (!reservationTransferred && reservation != null) {
			reservation.close();
		}
		execute(workPlan);
		return accepted;
	}

	public boolean isAcceptingConnections() {
		return acceptingConnections;
	}

	public boolean acceptInboundFrame(WebSocketSession session) {
		return acceptInboundFrame(session, 0);
	}

	boolean acceptInboundFrame(WebSocketSession session, long nowMillis) {
		return acceptInboundFrame(session, 0, () -> nowMillis);
	}

	public boolean acceptInboundFrame(WebSocketSession session, int payloadBytes) {
		return acceptInboundFrame(session, payloadBytes, clock::millis);
	}

	private boolean acceptInboundFrame(
			WebSocketSession session,
			int payloadBytes,
			LongSupplier nowMillisSupplier) {
		if (payloadBytes < 0) {
			throw new IllegalArgumentException("payloadBytes must not be negative");
		}
		WorkPlan workPlan = new WorkPlan();
		boolean accepted = false;
		synchronized (monitor) {
			long nowMillis = nowMillisSupplier.getAsLong();
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null && peer.connected) {
				touchClientInboundStateLocked(peer);
				WindowDecision sessionDecision = peer.inboundWindow.tryAcquire(
						nowMillis,
						abuseWindowMs,
						maxFramesPerSessionWindow,
						maxBytesPerSessionWindow,
						payloadBytes);
				WindowDecision clientDecision =
						peer.clientInboundState.inboundWindow.tryAcquire(
								nowMillis,
								abuseWindowMs,
								maxFramesPerClientWindow,
								maxBytesPerClientWindow,
								payloadBytes);
				WindowDecision globalDecision = globalInboundWindow.tryAcquire(
						nowMillis,
						abuseWindowMs,
						maxFramesGlobalWindow,
						maxBytesGlobalWindow,
						payloadBytes);
				if (sessionDecision != WindowDecision.ACCEPTED) {
					if (sessionDecision == WindowDecision.BYTE_LIMITED) {
						metrics.recordSessionByteLimitedFrame();
					}
					else {
						metrics.recordRateLimitedFrame();
					}
					disconnectLocked(session.getId(), workPlan);
					workPlan.close(session, RATE_LIMITED);
				}
				else if (clientDecision != WindowDecision.ACCEPTED) {
					if (clientDecision == WindowDecision.BYTE_LIMITED) {
						metrics.recordClientByteLimitedFrame();
					}
					else {
						metrics.recordClientRateLimitedFrame();
					}
				}
				else if (globalDecision == WindowDecision.ACCEPTED) {
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
		execute(workPlan);
		return accepted;
	}

	public void handle(WebSocketSession session, ClientMessage message) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer == null) {
				workPlan.close(session, CloseStatus.SERVER_ERROR);
			}
			else {
				switch (message) {
					case ClientMessage.Join join -> join(peer, join, workPlan);
					case ClientMessage.Leave leave -> leave(peer, leave, workPlan);
					case ClientMessage.Relay relay -> relay(peer, relay, workPlan);
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
				sendError(peer, "INVALID_MESSAGE", detail, peer.roomId, null, workPlan);
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
						"INTERNAL_ERROR",
						"The signaling server could not process this message.",
						peer.roomId,
						null,
						workPlan);
			}
		}
		execute(workPlan);
	}

	public void markAlive(WebSocketSession session, byte[] pongPayload) {
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null
					&& peer.expectedPongPayload != null
					&& (peer.heartbeatState == HeartbeatState.PING_QUEUED
							|| peer.heartbeatState == HeartbeatState.AWAITING_PONG)
					&& MessageDigest.isEqual(peer.expectedPongPayload, pongPayload)) {
				peer.heartbeatState = HeartbeatState.READY;
				peer.pingQueuedAtMillis = Long.MIN_VALUE;
				peer.pingSentAtMillis = Long.MIN_VALUE;
				peer.expectedPongPayload = null;
			}
		}
	}

	public void heartbeatSweep() {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			long nowMillis = clock.millis();
			for (Peer peer : new ArrayList<>(connectedPeers.values())) {
				if (!peer.connected) {
					continue;
				}
				switch (peer.heartbeatState) {
					case READY -> {
						byte[] challenge = heartbeatChallenge();
						if (enqueue(
								peer,
								new PingMessage(ByteBuffer.wrap(challenge)),
								workPlan)) {
							peer.heartbeatState = HeartbeatState.PING_QUEUED;
							peer.pingQueuedAtMillis = nowMillis;
							peer.pingSentAtMillis = Long.MIN_VALUE;
							peer.expectedPongPayload = challenge;
						}
					}
					case PING_QUEUED -> {
						if (nowMillis < peer.pingQueuedAtMillis) {
							peer.pingQueuedAtMillis = nowMillis;
						}
						else if (nowMillis - peer.pingQueuedAtMillis >= heartbeatIntervalMs) {
							closeForHeartbeatTimeoutLocked(peer, workPlan);
						}
					}
					case AWAITING_PONG -> {
						if (nowMillis < peer.pingSentAtMillis) {
							peer.pingSentAtMillis = nowMillis;
						}
						else if (nowMillis - peer.pingSentAtMillis >= heartbeatIntervalMs) {
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
		disconnectLocked(peer.session.getId(), workPlan);
		workPlan.close(peer.session, HEARTBEAT_TIMEOUT);
	}

	public void expireUnjoinedSessions() {
		expireUnjoinedSessions(clock::millis);
	}

	void expireUnjoinedSessions(long nowMillis) {
		expireUnjoinedSessions(() -> nowMillis);
	}

	private void expireUnjoinedSessions(LongSupplier nowMillisSupplier) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			long nowMillis = nowMillisSupplier.getAsLong();
			for (Peer peer : new ArrayList<>(connectedPeers.values())) {
				if (!peer.connected || peer.unjoinedSinceMillis < 0
						|| nowMillis < peer.unjoinedSinceMillis) {
					continue;
				}
				if (nowMillis - peer.unjoinedSinceMillis >= unjoinedTimeoutMs) {
					disconnectLocked(peer.session.getId(), workPlan);
					workPlan.close(peer.session, JOIN_TIMEOUT);
				}
			}
			removeExpiredInactiveClientStatesLocked(nowMillis);
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

	int activeInboundClientCount() {
		synchronized (monitor) {
			return (int) inboundClients.values().stream()
					.filter(state -> state.activeConnections > 0)
					.count();
		}
	}

	private void join(Peer peer, ClientMessage.Join message, WorkPlan workPlan) {
		if (peer.roomId != null) {
			metrics.recordJoinRejectedAlreadyJoined();
			sendError(
					peer,
					"ALREADY_JOINED",
					"Leave the current room before joining another room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}

		LinkedHashMap<String, Peer> room = rooms.computeIfAbsent(
				message.roomId(), ignored -> new LinkedHashMap<>());
		if (room.size() >= maxRoomSize) {
			if (room.isEmpty()) {
				rooms.remove(message.roomId(), room);
			}
			metrics.recordJoinRejectedRoomFull();
			sendError(
					peer,
					"ROOM_FULL",
					"This room is limited to " + maxRoomSize + " participants.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}

		List<Participant> participants = room.values().stream()
				.map(existing -> new Participant(existing.peerId, existing.displayName))
				.toList();
		peer.roomId = message.roomId();
		peer.displayName = message.displayName();
		peer.unjoinedSinceMillis = -1;
		room.put(peer.peerId, peer);
		refreshMetricsLocked();

		ObjectNode joined = base("room.joined", message.roomId());
		if (message.requestId() != null) {
			joined.put("requestId", message.requestId());
		}
		ObjectNode joinedPayload = joined.putObject("payload");
		joinedPayload.put("peerId", peer.peerId);
		ArrayNode participantNodes = joinedPayload.putArray("participants");
		for (Participant participant : participants) {
			participantNodes.add(participantNode(participant));
		}
		if (!enqueue(peer, new TextMessage(joined.toString()), workPlan)) {
			return;
		}
		peer.announced = true;

		ObjectNode peerJoined = base("peer.joined", message.roomId());
		peerJoined.putObject("payload")
				.set("participant", participantNode(new Participant(peer.peerId, peer.displayName)));
		broadcast(room, peerJoined, peer.peerId, workPlan);
	}

	private void leave(Peer peer, ClientMessage.Leave message, WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(
					peer,
					"NOT_IN_ROOM",
					"Join a room before leaving it.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(
					peer,
					"ROOM_MISMATCH",
					"The message room does not match the joined room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		removePeerFromRoom(peer, workPlan);
	}

	private void relay(Peer peer, ClientMessage.Relay message, WorkPlan workPlan) {
		if (peer.roomId == null) {
			sendError(
					peer,
					"NOT_IN_ROOM",
					"Join a room before sending negotiation messages.",
					message.roomId(),
					message.requestId(),
					workPlan);
			return;
		}
		if (!peer.roomId.equals(message.roomId())) {
			sendError(
					peer,
					"ROOM_MISMATCH",
					"The message room does not match the joined room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}
		if (peer.peerId.equals(message.to())) {
			sendError(
					peer,
					"TARGET_SELF",
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
					"TARGET_NOT_FOUND",
					"The target peer is not in this room.",
					peer.roomId,
					message.requestId(),
					workPlan);
			return;
		}

		ObjectNode relayed = base(message.type(), peer.roomId);
		relayed.put("from", peer.peerId);
		relayed.set("payload", message.payload().deepCopy());
		enqueue(target, new TextMessage(relayed.toString()), workPlan);
	}

	private boolean disconnectLocked(String sessionId, WorkPlan workPlan) {
		Peer peer = connectedPeers.remove(sessionId);
		if (peer != null && peer.connected) {
			peer.connected = false;
			peer.releaseReservation();
			releaseClientInboundStateLocked(peer);
			clearOutboundLocked(peer);
			removePeerFromRoom(peer, workPlan);
			refreshMetricsLocked();
			return true;
		}
		return false;
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
		// inboundClients is access-ordered so active traffic stays behind inactive LRU entries.
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

	private void removeExpiredInactiveClientStatesLocked(long nowMillis) {
		inboundClients.entrySet().removeIf(entry -> {
			ClientInboundState state = entry.getValue();
			return state.activeConnections == 0
					&& state.inboundWindow.isExpired(nowMillis, abuseWindowMs);
		});
	}

	private void removePeerFromRoom(Peer peer, WorkPlan workPlan) {
		if (peer.roomId == null) {
			return;
		}

		String roomId = peer.roomId;
		boolean wasAnnounced = peer.announced;
		peer.roomId = null;
		peer.displayName = null;
		peer.announced = false;
		if (peer.connected) {
			peer.unjoinedSinceMillis = clock.millis();
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

		ObjectNode left = base("peer.left", roomId);
		left.putObject("payload").put("peerId", peer.peerId);
		broadcast(room, left, null, workPlan);
	}

	private void broadcast(
			Map<String, Peer> room,
			ObjectNode message,
			String excludedPeerId,
			WorkPlan workPlan) {
		for (Peer target : List.copyOf(room.values())) {
			if (!target.peerId.equals(excludedPeerId)) {
				enqueue(target, new TextMessage(message.toString()), workPlan);
			}
		}
	}

	private void sendError(
			Peer peer,
			String code,
			String message,
			String roomId,
			String requestId,
			WorkPlan workPlan) {
		ObjectNode error = objectMapper.createObjectNode();
		error.put("v", ProtocolParser.PROTOCOL_VERSION);
		error.put("type", "error");
		if (roomId != null) {
			error.put("roomId", roomId);
		}
		if (requestId != null) {
			error.put("requestId", requestId);
		}
		ObjectNode payload = error.putObject("payload");
		payload.put("code", code);
		payload.put("message", message);
		enqueue(peer, new TextMessage(error.toString()), workPlan);
	}

	private ObjectNode base(String type, String roomId) {
		ObjectNode message = objectMapper.createObjectNode();
		message.put("v", ProtocolParser.PROTOCOL_VERSION);
		message.put("type", type);
		message.put("roomId", roomId);
		return message;
	}

	private ObjectNode participantNode(Participant participant) {
		ObjectNode node = objectMapper.createObjectNode();
		node.put("peerId", participant.peerId());
		node.put("displayName", participant.displayName());
		return node;
	}

	private boolean enqueue(
			Peer peer,
			WebSocketMessage<?> message,
			WorkPlan workPlan) {
		if (!peer.connected) {
			return false;
		}

		int messageBytes = payloadSizeBytes(message);
		boolean peerOverflow = peer.outboundFrameCount >= MAX_OUTBOUND_QUEUE_SIZE
				|| messageBytes > maxOutboundQueueBytes - peer.outboundBytes;
		if (peerOverflow) {
			metrics.recordQueueOverflow();
			disconnectLocked(peer.session.getId(), workPlan);
			workPlan.close(peer.session, OUTBOUND_QUEUE_OVERFLOW);
			return false;
		}
		if (messageBytes > maxOutboundQueueBytesGlobal - globalOutboundBytes) {
			metrics.recordQueueOverflow();
			metrics.recordGlobalQueueOverflow();
			Peer victim;
			while (messageBytes > maxOutboundQueueBytesGlobal - globalOutboundBytes
					&& (victim = largestReleasableOutboundPeerLocked()) != null) {
				disconnectLocked(victim.session.getId(), workPlan);
				workPlan.close(victim.session, OUTBOUND_QUEUE_OVERFLOW);
				if (!peer.connected) {
					return false;
				}
			}
			if (messageBytes > maxOutboundQueueBytesGlobal - globalOutboundBytes) {
				disconnectLocked(peer.session.getId(), workPlan);
				workPlan.close(peer.session, OUTBOUND_QUEUE_OVERFLOW);
				return false;
			}
		}

		peer.outbound.addLast(new OutboundFrame(message, messageBytes));
		peer.outboundFrameCount++;
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
			submit(() -> closeQuietly(closeAction.session(), closeAction.status()));
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
					peer.pingSentAtMillis = clock.millis();
				}
			}

			try {
				if (!peer.session.isOpen()) {
					throw new IOException("WebSocket session is closed");
				}
				peer.session.sendMessage(frame.message());
			}
			catch (Exception exception) {
				log.debug(
						"Failed to send signaling frame; closing transport ({})",
						exception.getClass().getSimpleName());
				WorkPlan workPlan = new WorkPlan();
				synchronized (monitor) {
					if (disconnectLocked(peer.session.getId(), workPlan)) {
						workPlan.close(peer.session, CloseStatus.SERVER_ERROR);
					}
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
			if (session.isOpen()) {
				session.close(status);
			}
		}
		catch (IOException ignored) {
			// The cleanup below is authoritative even if the transport has already disappeared.
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
				acceptingConnections = true;
			}
		}
	}

	@Override
	public void stop() {
		synchronized (lifecycleMonitor) {
			List<WebSocketSession> sessions;
			synchronized (monitor) {
				if (!running
						&& !acceptingConnections
						&& connectedPeers.isEmpty()
						&& inboundClients.isEmpty()
						&& rooms.isEmpty()) {
					return;
				}
				acceptingConnections = false;
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
			closeSessionsConcurrently(sessions);
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

	@Override
	public int getPhase() {
		return Integer.MAX_VALUE;
	}

	private void refreshMetricsLocked() {
		int joined = rooms.values().stream().mapToInt(Map::size).sum();
		metrics.updateState(rooms.size(), connectedPeers.size(), joined);
	}

	private static ConnectionAdmissionPolicy.Reservation takeReservation(
			WebSocketSession session) {
		Map<String, Object> attributes = session.getAttributes();
		if (attributes == null) {
			return null;
		}
		Object candidate = attributes.get(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE);
		if (!(candidate instanceof ConnectionAdmissionPolicy.Reservation reservation)) {
			return null;
		}
		attributes.remove(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		return reservation;
	}

	private static final class Peer {

		private final String peerId;
		private final WebSocketSession session;
		private final ArrayDeque<OutboundFrame> outbound = new ArrayDeque<>();
		private int outboundFrameCount;
		private long outboundBytes;
		private long inFlightBytes;
		private boolean announced;
		private boolean connected = true;
		private boolean draining;
		private HeartbeatState heartbeatState = HeartbeatState.READY;
		private long pingQueuedAtMillis = Long.MIN_VALUE;
		private long pingSentAtMillis = Long.MIN_VALUE;
		private byte[] expectedPongPayload;
		private String roomId;
		private String displayName;
		private long unjoinedSinceMillis;
		private final UsageWindow inboundWindow = new UsageWindow();
		private final ConnectionAdmissionPolicy.Reservation reservation;
		private final String clientKey;
		private final ClientInboundState clientInboundState;

		private Peer(
				String peerId,
				WebSocketSession session,
				long connectedAtMillis,
				ConnectionAdmissionPolicy.Reservation reservation,
				String clientKey,
				ClientInboundState clientInboundState) {
			this.peerId = peerId;
			this.session = session;
			this.unjoinedSinceMillis = connectedAtMillis;
			this.reservation = reservation;
			this.clientKey = clientKey;
			this.clientInboundState = clientInboundState;
		}

		private void releaseReservation() {
			if (reservation != null) {
				reservation.close();
			}
		}
	}

	private static final class ClientInboundState {

		private final UsageWindow inboundWindow = new UsageWindow();
		private int activeConnections;
	}

	private record Participant(String peerId, String displayName) {
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

		private long startedAtMillis = Long.MIN_VALUE;
		private int frameCount;
		private long payloadBytes;

		private WindowDecision tryAcquire(
				long nowMillis,
				long windowMillis,
				int maximumFrames,
				long maximumBytes,
				int nextPayloadBytes) {
			if (startedAtMillis == Long.MIN_VALUE
					|| (nowMillis >= startedAtMillis
							&& nowMillis - startedAtMillis >= windowMillis)) {
				startedAtMillis = nowMillis;
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

		private boolean isExpired(long nowMillis, long windowMillis) {
			return startedAtMillis == Long.MIN_VALUE
					|| (nowMillis >= startedAtMillis
							&& nowMillis - startedAtMillis >= windowMillis);
		}

		private void reset() {
			startedAtMillis = Long.MIN_VALUE;
			frameCount = 0;
			payloadBytes = 0;
		}
	}

	private static int payloadSizeBytes(WebSocketMessage<?> message) {
		if (message instanceof TextMessage textMessage) {
			return textMessage.getPayload().getBytes(StandardCharsets.UTF_8).length;
		}
		return message.getPayloadLength();
	}

	private static byte[] heartbeatChallenge() {
		UUID challenge = UUID.randomUUID();
		return ByteBuffer.allocate(2 * Long.BYTES)
				.putLong(challenge.getMostSignificantBits())
				.putLong(challenge.getLeastSignificantBits())
				.array();
	}

	private void closeSessionsConcurrently(List<WebSocketSession> sessions) {
		if (sessions.isEmpty()) {
			return;
		}

		long deadlineNanos =
				System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(shutdownCloseTimeoutMs);
		CountDownLatch completion = new CountDownLatch(sessions.size());
		ThreadFactory threadFactory = Thread.ofVirtual()
				.name("round-signaling-close-", 0)
				.factory();
		List<Thread> closeThreads = new ArrayList<>(sessions.size());
		for (WebSocketSession session : sessions) {
			if (System.nanoTime() >= deadlineNanos) {
				break;
			}
			Thread thread = threadFactory.newThread(() -> {
				try {
					closeQuietly(session, SERVER_SHUTDOWN);
				}
				finally {
					completion.countDown();
				}
			});
			closeThreads.add(thread);
			thread.start();
		}

		boolean completed = false;
		try {
			long remainingNanos = deadlineNanos - System.nanoTime();
			completed = remainingNanos > 0
					&& completion.await(remainingNanos, TimeUnit.NANOSECONDS);
			if (!completed) {
				log.warn(
						"Signaling shutdown close deadline elapsed with {} sessions remaining",
						completion.getCount());
			}
		}
		catch (InterruptedException exception) {
			Thread.currentThread().interrupt();
			log.warn(
					"Signaling shutdown was interrupted with {} sessions remaining",
					completion.getCount());
		}
		finally {
			if (!completed) {
				closeThreads.stream()
						.filter(Thread::isAlive)
						.forEach(Thread::interrupt);
			}
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
		peer.outboundFrameCount = peer.inFlightBytes == 0 ? 0 : 1;
		peer.outboundBytes = peer.inFlightBytes;
		metrics.updateOutboundQueuedBytes(globalOutboundBytes);
	}

	private void releaseInFlightLocked(Peer peer, OutboundFrame frame) {
		if (peer.inFlightBytes != frame.payloadBytes()) {
			log.error("Signaling outbound accounting mismatch; retaining the global byte reservation");
			return;
		}
		peer.inFlightBytes = 0;
		peer.outboundFrameCount--;
		peer.outboundBytes -= frame.payloadBytes();
		globalOutboundBytes -= frame.payloadBytes();
		metrics.updateOutboundQueuedBytes(globalOutboundBytes);
	}

	private Peer largestReleasableOutboundPeerLocked() {
		Peer victim = null;
		long largestQueuedBytes = 0;
		long largestTotalBytes = 0;
		for (Peer candidate : connectedPeers.values()) {
			long queuedBytes = candidate.outboundBytes - candidate.inFlightBytes;
			if (queuedBytes <= 0) {
				continue;
			}
			if (queuedBytes > largestQueuedBytes
					|| (queuedBytes == largestQueuedBytes
							&& candidate.outboundBytes > largestTotalBytes)) {
				victim = candidate;
				largestQueuedBytes = queuedBytes;
				largestTotalBytes = candidate.outboundBytes;
			}
		}
		return victim;
	}

	private static final class WorkPlan {

		private final List<Peer> drains = new ArrayList<>();
		private final List<CloseAction> closes = new ArrayList<>();

		private void drain(Peer peer) {
			drains.add(peer);
		}

		private void close(WebSocketSession session, CloseStatus status) {
			closes.add(new CloseAction(session, status));
		}
	}

	private record CloseAction(WebSocketSession session, CloseStatus status) {
	}

	private record OutboundFrame(WebSocketMessage<?> message, int payloadBytes) {
	}
}

package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ProtocolParser;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
	static final int MAX_OUTBOUND_QUEUE_SIZE = 256;

	private final Object monitor = new Object();
	private final Map<String, Peer> connectedPeers = new HashMap<>();
	private final Map<String, LinkedHashMap<String, Peer>> rooms = new HashMap<>();
	private final ExecutorService outboundExecutor = Executors.newVirtualThreadPerTaskExecutor();
	private final ObjectMapper objectMapper;
	private final SignalingMetrics metrics;
	private final Clock clock;
	private final int maxRoomSize;
	private final int maxConnections;
	private final long unjoinedTimeoutMs;
	private final long abuseWindowMs;
	private final int maxFramesPerSessionWindow;
	private final int maxFramesGlobalWindow;
	private final RateWindow globalInboundWindow = new RateWindow();
	private volatile boolean acceptingConnections = true;
	private volatile boolean running = true;

	public SignalingService(
			ObjectMapper objectMapper,
			SignalingProperties properties,
			SignalingMetrics metrics,
			Clock clock) {
		this.objectMapper = objectMapper;
		this.metrics = metrics;
		this.clock = clock;
		this.maxRoomSize = properties.maxRoomSize();
		this.maxConnections = properties.maxConnections();
		this.unjoinedTimeoutMs = properties.unjoinedTimeout().toMillis();
		this.abuseWindowMs = properties.abuseWindow().toMillis();
		this.maxFramesPerSessionWindow = properties.maxFramesPerSessionWindow();
		this.maxFramesGlobalWindow = properties.maxFramesGlobalWindow();
		metrics.updateState(0, 0, 0);
	}

	public boolean connect(WebSocketSession session) {
		ConnectionAdmissionPolicy.Reservation reservation = takeReservation(session);
		WorkPlan workPlan = new WorkPlan();
		boolean accepted;
		boolean reservationTransferred = false;
		synchronized (monitor) {
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
					connectedPeers.put(
							session.getId(),
							new Peer(
									UUID.randomUUID().toString(),
									session,
									clock.millis(),
									reservation));
					reservationTransferred = true;
				}
				refreshMetricsLocked();
				accepted = true;
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
		return acceptInboundFrame(session, clock.millis());
	}

	boolean acceptInboundFrame(WebSocketSession session, long nowMillis) {
		WorkPlan workPlan = new WorkPlan();
		boolean accepted = false;
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null && peer.connected) {
				boolean sessionAllowed = peer.inboundWindow.tryAcquire(
						nowMillis, abuseWindowMs, maxFramesPerSessionWindow);
				if (!sessionAllowed) {
					metrics.recordRateLimitedFrame();
					disconnectLocked(session.getId(), workPlan);
					workPlan.close(session, RATE_LIMITED);
				}
				else {
					boolean globalAllowed = globalInboundWindow.tryAcquire(
							nowMillis, abuseWindowMs, maxFramesGlobalWindow);
					if (globalAllowed) {
						accepted = true;
					}
					else {
						metrics.recordOverloadedFrame();
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

	public void markAlive(WebSocketSession session) {
		synchronized (monitor) {
			Peer peer = connectedPeers.get(session.getId());
			if (peer != null) {
				peer.heartbeatState = HeartbeatState.READY;
			}
		}
	}

	public void heartbeatSweep() {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
			for (Peer peer : new ArrayList<>(connectedPeers.values())) {
				if (!peer.connected) {
					continue;
				}
				switch (peer.heartbeatState) {
					case READY -> {
						if (enqueue(peer, new PingMessage(), workPlan)) {
							peer.heartbeatState = HeartbeatState.PING_QUEUED;
						}
					}
					case PING_QUEUED -> {
						// A slow transport has not written the ping yet. Its drainer owns progress.
					}
					case AWAITING_PONG -> {
						metrics.recordHeartbeatClose();
						disconnectLocked(peer.session.getId(), workPlan);
						workPlan.close(peer.session, HEARTBEAT_TIMEOUT);
					}
				}
			}
		}
		execute(workPlan);
	}

	public void expireUnjoinedSessions() {
		expireUnjoinedSessions(clock.millis());
	}

	void expireUnjoinedSessions(long nowMillis) {
		WorkPlan workPlan = new WorkPlan();
		synchronized (monitor) {
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
			peer.outbound.clear();
			removePeerFromRoom(peer, workPlan);
			refreshMetricsLocked();
			return true;
		}
		return false;
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

		if (peer.outbound.size() >= MAX_OUTBOUND_QUEUE_SIZE) {
			metrics.recordQueueOverflow();
			disconnectLocked(peer.session.getId(), workPlan);
			workPlan.close(peer.session, OUTBOUND_QUEUE_OVERFLOW);
			return false;
		}

		peer.outbound.addLast(message);
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
			log.debug("Outbound executor rejected work during shutdown");
			task.run();
		}
	}

	private void drain(Peer peer) {
		while (true) {
			WebSocketMessage<?> message;
			synchronized (monitor) {
				if (!peer.connected) {
					peer.outbound.clear();
					peer.draining = false;
					return;
				}
				message = peer.outbound.pollFirst();
				if (message == null) {
					peer.draining = false;
					return;
				}
			}

			try {
				if (!peer.session.isOpen()) {
					throw new IOException("WebSocket session is closed");
				}
				peer.session.sendMessage(message);
				if (message instanceof PingMessage) {
					synchronized (monitor) {
						if (peer.connected
								&& peer.heartbeatState == HeartbeatState.PING_QUEUED) {
							peer.heartbeatState = HeartbeatState.AWAITING_PONG;
						}
					}
				}
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

	@PreDestroy
	public void shutdown() {
		List<WebSocketSession> sessions;
		synchronized (monitor) {
			acceptingConnections = false;
			running = false;
			sessions = connectedPeers.values().stream().map(peer -> peer.session).toList();
			connectedPeers.values().forEach(peer -> {
				peer.connected = false;
				peer.releaseReservation();
				peer.outbound.clear();
			});
			connectedPeers.clear();
			rooms.clear();
			refreshMetricsLocked();
		}
		for (WebSocketSession session : sessions) {
			closeQuietly(session, SERVER_SHUTDOWN);
		}
		outboundExecutor.shutdownNow();
	}

	@Override
	public void start() {
		if (!outboundExecutor.isShutdown()) {
			running = true;
			acceptingConnections = true;
		}
	}

	@Override
	public void stop() {
		shutdown();
	}

	@Override
	public void stop(Runnable callback) {
		shutdown();
		callback.run();
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
		private final ArrayDeque<WebSocketMessage<?>> outbound = new ArrayDeque<>();
		private boolean announced;
		private boolean connected = true;
		private boolean draining;
		private HeartbeatState heartbeatState = HeartbeatState.READY;
		private String roomId;
		private String displayName;
		private long unjoinedSinceMillis;
		private final RateWindow inboundWindow = new RateWindow();
		private final ConnectionAdmissionPolicy.Reservation reservation;

		private Peer(
				String peerId,
				WebSocketSession session,
				long connectedAtMillis,
				ConnectionAdmissionPolicy.Reservation reservation) {
			this.peerId = peerId;
			this.session = session;
			this.unjoinedSinceMillis = connectedAtMillis;
			this.reservation = reservation;
		}

		private void releaseReservation() {
			if (reservation != null) {
				reservation.close();
			}
		}
	}

	private record Participant(String peerId, String displayName) {
	}

	private enum HeartbeatState {
		READY,
		PING_QUEUED,
		AWAITING_PONG
	}

	private static final class RateWindow {

		private long startedAtMillis = Long.MIN_VALUE;
		private int count;

		private boolean tryAcquire(long nowMillis, long windowMillis, int maximum) {
			if (startedAtMillis == Long.MIN_VALUE || nowMillis < startedAtMillis
					|| nowMillis - startedAtMillis >= windowMillis) {
				startedAtMillis = nowMillis;
				count = 0;
			}
			count++;
			return count <= maximum;
		}
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
}

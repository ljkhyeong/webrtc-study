package com.personal.round.signaling;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BiConsumer;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

final class SignalingOutboundDispatcher<P extends SignalingOutboundDispatcher.Target> {

	static final int MAX_QUEUE_SIZE = 256;

	private static final Logger log = LoggerFactory.getLogger(SignalingOutboundDispatcher.class);

	private final Object monitor;
	private final ExecutorService executor;
	private final SignalingMetrics metrics;
	private final LongSupplier monotonicTicker;
	private final long maxPeerBytes;
	private final long maxGlobalBytes;
	private final BiConsumer<P, Exception> sendFailureHandler;
	private final Map<P, QueueState> queues = new IdentityHashMap<>();

	private long globalBytes;

	SignalingOutboundDispatcher(
		Object monitor,
		ExecutorService executor,
		SignalingMetrics metrics,
		LongSupplier monotonicTicker,
		long maxPeerBytes,
		long maxGlobalBytes,
		BiConsumer<P, Exception> sendFailureHandler
	) {
		this.monitor = monitor;
		this.executor = executor;
		this.metrics = metrics;
		this.monotonicTicker = monotonicTicker;
		this.maxPeerBytes = maxPeerBytes;
		this.maxGlobalBytes = maxGlobalBytes;
		this.sendFailureHandler = sendFailureHandler;
	}

	boolean isShutdown() {
		return executor.isShutdown();
	}

	boolean peerLimitExceededLocked(P peer, int messageBytes) {
		QueueState queue = queues.get(peer);
		if (queue == null) {
			return messageBytes > maxPeerBytes;
		}
		int pendingFrameCount = queue.frames.size() + (queue.inFlightBytes == 0 ? 0 : 1);
		return pendingFrameCount >= MAX_QUEUE_SIZE || messageBytes > maxPeerBytes - queue.outboundBytes;
	}

	boolean globalLimitExceededLocked(int messageBytes) {
		return messageBytes > maxGlobalBytes - globalBytes;
	}

	List<P> globalPressureVictimsLocked(Collection<P> peers, int messageBytes) {
		long bytesToRelease = messageBytes - (maxGlobalBytes - globalBytes);
		List<P> candidates = peers.stream()
			.filter(peer -> releasableOutboundBytesLocked(peer) > 0)
			.sorted(Comparator.<P>comparingLong(this::releasableOutboundBytesLocked).reversed()
				.thenComparing(Comparator.comparingLong(this::outboundBytesLocked).reversed())
				.thenComparingLong(Target::connectionSequence))
			.toList();

		List<P> victims = new ArrayList<>();
		long releasedBytes = 0;
		for (P candidate : candidates) {
			victims.add(candidate);
			releasedBytes += releasableOutboundBytesLocked(candidate);
			if (releasedBytes >= bytesToRelease) {
				break;
			}
		}
		return victims;
	}

	boolean enqueueLocked(P peer, WebSocketMessage<?> message) {
		int messageBytes = message.getPayloadLength();
		QueueState queue = queues.computeIfAbsent(peer, ignored -> new QueueState());
		queue.frames.addLast(new OutboundFrame(message, messageBytes));
		queue.outboundBytes += messageBytes;
		globalBytes += messageBytes;
		metrics.updateOutboundQueuedBytes(globalBytes);

		if (queue.draining) {
			return false;
		}
		queue.draining = true;
		return true;
	}

	void clearLocked(P peer) {
		QueueState queue = queues.get(peer);
		if (queue == null) {
			return;
		}

		long queuedBytes = queue.outboundBytes - queue.inFlightBytes;
		queue.frames.clear();
		queue.outboundBytes = queue.inFlightBytes;
		globalBytes -= queuedBytes;
		metrics.updateOutboundQueuedBytes(globalBytes);

		if (queue.inFlightBytes == 0) {
			queues.remove(peer);
		}
	}

	void dispatch(Runnable task) {
		try {
			executor.execute(task);
		} catch (RejectedExecutionException exception) {
			log.debug("송신 실행기가 종료되어 현재 스레드에서 후속 작업을 처리합니다", exception);
			task.run();
		}
	}

	void drain(P peer) {
		while (true) {
			OutboundFrame frame;
			synchronized (monitor) {
				QueueState queue = queues.get(peer);
				if (queue == null) {
					return;
				}
				if (!peer.connected()) {
					clearLocked(peer);
					return;
				}

				frame = queue.frames.pollFirst();
				if (frame == null) {
					queue.draining = false;
					if (queue.outboundBytes == 0) {
						queues.remove(peer);
					}
					return;
				}
				queue.inFlightBytes = frame.payloadBytes();
				if (frame.message() instanceof PingMessage) {
					peer.markPingSending(monotonicTicker.getAsLong());
				}
			}

			try {
				peer.session().sendMessage(frame.message());
			} catch (Exception exception) {
				sendFailureHandler.accept(peer, exception);
				return;
			} finally {
				synchronized (monitor) {
					releaseInFlightLocked(peer, frame);
				}
			}
		}
	}

	private void releaseInFlightLocked(P peer, OutboundFrame frame) {
		QueueState queue = queues.get(peer);
		if (queue == null || queue.inFlightBytes == 0) {
			return;
		}

		queue.inFlightBytes = 0;
		queue.outboundBytes -= frame.payloadBytes();
		globalBytes -= frame.payloadBytes();
		metrics.updateOutboundQueuedBytes(globalBytes);
		if (queue.outboundBytes == 0 && (!queue.draining || !peer.connected())) {
			queues.remove(peer);
		}
	}

	private long releasableOutboundBytesLocked(P peer) {
		QueueState queue = queues.get(peer);
		return queue == null ? 0 : queue.outboundBytes - queue.inFlightBytes;
	}

	private long outboundBytesLocked(P peer) {
		QueueState queue = queues.get(peer);
		return queue == null ? 0 : queue.outboundBytes;
	}

	interface Target {

		WebSocketSession session();

		boolean connected();

		long connectionSequence();

		void markPingSending(long nowNanos);
	}

	private static final class QueueState {

		private final ArrayDeque<OutboundFrame> frames = new ArrayDeque<>();
		private long outboundBytes;
		private long inFlightBytes;
		private boolean draining;
	}

	private record OutboundFrame(WebSocketMessage<?> message, int payloadBytes) {
	}
}

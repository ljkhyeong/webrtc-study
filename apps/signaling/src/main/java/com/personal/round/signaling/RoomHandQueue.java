package com.personal.round.signaling;

import com.personal.round.protocol.HandQueueState;
import java.util.LinkedHashSet;
import java.util.List;

// 방 잠금 안에서 갱신하고, 서버가 처리한 순서대로 대기열을 유지한다.
final class RoomHandQueue {
	private final LinkedHashSet<String> queue = new LinkedHashSet<>();
	private final LinkedHashSet<String> subscribers = new LinkedHashSet<>();
	private long revision;

	boolean update(String peerId, Boolean raised) {
		boolean changed = subscribers.add(peerId);
		if (raised != null) changed |= raised ? queue.add(peerId) : queue.remove(peerId);
		if (changed) revision++;
		return changed;
	}

	boolean remove(String peerId) {
		boolean changed = subscribers.remove(peerId);
		changed |= queue.remove(peerId);
		if (changed) revision++;
		return changed;
	}

	boolean subscribes(String peerId) {
		return subscribers.contains(peerId);
	}

	HandQueueState snapshot() {
		return new HandQueueState(revision, List.copyOf(queue), List.copyOf(subscribers));
	}
}

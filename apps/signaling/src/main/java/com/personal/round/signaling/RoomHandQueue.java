package com.personal.round.signaling;

import com.personal.round.protocol.HandQueueState;
import java.util.LinkedHashSet;
import java.util.List;

// 방 잠금 안에서 갱신하고, 서버가 처리한 순서대로 대기열을 유지한다.
final class RoomHandQueue {
	private final LinkedHashSet<String> queue = new LinkedHashSet<>();
	private long revision;

	boolean update(String peerId, boolean raised) {
		boolean changed = raised ? queue.add(peerId) : queue.remove(peerId);
		if (changed) revision++;
		return changed;
	}

	HandQueueState snapshot() {
		return new HandQueueState(revision, List.copyOf(queue));
	}
}

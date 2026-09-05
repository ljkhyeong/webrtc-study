package com.personal.round.signaling;

import com.personal.round.protocol.ClientMessage.StudyCommand;
import com.personal.round.protocol.StudyState;
import java.util.concurrent.TimeUnit;

/** 방이 유지되는 동안만 사용하는 타이머. 모든 접근은 SignalingService의 방 잠금 안에서 처리한다. */
final class RoomStudyState {
	private long revision;
	private String topic = "";
	private String mode = "focus";
	private int durationSeconds = 1500;
	private long remainingMs = 1_500_000;
	private long startedAtNanos;
	private boolean running;

	StudyState snapshot(long nowNanos) {
		long remaining = remaining(nowNanos);
		return new StudyState(revision, topic, mode, durationSeconds, remaining, running && remaining > 0);
	}

	boolean apply(StudyCommand command, long nowNanos) {
		if (revision != command.expectedRevision()) return false;
		remainingMs = remaining(nowNanos);
		startedAtNanos = nowNanos;
		running = running && remainingMs > 0;
		switch (command.action()) {
			case "start" -> {
				mode = command.mode();
				durationSeconds = command.durationSeconds();
				remainingMs = durationSeconds * 1000L;
				running = true;
			}
			case "pause" -> running = false;
			case "resume" -> running = remainingMs > 0;
			case "reset" -> { remainingMs = durationSeconds * 1000L; running = false; }
			case "topic" -> topic = command.topic();
			default -> throw new IllegalArgumentException("지원하지 않는 스터디 명령입니다.");
		}
		revision++;
		return true;
	}

	private long remaining(long nowNanos) {
		return running ? Math.max(0, remainingMs - TimeUnit.NANOSECONDS.toMillis(Math.max(0, nowNanos - startedAtNanos))) : remainingMs;
	}
}

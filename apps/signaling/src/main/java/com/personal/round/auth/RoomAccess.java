package com.personal.round.auth;

import java.util.concurrent.TimeUnit;

public sealed interface RoomAccess permits ParticipationGrant, StandaloneRoomAccess {

	boolean allows(String roomId);

	Lease openLease(long currentEpochMillis, long currentMonotonicNanos);

	record Lease(
			boolean unbounded,
			long wallClockDeadlineMillis,
			long monotonicStartedAtNanos,
			long monotonicDurationNanos) {

		public static Lease until(
				long deadlineEpochMillis,
				long currentEpochMillis,
				long currentMonotonicNanos) {
			long remainingMillis = currentEpochMillis >= deadlineEpochMillis
					? 0
					: deadlineEpochMillis - currentEpochMillis;
			return new Lease(
					false,
					deadlineEpochMillis,
					currentMonotonicNanos,
					TimeUnit.MILLISECONDS.toNanos(remainingMillis));
		}

		public static Lease withoutDeadline() {
			return new Lease(true, Long.MAX_VALUE, 0, Long.MAX_VALUE);
		}

		public boolean isExpired(long currentEpochMillis, long currentMonotonicNanos) {
			return !unbounded
					&& (currentEpochMillis >= wallClockDeadlineMillis
							|| currentMonotonicNanos - monotonicStartedAtNanos
									>= monotonicDurationNanos);
		}
	}
}

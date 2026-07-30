package com.personal.round.auth;

enum StandaloneRoomAccess implements RoomAccess {

	INSTANCE;

	@Override
	public boolean allows(String roomId) {
		return true;
	}

	@Override
	public Lease openLease(long currentEpochMillis, long currentMonotonicNanos) {
		return Lease.withoutDeadline();
	}
}

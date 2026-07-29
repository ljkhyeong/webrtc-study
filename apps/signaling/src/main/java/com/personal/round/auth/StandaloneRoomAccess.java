package com.personal.round.auth;

enum StandaloneRoomAccess implements RoomAccess {

	INSTANCE;

	@Override
	public boolean allows(String roomId) {
		return true;
	}
}

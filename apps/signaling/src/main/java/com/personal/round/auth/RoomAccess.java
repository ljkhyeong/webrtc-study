package com.personal.round.auth;

public sealed interface RoomAccess permits ParticipationGrant, StandaloneRoomAccess {

	boolean allows(String roomId);
}

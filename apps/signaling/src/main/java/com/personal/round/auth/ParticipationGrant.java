package com.personal.round.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.Optional;

public record ParticipationGrant(
		String subject,
		String roomId,
		Role role,
		String tokenId,
		Instant expiresAt)
		implements RoomAccess {

	public static final String SESSION_ATTRIBUTE =
			ParticipationGrant.class.getName() + ".verified";

	@Override
	public boolean allows(String candidateRoomId) {
		return roomId.equals(candidateRoomId);
	}

	@Override
	public Optional<Role> roleFor(String hostCapability) {
		return hostCapability == null ? Optional.of(role) : Optional.empty();
	}

	@Override
	public Lease openLease(long currentEpochMillis, long currentMonotonicNanos) {
		return Lease.until(expiresAt.toEpochMilli(), currentEpochMillis, currentMonotonicNanos);
	}

	public ParticipantRoomKey participantRoomKey() {
		return new ParticipantRoomKey(roomId, subject);
	}

	@Override
	public String toString() {
		return "ParticipationGrant[role=%s, expiresAt=%s]".formatted(role, expiresAt);
	}

	public enum Role {
		@JsonProperty("host")
		HOST,
		@JsonProperty("participant")
		PARTICIPANT
	}
}

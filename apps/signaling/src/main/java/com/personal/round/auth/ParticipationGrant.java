package com.personal.round.auth;

import java.time.Instant;
import java.util.Objects;

public record ParticipationGrant(
		String subject,
		String studyId,
		String roomId,
		Role role,
		String tokenId,
		Instant issuedAt,
		Instant expiresAt)
		implements RoomAccess {

	public static final String SESSION_ATTRIBUTE =
			ParticipationGrant.class.getName() + ".verified";

	public ParticipationGrant {
		requireText(subject, "subject");
		requireText(studyId, "studyId");
		requireText(roomId, "roomId");
		Objects.requireNonNull(role, "role must not be null");
		requireText(tokenId, "tokenId");
		Objects.requireNonNull(issuedAt, "issuedAt must not be null");
		Objects.requireNonNull(expiresAt, "expiresAt must not be null");
	}

	@Override
	public boolean allows(String candidateRoomId) {
		return roomId.equals(candidateRoomId);
	}

	@Override
	public String toString() {
		return "ParticipationGrant[role=%s, issuedAt=%s, expiresAt=%s]"
				.formatted(role, issuedAt, expiresAt);
	}

	private static void requireText(String value, String field) {
		if (value == null || value.isBlank()) {
			throw new IllegalArgumentException(field + " must not be blank");
		}
	}

	public enum Role {
		HOST,
		PARTICIPANT
	}
}
